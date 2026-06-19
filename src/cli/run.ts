#!/usr/bin/env node
import { getHarnessRoot, rejectProjectRepoIdMix, parseChangeBudgetOverride, cmdRun, cmdReviewedRun, parseSource, runViewAction } from "./run-core.js";
import process from "node:process";
import { existsSync } from "node:fs";

import { join } from "node:path";

import { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { harnessVersion } from "../config/version.js";

import { StateConflictError, SourceModeError } from "../db/errors.js";

import { findTransientLeaseCause } from "../workspace/db-domain-lock.js";

import { renderRunShow, renderRunTimeline, renderRunArtifacts, RunViewError } from "../core/run-viewer.js";
import {
  formatItem,
  formatItemList,
  BacklogError,
  type BacklogItem,
  type BacklogStatus,
  type BacklogPriority,
} from "../core/backlog.js";
import {
  addBacklogItem,
  listBacklogItems,
  showBacklogItem,
  transitionBacklogItem,
  linkBacklogRun,
  resolveBacklogItemForRun,
  type BacklogDbContext,
} from "../core/backlog-db.js";

import { DEFAULT_MAX_ATTEMPTS } from "../core/rerun.js";

import { registerProjectCommands } from "./project.js";
import { registerPolicyCommands } from "./policy.js";
import { registerDbCommands } from "./db.js";
import { registerOnboardCommands } from "./onboard.js";
import { registerHitchCommands } from "./hitch.js";
import { registerCourseCommands } from "./course.js";
import { registerMcpCommands } from "../mcp/cli.js";
import { registerLockCommands } from "./lock.js";

import { registerOperationsCommands } from "./operations.js";
import { registerDashboardCommands } from "./dashboard.js";
import { registerReleaseCommands } from "./release.js";
import { registerRerunCommands } from "./rerun.js";
import { registerDiagnosticsCommands } from "./diagnostics.js";
import { registerReviewCommands } from "./review.js";
import { registerKnowledgeCommands } from "./knowledge.js";
import { registerWorkspaceCommands } from "./workspace.js";
import { registerPrCommands } from "./pr.js";

/**
 * Reject `--project` combined with `--repo-id` (Phase 6-1). In project mode
 * the repo and its id come from the profile; `--repo-id` would be silently
 * ignored, so a caller passing both is told explicitly instead. `--repo` is
 * still allowed in project mode as a path override.
 */
const program = new Command();
program.name("harness");
program.version(harnessVersion(), "-v, --version", "print the harness version");

const runCmd = program
  .command("run", { isDefault: true })
  .description("run the domain-coding workflow")
  // NOTE: plain options (not requiredOption) so the `run show` /
  // `run timeline` / `run artifacts` subcommands can be invoked without
  // them. The action below enforces presence for the bare `run` form.
  .option("--repo <path>", "target repo path")
  .option("--repo-id <id>", "repo identifier for policy resolution")
  .option("--project <id>", "project profile id (projects/<id>.yaml) — Phase 5")
  .option("--domain <domain>", "target domain (e.g. apps/user)")
  .option("--goal <text>", "task goal passed to Codex")
  .option(
    "--base-branch <name>",
    "base branch (default: the project profile's base_branch, or main)",
  )
  .option("--keep-worktree", "(no-op; worktree is always kept for review)", false)
  .option(
    "--with-knowledge",
    "inject docs/knowledge-context/<domain>.md into the codex prompt",
    false,
  )
  .option(
    "--knowledge-context <path>",
    "inject an explicit knowledge-context file (overrides --with-knowledge)",
  )
  .option(
    "--change-budget-max-deleted-lines <n>",
    "relax this run's deleted-line change budget ceiling",
  )
  .option(
    "--change-budget-max-total-changed-lines <n>",
    "relax this run's total changed-line budget ceiling",
  )
  .option(
    "--change-budget-max-deleted-files <n>",
    "relax this run's deleted-file change budget ceiling",
  )
  .option(
    "--change-budget-max-changed-files <n>",
    "relax this run's changed-file budget ceiling",
  )
  .option("--dry-run", "resolve policy and exit", false)
  .action(async (raw: Record<string, unknown>) => {
    rejectProjectRepoIdMix(raw, "harness run");
    // --project mode needs domain + goal; --repo-id mode also needs repo + repo-id.
    const required =
      raw.project !== undefined
        ? ["domain", "goal"]
        : ["repo", "repoId", "domain", "goal"];
    const missing = required.filter((k) => raw[k] === undefined);
    if (missing.length > 0) {
      const flags = missing
        .map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
        .join(", ");
      process.stderr.write(
        `harness error: 'harness run' requires ${flags}\n`,
      );
      process.exit(1);
    }
    const outcome = await cmdRun({
      ...(raw.repo !== undefined ? { repo: String(raw.repo) } : {}),
      ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
      ...(raw.project !== undefined ? { project: String(raw.project) } : {}),
      domain: String(raw.domain),
      goal: String(raw.goal),
      ...(raw.baseBranch !== undefined
        ? { baseBranch: String(raw.baseBranch) }
        : {}),
      keepWorktree: Boolean(raw.keepWorktree),
      dryRun: Boolean(raw.dryRun),
      withKnowledge: Boolean(raw.withKnowledge),
      ...(raw.knowledgeContext !== undefined
        ? { knowledgeContextPath: String(raw.knowledgeContext) }
        : {}),
      ...parseChangeBudgetOverride(raw),
    });
    if (outcome.failed) process.exit(1);
  });

runCmd
  .command("show")
  .description("one-screen summary of a run (status / files / commands / PR)")
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--source <which>",
    "where to read from: auto | db | files (Phase 10-4; default auto)",
    "auto",
  )
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const source = parseSource(raw.source);
    try {
      process.stdout.write(
        await renderRunShow(
          paths.runsDir,
          String(raw.runId),
          paths.backlogDir,
          paths.dbPath,
          source,
        ),
      );
    } catch (e) {
      if (e instanceof RunViewError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
runCmd
  .command("timeline")
  .description("render a run's events.jsonl as an ordered timeline")
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--source <which>",
    "where to read from: auto | db | files (Phase 10-4; default auto)",
    "auto",
  )
  .action(runViewAction(renderRunTimeline));
runCmd
  .command("artifacts")
  .description("list the artifact files in a run dir")
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--source <which>",
    "where to read from: auto | db | files (Phase 10-4; default auto)",
    "auto",
  )
  .action(runViewAction(renderRunArtifacts));

const workflowCmd = program
  .command("workflow")
  .description("multi-step workflows that sequence run / review / rerun");
workflowCmd
  .command("reviewed-run")
  .description(
    "run → review auto → review process → (rerun on changes_requested)*",
  )
  .option("--repo <path>", "target repo path")
  .option("--repo-id <id>", "repo identifier for policy resolution")
  .option("--project <id>", "project profile id (projects/<id>.yaml) — Phase 5")
  .requiredOption("--domain <domain>", "target domain (e.g. apps/user)")
  .requiredOption("--goal <text>", "task goal passed to Codex")
  .option(
    "--base-branch <name>",
    "base branch (default: the project profile's base_branch, or main)",
  )
  .option("--reviewer-name <name>", "reviewer identity for review auto")
  .option(
    "--max-attempts <n>",
    `max rerun attempts after the initial run (default ${DEFAULT_MAX_ATTEMPTS}); ` +
      `total runs may be initial + n`,
  )
  .option(
    "--stop-on-changes-requested",
    "stop at the first changes_requested instead of rerunning",
    false,
  )
  .option(
    "--no-auto-review",
    "run the coder only, then stop at needs_review for a human",
  )
  .option("--dry-run", "resolve policy and exit", false)
  .action(async (raw: Record<string, unknown>) => {
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
    rejectProjectRepoIdMix(raw, "workflow reviewed-run");
    if (
      raw.project === undefined &&
      (raw.repo === undefined || raw.repoId === undefined)
    ) {
      process.stderr.write(
        "harness error: 'workflow reviewed-run' requires --project, or --repo + --repo-id\n",
      );
      process.exit(1);
    }
    // commander maps --no-auto-review to raw.autoReview === false
    const outcome = await cmdReviewedRun({
      ...(raw.repo !== undefined ? { repo: String(raw.repo) } : {}),
      ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
      ...(raw.project !== undefined ? { project: String(raw.project) } : {}),
      domain: String(raw.domain),
      goal: String(raw.goal),
      ...(raw.baseBranch !== undefined
        ? { baseBranch: String(raw.baseBranch) }
        : {}),
      maxAttempts,
      ...(raw.reviewerName !== undefined
        ? { reviewerName: String(raw.reviewerName) }
        : {}),
      noAutoReview: raw.autoReview === false,
      stopOnChangesRequested: Boolean(raw.stopOnChangesRequested),
      dryRun: Boolean(raw.dryRun),
    });
    // exit 1 on any non-success terminal state.
    if (outcome.finalStatus !== "approved" && outcome.finalStatus !== "dry-run") {
      process.exit(1);
    }
  });

registerLockCommands(program, { getHarnessRoot });

registerReviewCommands(program, { getHarnessRoot });

registerPrCommands(program, { getHarnessRoot });

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

registerProjectCommands(program);
registerPolicyCommands(program);
registerDbCommands(program);
registerOnboardCommands(program);
registerHitchCommands(program, { getHarnessRoot });
registerCourseCommands(program, { getHarnessRoot });
registerMcpCommands(program, { getHarnessRoot });
registerReleaseCommands(program, { getHarnessRoot });

function rejectUnknownTopLevelCommandBeforeDefaultRun(
  rootCommand: Command,
  argv: string[],
): void {
  const firstArg = argv[2];
  if (firstArg === undefined || firstArg.startsWith("-")) return;
  const commandNames = new Set(
    rootCommand.commands.flatMap((command) => [
      command.name(),
      ...command.aliases(),
    ]),
  );
  commandNames.add("help");
  if (!commandNames.has(firstArg)) {
    rootCommand.error(`error: unknown command '${firstArg}'`, {
      code: "commander.unknownCommand",
    });
  }
}

rejectUnknownTopLevelCommandBeforeDefaultRun(program, process.argv);
program.parseAsync(process.argv).catch((e: unknown) => {
  const lease = findTransientLeaseCause(e);
  if (lease !== undefined) {
    process.stderr.write(
      `harness error: retryable domain lease contention ` +
        `(${lease.name}): ${lease.message}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`harness error: ${(e as Error).message}\n`);
  // user-fixable conditions (e.g. legacy-file rows pending migration) →
  // exit 1 so scripts can branch on it cleanly. Truly unexpected errors
  // stay at exit 2.
  const name = (e as Error)?.name;
  if (name === "LegacyRowsFoundError" || name === "MaintenanceLockBusyError") {
    process.exit(1);
  }
  process.exit(2);
});

// silence unused suppress
void runCmd;
