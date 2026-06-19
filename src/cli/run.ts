#!/usr/bin/env node
import process from "node:process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { harnessVersion } from "../config/version.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import {
  runDomainCoding,
  type RunChangeBudgetOverride,
} from "../core/workflow-runner.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { codexBinaryVersion } from "../codex/codex-version.js";
import { StateConflictError, SourceModeError } from "../db/errors.js";
import { runMigrations } from "../db/migrations.js";

import { findTransientLeaseCause } from "../workspace/db-domain-lock.js";

import { listAgentWorkspaces } from "../workspace/agent-workspace.js";

import { openManagedDb } from "../db/managed-connection.js";

import { createPullRequest, PrGateError } from "../core/pr-creator.js";
import { createGhPrPublisher } from "../core/gh-pr-publisher.js";
import { createGhCopilotReviewer } from "../core/copilot-reviewer-gh.js";
import { runCopilotReview } from "../core/copilot-review-run.js";
import {
  startOperation,
  succeedOperation,
  failOperation,
} from "../db/repositories/operations.js";
import { randomUUID } from "node:crypto";
import {
  renderRunShow,
  renderRunTimeline,
  renderRunArtifacts,
  type RunViewSource,
  RunViewError,
} from "../core/run-viewer.js";
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

import {
  runReviewedRunWorkflow,
  ReviewWorkflowUnsupportedError,
  assertReviewedRunWorkflowSupported,
} from "../core/reviewed-run-workflow.js";

import { buildKnowledgeContextFromDb, KnowledgeContextError, domainSlug } from "../core/knowledge-context.js";

import { registerProjectCommands } from "./project.js";
import { registerPolicyCommands } from "./policy.js";
import { registerDbCommands } from "./db.js";
import { registerOnboardCommands } from "./onboard.js";
import { registerHitchCommands } from "./hitch.js";
import { registerCourseCommands } from "./course.js";
import { registerMcpCommands } from "../mcp/cli.js";
import { registerLockCommands } from "./lock.js";
import { registerInboxCommands } from "./inbox.js";
import { registerOperationsCommands } from "./operations.js";
import { registerDashboardCommands } from "./dashboard.js";
import { registerReleaseCommands } from "./release.js";
import { registerRerunCommands } from "./rerun.js";
import { registerDiagnosticsCommands } from "./diagnostics.js";
import { registerReviewCommands } from "./review.js";
import { registerKnowledgeCommands } from "./knowledge.js";
import { registerWorkspaceCommands } from "./workspace.js";

import {
  prepareProjectRun,
  type PreparedProjectRun,
} from "../project/run-project.js";
import { ProjectError } from "../project/errors.js";

function getHarnessRoot(): string {
  return process.env.HARNESS_ROOT ?? process.cwd();
}

/**
 * Reject `--project` combined with `--repo-id` (Phase 6-1). In project mode
 * the repo and its id come from the profile; `--repo-id` would be silently
 * ignored, so a caller passing both is told explicitly instead. `--repo` is
 * still allowed in project mode as a path override.
 */
function rejectProjectRepoIdMix(
  raw: Record<string, unknown>,
  command: string,
): void {
  if (raw.project !== undefined && raw.repoId !== undefined) {
    process.stderr.write(
      `harness error: '${command}' cannot combine --project with --repo-id ` +
        `(--project resolves the repo from the profile; --repo is the only override)\n`,
    );
    process.exit(1);
  }
}

interface RunOpts {
  /** repo path; required in --repo-id mode, an optional override in --project mode */
  repo?: string;
  repoId?: string;
  /** project id — selects the profile-driven run path (Phase 5-7) */
  project?: string;
  domain: string;
  goal: string;
  /** explicit --base-branch; when absent the profile (or "main") decides */
  baseBranch?: string;
  keepWorktree?: boolean;
  dryRun?: boolean;
  withKnowledge?: boolean;
  knowledgeContextPath?: string;
  changeBudgetOverride?: RunChangeBudgetOverride;
}

interface RunOutcome {
  runId: string;
  status: string;
  failed: boolean;
}

function parseChangeBudgetOverride(
  raw: Record<string, unknown>,
): { changeBudgetOverride?: RunChangeBudgetOverride } {
  const override: RunChangeBudgetOverride = {};
  if (raw.changeBudgetMaxDeletedLines !== undefined) {
    override.maxDeletedLines = parsePositiveInt(
      raw.changeBudgetMaxDeletedLines,
      "--change-budget-max-deleted-lines",
    );
  }
  if (raw.changeBudgetMaxTotalChangedLines !== undefined) {
    override.maxTotalChangedLines = parsePositiveInt(
      raw.changeBudgetMaxTotalChangedLines,
      "--change-budget-max-total-changed-lines",
    );
  }
  if (raw.changeBudgetMaxDeletedFiles !== undefined) {
    override.maxDeletedFiles = parsePositiveInt(
      raw.changeBudgetMaxDeletedFiles,
      "--change-budget-max-deleted-files",
    );
  }
  if (raw.changeBudgetMaxChangedFiles !== undefined) {
    override.maxChangedFiles = parsePositiveInt(
      raw.changeBudgetMaxChangedFiles,
      "--change-budget-max-changed-files",
    );
  }
  return Object.keys(override).length > 0 ? { changeBudgetOverride: override } : {};
}

async function cmdRun(o: RunOpts): Promise<RunOutcome> {
  const harnessRoot = getHarnessRoot();
  const paths = harnessPaths(harnessRoot);

  let prepared: PreparedProjectRun | undefined;
  let resolved;
  let repoPath: string;
  let repoId: string;
  if (o.project !== undefined) {
    try {
      prepared = await prepareProjectRun({
        harnessRoot,
        projectId: o.project,
        domain: o.domain,
        ...(o.repo !== undefined ? { repoOverride: o.repo } : {}),
      });
    } catch (e) {
      if (e instanceof ProjectError) {
        process.stderr.write(`harness error: ${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
    resolved = prepared.resolvedPolicy;
    repoPath = prepared.repoPath;
    repoId = prepared.repoId;
  } else {
    const global = await loadGlobalPolicy(paths.globalPolicyPath);
    const repo = await loadRepoPolicy(paths.repoPolicyPath(String(o.repoId)));
    resolved = resolvePolicy(global, repo, o.domain);
    repoPath = String(o.repo);
    repoId = String(o.repoId);
  }

  // explicit --base-branch wins; otherwise the project profile's base
  // branch (or "main" in --repo-id mode).
  const baseBranch = o.baseBranch ?? prepared?.baseBranch ?? "main";

  if (o.dryRun) {
    process.stdout.write(
      `resolved policy for ${resolved.domain}:\n${JSON.stringify(resolved, null, 2)}\n`,
    );
    return { runId: "", status: "dry-run", failed: false };
  }

  // resolve promoted-knowledge context (Phase 3-4), if requested.
  let knowledgeContext:
    | { path: string; text: string; revisionIds?: number[] }
    | undefined;
  const explicitCtx = o.knowledgeContextPath;
  if (explicitCtx !== undefined) {
    if (!existsSync(explicitCtx)) {
      process.stderr.write(
        `harness error: --knowledge-context file not found: ${explicitCtx}\n`,
      );
      process.exit(1);
    }
    knowledgeContext = {
      path: explicitCtx,
      text: await readFile(explicitCtx, "utf8"),
    };
  } else if (o.withKnowledge) {
    const ctxPath = join(
      harnessRoot,
      "docs",
      "knowledge-context",
      `${domainSlug(o.domain)}.md`,
    );
    if (prepared !== undefined && existsSync(paths.dbPath)) {
      try {
        const handle = openManagedDb({ dbPath: paths.dbPath });
        try {
          runMigrations(handle.db);
          const built = await buildKnowledgeContextFromDb({
            db: handle.db,
            outDir: join(harnessRoot, "docs", "knowledge-context"),
            domain: o.domain,
            projectId: prepared.project.projectId,
            repoId,
          });
          knowledgeContext = {
            path: built.outPath,
            text: await readFile(built.outPath, "utf8"),
            ...(built.knowledgeRevisionIds !== undefined
              ? { revisionIds: built.knowledgeRevisionIds }
              : {}),
          };
        } finally {
          handle.close();
        }
      } catch (e) {
        if (!(e instanceof KnowledgeContextError)) throw e;
        process.stderr.write(
          `warning: DB knowledge context unavailable: ${e.message}; falling back to ${ctxPath}\n`,
        );
      }
    }
    if (knowledgeContext === undefined && !existsSync(ctxPath)) {
      process.stderr.write(
        `harness error: --with-knowledge: ${ctxPath} not found; ` +
          `run 'harness knowledge build-context --domain ${o.domain}' first\n`,
      );
      process.exit(1);
    }
    if (knowledgeContext === undefined) {
      knowledgeContext = {
        path: ctxPath,
        text: await readFile(ctxPath, "utf8"),
      };
    }
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
  const resolvedCodexBinaryVersion = codexBinaryVersion(codexBin);
  const runner = createCodexCliRunner({
    codexBin,
    sandbox: resolved.codex.sandbox,
    ...(resolved.codex.approval !== undefined
      ? { approvalPolicy: resolved.codex.approval }
      : {}),
    ...(resolved.codex.timeoutMs !== undefined
      ? { timeoutMs: resolved.codex.timeoutMs }
      : {}),
  });

  const result = await runDomainCoding({
    harnessRoot,
    repoPath,
    repoId,
    domain: o.domain,
    goal: o.goal,
    baseBranch,
    ...(o.keepWorktree !== undefined ? { keepWorktree: o.keepWorktree } : {}),
    codexRunner: runner,
    codexBinaryVersion: resolvedCodexBinaryVersion,
    ...(knowledgeContext !== undefined ? { knowledgeContext } : {}),
    ...(o.changeBudgetOverride !== undefined
      ? { changeBudgetOverride: o.changeBudgetOverride }
      : {}),
    ...(prepared !== undefined
      ? {
          compiledPolicy: prepared.compiledPolicy,
          reviewRuleResolution: prepared.reviewRuleResolution,
          project: prepared.project,
          ...(prepared.projectContextPacks !== undefined
            ? {
                projectContextPacks: {
                  promptText: prepared.projectContextPacks.promptText,
                  manifestYaml: prepared.projectContextPacks.manifestYaml,
                },
              }
            : {}),
        }
      : {}),
  });
  const cmdTotal = result.commandResults.length;
  const cmdOk = result.commandResults.filter(
    (c) => c.exitCode === 0 && !c.timedOut,
  ).length;
  process.stdout.write(
    `run=${result.runId} status=${result.status} safetyStatus=${result.safetyStatus} ignoredUntrackedCount=${result.ignoredUntrackedCount} secretSuspectCount=${result.secretSuspectCount} commands=${cmdOk}/${cmdTotal}\n`,
  );
  const failed = result.status.startsWith("failed-");
  return { runId: result.runId, status: result.status, failed };
}

interface ReviewedRunOpts {
  repo?: string;
  repoId?: string;
  project?: string;
  domain: string;
  goal: string;
  baseBranch?: string;
  reviewerName?: string;
  maxAttempts: number;
  noAutoReview?: boolean;
  stopOnChangesRequested?: boolean;
  dryRun?: boolean;
}

interface ReviewedRunOutcome {
  rootRunId: string;
  finalStatus: string;
}

async function cmdReviewedRun(o: ReviewedRunOpts): Promise<ReviewedRunOutcome> {
  const harnessRoot = getHarnessRoot();
  const paths = harnessPaths(harnessRoot);

  let prepared: PreparedProjectRun | undefined;
  let resolved;
  let repoPath: string;
  let repoId: string;
  if (o.project !== undefined) {
    try {
      prepared = await prepareProjectRun({
        harnessRoot,
        projectId: o.project,
        domain: o.domain,
        ...(o.repo !== undefined ? { repoOverride: o.repo } : {}),
      });
    } catch (e) {
      if (e instanceof ProjectError) {
        process.stderr.write(`harness error: ${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
    resolved = prepared.resolvedPolicy;
    repoPath = prepared.repoPath;
    repoId = prepared.repoId;
  } else {
    const global = await loadGlobalPolicy(paths.globalPolicyPath);
    const repo = await loadRepoPolicy(paths.repoPolicyPath(String(o.repoId)));
    resolved = resolvePolicy(global, repo, o.domain);
    repoPath = String(o.repo);
    repoId = String(o.repoId);
  }

  const baseBranch = o.baseBranch ?? prepared?.baseBranch ?? "main";

  try {
    assertReviewedRunWorkflowSupported(prepared?.reviewRuleResolution);
  } catch (e) {
    if (e instanceof ReviewWorkflowUnsupportedError) {
      process.stderr.write(`harness error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  if (o.dryRun) {
    process.stdout.write(
      `reviewed-run workflow for ${resolved.domain} (maxAttempts=${o.maxAttempts}):\n` +
        `${JSON.stringify(resolved, null, 2)}\n`,
    );
    return { rootRunId: "", finalStatus: "dry-run" };
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
  const resolvedCodexBinaryVersion = codexBinaryVersion(codexBin);
  const coderRunner = createCodexCliRunner({
    codexBin,
    sandbox: resolved.codex.sandbox,
    ...(resolved.codex.approval !== undefined
      ? { approvalPolicy: resolved.codex.approval }
      : {}),
    ...(resolved.codex.timeoutMs !== undefined
      ? { timeoutMs: resolved.codex.timeoutMs }
      : {}),
  });
  // the reviewer agent always runs in a separate read-only sandbox.
  const reviewerRunner = createCodexCliRunner({
    codexBin,
    sandbox: "read-only",
  });

  let result: Awaited<ReturnType<typeof runReviewedRunWorkflow>>;
  try {
    result = await runReviewedRunWorkflow({
      harnessRoot,
      runsDir: paths.runsDir,
      locksDir: paths.locksDir,
      repoPath,
      repoId,
      domain: o.domain,
      goal: o.goal,
      baseBranch,
      coderRunner,
      reviewerRunner,
      coderCodexBinaryVersion: resolvedCodexBinaryVersion,
      maxAttempts: o.maxAttempts,
      ...(o.reviewerName !== undefined ? { reviewerName: o.reviewerName } : {}),
      ...(o.noAutoReview !== undefined ? { noAutoReview: o.noAutoReview } : {}),
      ...(o.stopOnChangesRequested !== undefined
        ? { stopOnChangesRequested: o.stopOnChangesRequested }
        : {}),
      ...(prepared !== undefined
        ? {
            projectRun: {
              compiledPolicy: prepared.compiledPolicy,
              reviewRuleResolution: prepared.reviewRuleResolution,
              project: prepared.project,
              ...(prepared.projectContextPacks !== undefined
                ? {
                    projectContextPacks: {
                      promptText: prepared.projectContextPacks.promptText,
                      manifestYaml:
                        prepared.projectContextPacks.manifestYaml,
                    },
                  }
                : {}),
            },
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof ReviewWorkflowUnsupportedError) {
      process.stderr.write(`harness error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  process.stdout.write(
    `workflow=reviewed-run rootRunId=${result.rootRunId} ` +
      `attempts=${result.attempts.length} finalStatus=${result.finalStatus}\n`,
  );
  for (const a of result.attempts) {
    process.stdout.write(
      `  attempt ${a.attempt}: ${a.runId} ${a.status}` +
        `${a.reviewer ? ` (reviewer=${a.reviewer})` : ""}\n`,
    );
  }
  return { rootRunId: result.rootRunId, finalStatus: result.finalStatus };
}

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

function parseSource(raw: unknown): RunViewSource {
  const s = raw === undefined ? "auto" : String(raw);
  if (s !== "auto" && s !== "db" && s !== "files") {
    process.stderr.write(
      `harness error: --source must be one of auto | db | files (got ${JSON.stringify(s)})\n`,
    );
    process.exit(1);
  }
  return s;
}

function runViewAction(
  render: (
    runsDir: string,
    runId: string,
    dbPath?: string,
    source?: RunViewSource,
  ) => Promise<string>,
) {
  return async (raw: Record<string, unknown>): Promise<void> => {
    const paths = harnessPaths(getHarnessRoot());
    const source = parseSource(raw.source);
    try {
      process.stdout.write(
        await render(paths.runsDir, String(raw.runId), paths.dbPath, source),
      );
    } catch (e) {
      if (e instanceof RunViewError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  };
}
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

const prCmd = program
  .command("pr")
  .description("GitHub pull request integration");
prCmd
  .command("create")
  .description("turn an approved run into a draft GitHub PR")
  .requiredOption("--run-id <id>", "target run identifier (must be approved)")
  .option("--base <branch>", "PR base branch", "main")
  .option("--title <text>", "PR title (default derives from runId + domain)")
  .option(
    "--no-draft",
    "create a ready PR instead of a draft (default: draft)",
  )
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const ghBin = process.env.HARNESS_GH_BIN ?? "gh";
    try {
      const r = await createPullRequest({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        dbPath: paths.dbPath,
        runId: String(raw.runId),
        base: String(raw.base),
        // commander maps --no-draft to raw.draft === false
        draft: raw.draft !== false,
        publisher: createGhPrPublisher(ghBin),
        ...(raw.title !== undefined ? { title: String(raw.title) } : {}),
      });
      process.stdout.write(
        `run=${r.runId} pr=#${r.prNumber} head=${r.head}\n${r.prUrl}\n`,
      );
    } catch (e) {
      if (
        e instanceof PrGateError ||
        e instanceof StateConflictError ||
        e instanceof SourceModeError
      ) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

/**
 * Parse a non-negative *integer* seconds CLI arg; exit 2 on anything invalid.
 * Non-finite / negative / non-integer (decimal) all fail — seconds are whole.
 * 0 is allowed (= observe once, no wait budget).
 */
function parseNonNegativeIntSeconds(raw: unknown, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    process.stderr.write(`harness error: invalid ${flag}: ${String(raw)}\n`);
    process.exit(2);
  }
  return n;
}

/**
 * Parse a positive (> 0) *integer* seconds CLI arg; exit 2 on anything invalid.
 * Used for `--poll-interval` so we never poll GitHub at 0 / sub-second / NaN.
 */
function parsePositiveIntSeconds(raw: unknown, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`harness error: invalid ${flag}: ${String(raw)}\n`);
    process.exit(2);
  }
  return n;
}

/** Parse a positive integer CLI arg; exit 2 on anything invalid (incl. decimals). */
function parsePositiveInt(raw: unknown, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`harness error: invalid ${flag}: ${String(raw)}\n`);
    process.exit(2);
  }
  return n;
}

prCmd
  .command("request-review")
  .description(
    "best-effort: request a Copilot review on a PR (retry-then-skip, non-gating)",
  )
  .argument("<pr-number>", "GitHub PR number")
  .requiredOption("--repo <path>", "path to the target git repo")
  .option("--timeout <seconds>", "total poll timeout in seconds", "300")
  .option("--poll-interval <seconds>", "seconds between polls", "15")
  .option("--request-attempts <n>", "request retry attempts", "3")
  .option("--json", "emit JSON", false)
  .action(async (prArg: string, raw: Record<string, unknown>) => {
    const prNumber = Number(prArg);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      process.stderr.write(`harness error: invalid PR number: ${prArg}\n`);
      process.exit(2);
    }
    const ghBin = process.env.HARNESS_GH_BIN ?? "gh";
    const repoDir = String(raw.repo);
    // Validate numeric args BEFORE the seconds→ms conversion. Seconds must be
    // whole integers; a NaN/decimal deadline (e.g. `--timeout foo` / `1.5`)
    // would otherwise never trip the skip check or be silently floored.
    //   --timeout         : non-negative integer (0 = observe once, no budget)
    //   --poll-interval   : positive integer (never poll GitHub at 0 / sub-second)
    //   --request-attempts: positive integer (no silent floor of decimals)
    const timeoutSec = parseNonNegativeIntSeconds(raw.timeout, "--timeout");
    const pollIntervalSec = parsePositiveIntSeconds(
      raw.pollInterval,
      "--poll-interval",
    );
    const requestAttempts = parsePositiveInt(
      raw.requestAttempts,
      "--request-attempts",
    );
    const pollTimeoutMs = timeoutSec * 1000;
    const pollIntervalMs = pollIntervalSec * 1000;
    // Node's setTimeout truncates a delay > the signed 32-bit max to 1ms (a
    // busy-loop). Reject such a (seconds→ms) value explicitly instead of letting
    // it silently round down — fail-closed with a clear message.
    const MAX_TIMER_MS = 2_147_483_647;
    if (pollTimeoutMs > MAX_TIMER_MS) {
      process.stderr.write(
        `harness error: --timeout too large: ${String(raw.timeout)}s exceeds the ` +
          `${MAX_TIMER_MS}ms timer limit\n`,
      );
      process.exit(2);
    }
    if (pollIntervalMs > MAX_TIMER_MS) {
      process.stderr.write(
        `harness error: --poll-interval too large: ${String(raw.pollInterval)}s ` +
          `exceeds the ${MAX_TIMER_MS}ms timer limit\n`,
      );
      process.exit(2);
    }
    const config = {
      pollTimeoutMs,
      pollIntervalMs,
      requestAttempts,
    };
    // Capture the start before the review runs so the audit `started_at`
    // reflects when the work began (the DB write happens after it completes).
    const startedAt = new Date();
    const outcome = await runCopilotReview({
      reviewer: createGhCopilotReviewer(repoDir, ghBin),
      prNumber,
      config,
    });

    // audit (best-effort: a recording failure must not change the exit code).
    try {
      const paths = harnessPaths(getHarnessRoot());
      const dbHandle = openManagedDb({ dbPath: paths.dbPath });
      try {
        runMigrations(dbHandle.db);
        const operationId = `op-${randomUUID()}`;
        startOperation(dbHandle.db, {
          operationId,
          operationType: "copilot-review",
          targetType: "pr",
          targetId: String(prNumber),
          actor: "cli",
          dryRun: false,
          input: { prNumber, config },
          now: startedAt,
        });
        if (outcome.status === "failed") {
          failOperation(
            dbHandle.db,
            operationId,
            "copilot_review_failed",
            outcome.detail,
          );
        } else {
          // reviewed | skipped are terminal best-effort outcomes (the operation
          // itself completed; the result JSON's `status` distinguishes them).
          // `pending` would be wrong — it means "deferred to an external worker"
          // and the doctor would flag a timed-out skip as a stale pending op.
          succeedOperation(dbHandle.db, operationId, outcome);
        }
      } finally {
        dbHandle.close();
      }
    } catch (e) {
      process.stderr.write(
        `warning: could not record copilot-review audit: ${(e as Error).message}\n`,
      );
    }

    if (raw.json === true) {
      process.stdout.write(`${JSON.stringify({ prNumber, ...outcome })}\n`);
    } else {
      process.stdout.write(
        `pr=#${prNumber} copilot-review=${outcome.status} (${outcome.detail})\n`,
      );
    }
    // reviewed / skipped (a timeout is a normal best-effort result) → 0;
    // failed (the request itself could not be established) → non-0 so an
    // operator notices. orchestrate ignores this exit (non-gating).
    process.exit(outcome.status === "failed" ? 1 : 0);
  });

registerInboxCommands(program, { getHarnessRoot });

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
