import process from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { addBacklogItem, listBacklogItems, showBacklogItem, transitionBacklogItem, linkBacklogRun, resolveBacklogItemForRun, type BacklogDbContext } from "../core/backlog-db.js";
import { formatItem, formatItemList, BacklogError, type BacklogItem, type BacklogStatus, type BacklogPriority } from "../core/backlog.js";
import { DEFAULT_MAX_ATTEMPTS } from "../core/rerun.js";
import { StateConflictError, SourceModeError } from "../db/errors.js";
import { registerDashboardCommands } from "./dashboard.js";
import { registerDiagnosticsCommands } from "./diagnostics.js";
import { registerKnowledgeCommands } from "./knowledge.js";
import { registerOperationsCommands } from "./operations.js";
import { registerRerunCommands } from "./rerun.js";
import { cmdRun, cmdReviewedRun } from "./run-core.js";
import { registerWorkspaceCommands } from "./workspace.js";

/**
 * `harness backlog`（personal backlog・queue tasks と run へのリンク）を run.ts から
 * behavior-zero で抽出。group 内 helper(backlogError/backlogDbContext/warnBacklogExport/
 * backlogListJson)同梱。`backlog run` が使う run 駆動(cmdRun/cmdReviewedRun)は run-core.ts
 * から import。getHarnessRoot は opts 経由で遅延解決。
 */
export function registerBacklogCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const getHarnessRoot = opts.getHarnessRoot;
  const backlogCmd = program
    .command("backlog")
    .description("personal backlog — queue tasks and link them to runs");
  function backlogError(e: unknown): never {
    if (
      e instanceof BacklogError ||
      e instanceof StateConflictError ||
      e instanceof SourceModeError
    ) {
      process.stderr.write(`harness error: ${(e as Error).message}\n`);
      process.exit(1);
    }
    throw e;
  }

  /** DB-first backlog context — `backlog/` dir + the harness DB path. */
  function backlogDbContext(): BacklogDbContext {
    const paths = harnessPaths(getHarnessRoot());
    return { backlogDir: paths.backlogDir, dbPath: paths.dbPath };
  }

  /**
   * Surface a backlog file-export failure as a strong stderr warning. The DB
   * write already succeeded (it is canonical), so the command still exits 0
   * — the warning tells the operator the exported YAML is stale until a
   * re-export reconciles it.
   */
  function warnBacklogExport(exportWarning: string | undefined): void {
    if (exportWarning !== undefined) {
      process.stderr.write(`warning: ${exportWarning}\n`);
    }
  }

  interface BacklogListJsonItem {
    itemId: string;
    domain: string;
    title: string;
    goal: string;
    status: BacklogStatus;
    priority: BacklogPriority;
    tags: string[];
    createdAt: string;
    linkedRuns: string[];
    projectId: string | null;
  }

  interface BacklogListJson {
    items: BacklogListJsonItem[];
    byStatus: Record<string, number>;
  }

  function backlogListJson(items: BacklogItem[]): BacklogListJson {
    const byStatus: Record<string, number> = {};
    for (const item of items) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }
    return {
      items: items.map((item) => ({
        itemId: item.id,
        domain: item.domain,
        title: item.title,
        goal: item.goal,
        status: item.status,
        priority: item.priority,
        tags: item.tags,
        createdAt: item.createdAt,
        linkedRuns: item.linkedRuns,
        projectId: item.projectId ?? null,
      })),
      byStatus,
    };
  }

  backlogCmd
    .command("add")
    .description("add a backlog item")
    .requiredOption("--title <text>", "short title")
    .requiredOption("--domain <domain>", "target domain")
    .requiredOption("--goal <text>", "task goal")
    .option("--priority <level>", "high | medium | low", "medium")
    .option("--tags <list>", "comma-separated tags")
    .option("--project <id>", "project id this item belongs to (Phase 5)")
    .action(async (raw: Record<string, unknown>) => {
      try {
        const { item, exportWarning } = await addBacklogItem(
          backlogDbContext(),
          {
            title: String(raw.title),
            domain: String(raw.domain),
            goal: String(raw.goal),
            priority: String(raw.priority) as BacklogPriority,
            ...(raw.project !== undefined
              ? { projectId: String(raw.project) }
              : {}),
            ...(raw.tags !== undefined
              ? {
                  tags: String(raw.tags)
                    .split(",")
                    .map((t) => t.trim())
                    .filter((t) => t !== ""),
                }
              : {}),
          },
        );
        warnBacklogExport(exportWarning);
        process.stdout.write(`added ${item.id} [${item.status}]\n`);
      } catch (e) {
        backlogError(e);
      }
    });
  backlogCmd
    .command("list")
    .description("list backlog items")
    .option("--status <status>", "open | doing | done | deferred")
    .option("--project <id>", "scope to a project (DB-backed, Phase 6)")
    .option("--repo-id <id>", "scope to a repo (DB-backed, Phase 6)")
    .option("--json", "emit JSON instead of text")
    .action(async (raw: Record<string, unknown>) => {
      const status =
        raw.status !== undefined
          ? (String(raw.status) as BacklogStatus)
          : undefined;
      if (
        status !== undefined &&
        !["open", "doing", "done", "deferred"].includes(status)
      ) {
        process.stderr.write(
          `harness error: --status must be open|doing|done|deferred\n`,
        );
        process.exit(1);
      }
      const items = await listBacklogItems(backlogDbContext(), {
        ...(status !== undefined ? { status } : {}),
        ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
        ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
      });
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(backlogListJson(items), null, 2)}\n`
          : formatItemList(items),
      );
    });
  backlogCmd
    .command("show")
    .description("show a backlog item")
    .requiredOption("--item-id <id>", "backlog item id")
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(getHarnessRoot());
      try {
        const item = await showBacklogItem(backlogDbContext(), String(raw.itemId));
        // a linked run whose run dir is gone (cleanup --scope run) is marked
        const missingRuns = new Set(
          item.linkedRuns.filter(
            (r) => !existsSync(join(paths.runsDir, r)),
          ),
        );
        process.stdout.write(formatItem(item, { missingRuns }));
      } catch (e) {
        backlogError(e);
      }
    });
  backlogCmd
    .command("done")
    .description("mark a backlog item done")
    .requiredOption("--item-id <id>", "backlog item id")
    .action(async (raw: Record<string, unknown>) => {
      try {
        const { item, exportWarning } = await transitionBacklogItem(
          backlogDbContext(),
          String(raw.itemId),
          "done",
        );
        warnBacklogExport(exportWarning);
        process.stdout.write(`${item.id} → done\n`);
      } catch (e) {
        backlogError(e);
      }
    });
  backlogCmd
    .command("defer")
    .description("defer a backlog item")
    .requiredOption("--item-id <id>", "backlog item id")
    .action(async (raw: Record<string, unknown>) => {
      try {
        const { item, exportWarning } = await transitionBacklogItem(
          backlogDbContext(),
          String(raw.itemId),
          "deferred",
        );
        warnBacklogExport(exportWarning);
        process.stdout.write(`${item.id} → deferred\n`);
      } catch (e) {
        backlogError(e);
      }
    });
  backlogCmd
    .command("run")
    .description("launch a run for a backlog item and link it")
    .requiredOption("--item-id <id>", "backlog item id")
    .option("--repo <path>", "target repo path (required unless the item has a project)")
    .option("--repo-id <id>", "repo id (required unless the item has a project)")
    .option(
      "--base-branch <name>",
      "base branch (default: the project profile's base_branch, or main)",
    )
    .option(
      "--workflow <kind>",
      "run | reviewed-run (default reviewed-run)",
      "reviewed-run",
    )
    .option("--max-attempts <n>", "reviewed-run rerun cap")
    .action(async (raw: Record<string, unknown>) => {
      let item;
      try {
        // resolve the canonical item up-front: a db-first item comes from the
        // DB row, not a possibly-stale exported YAML, and an unknown
        // source_mode fails here rather than after a run has been launched.
        item = await resolveBacklogItemForRun(
          backlogDbContext(),
          String(raw.itemId),
        );
      } catch (e) {
        backlogError(e);
      }
      const kind = String(raw.workflow);
      if (kind !== "run" && kind !== "reviewed-run") {
        process.stderr.write(
          `harness error: --workflow must be 'run' or 'reviewed-run'\n`,
        );
        process.exit(1);
      }
      // the run mode is decided by the item, not a flag (Phase 6-1): an item
      // with a projectId runs in --project mode; otherwise --repo + --repo-id
      // are required. --base-branch is only forwarded when actually given, so
      // an absent flag never becomes the string "undefined".
      let modeOpts: { project?: string; repo?: string; repoId?: string };
      if (item.projectId !== undefined) {
        if (raw.repoId !== undefined) {
          process.stderr.write(
            `harness error: backlog item ${item.id} has project ` +
              `"${item.projectId}"; --repo-id is not used ` +
              `(pass --repo only to override the path)\n`,
          );
          process.exit(1);
        }
        modeOpts = {
          project: item.projectId,
          ...(raw.repo !== undefined ? { repo: String(raw.repo) } : {}),
        };
      } else {
        if (raw.repo === undefined || raw.repoId === undefined) {
          process.stderr.write(
            `harness error: backlog item ${item.id} has no project; ` +
              `'backlog run' requires --repo + --repo-id\n`,
          );
          process.exit(1);
        }
        modeOpts = { repo: String(raw.repo), repoId: String(raw.repoId) };
      }
      const baseBranchOpt =
        raw.baseBranch !== undefined
          ? { baseBranch: String(raw.baseBranch) }
          : {};

      let runId: string;
      let failed = false;
      if (kind === "run") {
        const outcome = await cmdRun({
          ...modeOpts,
          ...baseBranchOpt,
          domain: item.domain,
          goal: item.goal,
          keepWorktree: false,
          dryRun: false,
          withKnowledge: false,
        });
        runId = outcome.runId;
        failed = outcome.failed;
      } else {
        let maxAttempts = DEFAULT_MAX_ATTEMPTS;
        if (raw.maxAttempts !== undefined) {
          const n = Number(raw.maxAttempts);
          if (!Number.isInteger(n) || n < 1) {
            process.stderr.write(
              `harness error: --max-attempts must be a positive integer (got ${JSON.stringify(String(raw.maxAttempts))})\n`,
            );
            process.exit(1);
          }
          maxAttempts = n;
        }
        const outcome = await cmdReviewedRun({
          ...modeOpts,
          ...baseBranchOpt,
          domain: item.domain,
          goal: item.goal,
          maxAttempts,
        });
        runId = outcome.rootRunId;
        failed = outcome.finalStatus !== "approved";
      }
      if (runId !== "") {
        try {
          const { item: updated, exportWarning } = await linkBacklogRun(
            backlogDbContext(),
            item.id,
            runId,
          );
          warnBacklogExport(exportWarning);
          process.stdout.write(
            `backlog ${item.id} → doing, linked run ${runId} ` +
              `(${updated.linkedRuns.length} total)\n`,
          );
        } catch (e) {
          backlogError(e);
        }
      }
      if (failed) process.exit(1);
    });

  registerDashboardCommands(program, { getHarnessRoot });

  registerOperationsCommands(program, { getHarnessRoot });

  registerDiagnosticsCommands(program, { getHarnessRoot });

  registerRerunCommands(program, { getHarnessRoot });

  registerKnowledgeCommands(program, { getHarnessRoot });

  registerWorkspaceCommands(program, { getHarnessRoot });
}
