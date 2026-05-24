#!/usr/bin/env node
import process from "node:process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { runDomainCoding } from "../core/workflow-runner.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { StateConflictError, SourceModeError } from "../db/errors.js";
import {
  DomainLockBusyError,
  listActiveDomainLocks,
  releaseDomainLockByDomain,
} from "../workspace/db-domain-lock.js";
import {
  ReviewerRepository,
  DuplicateReviewerError,
  UnknownReviewerError,
} from "../db/repositories/reviewers.js";
import {
  ReviewProposalRepository,
  type ReviewProposalRow,
} from "../db/repositories/review-proposals.js";
import {
  OverrideReasonRequiredError,
  UnauthorizedOverrideError,
} from "../db/repositories/review-overrides.js";
import { warnLegacyFileLocks } from "../workspace/legacy-file-lock-warning.js";
import { openManagedDb } from "../db/managed-connection.js";
import {
  processReviewDecision,
  ReviewGateError,
} from "../core/review-processor.js";
import { cleanupRun, CleanupGateError } from "../core/cleanup.js";
import {
  listReviews,
  formatTable,
  formatJson,
} from "../core/review-lister.js";
import { createPullRequest, PrGateError } from "../core/pr-creator.js";
import { createGhPrPublisher } from "../core/gh-pr-publisher.js";
import {
  renderRunShow,
  renderRunTimeline,
  renderRunArtifacts,
  type RunViewSource,
  RunViewError,
} from "../core/run-viewer.js";
import {
  buildInbox,
  formatInbox,
  formatInboxJson,
  type InboxSection,
} from "../core/inbox.js";
import {
  listItems,
  showItem,
  formatItem,
  formatItemList,
  BacklogError,
  type BacklogStatus,
  type BacklogPriority,
} from "../core/backlog.js";
import {
  addBacklogItem,
  transitionBacklogItem,
  linkBacklogRun,
  resolveBacklogItemForRun,
  type BacklogDbContext,
} from "../core/backlog-db.js";
import {
  checkMaintenance,
  runMaintenanceCleanup,
  formatFindings,
  formatCleanupResult,
  parseDuration,
  MaintenanceError,
} from "../core/maintenance.js";
import {
  buildKnowledgeDigest,
  formatDigest,
} from "../core/knowledge-digest.js";
import {
  buildMetrics,
  formatMetricsSummary,
  formatFailures,
} from "../core/metrics.js";
import {
  buildSessionPlan,
  formatSessionPlan,
  formatSessionSummary,
} from "../core/session.js";
import { exportDashboard } from "../dashboard/export.js";
import { createDashboardServer } from "../dashboard/server/server.js";
import { DashboardSnapshotError } from "../dashboard/snapshot.js";
import { RUN_STATUSES } from "../logging/run-log.js";
import {
  prepareRerunFromReview,
  buildRerunChain,
  formatChain,
  RerunGateError,
  DEFAULT_MAX_ATTEMPTS,
} from "../core/rerun.js";
import {
  runReviewerAgent,
  ReviewerAgentGateError,
} from "../core/reviewer-agent.js";
import { syncRunArtifactsToDb } from "../core/run-materialize.js";
import { runReviewedRunWorkflow } from "../core/reviewed-run-workflow.js";
import {
  evaluateReviewer,
  compareDecisions,
  ReviewEvaluateError,
} from "../core/review-evaluator.js";
import {
  listKnowledge,
  KnowledgePromoteGateError,
} from "../core/knowledge-promoter.js";
import {
  promoteKnowledgeDbFirst,
  rejectKnowledgeDbFirst,
  type KnowledgeDbContext,
} from "../core/knowledge-db.js";
import {
  buildKnowledgeContext,
  KnowledgeContextError,
  domainSlug,
} from "../core/knowledge-context.js";
import { registerProjectCommands } from "./project.js";
import { registerDbCommands } from "./db.js";
import {
  hasScopeFilter,
  runScopedMetrics,
  runScopedInbox,
  runScopedKnowledgeDigest,
  runScopedBacklog,
} from "./db-scope.js";
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
}

interface RunOutcome {
  runId: string;
  status: string;
  failed: boolean;
}

async function cmdRun(o: RunOpts): Promise<RunOutcome> {
  const harnessRoot = getHarnessRoot();

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
    const paths = harnessPaths(harnessRoot);
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
  let knowledgeContext: { path: string; text: string } | undefined;
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
    if (!existsSync(ctxPath)) {
      process.stderr.write(
        `harness error: --with-knowledge: ${ctxPath} not found; ` +
          `run 'harness knowledge build-context --domain ${o.domain}' first\n`,
      );
      process.exit(1);
    }
    knowledgeContext = { path: ctxPath, text: await readFile(ctxPath, "utf8") };
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
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
    ...(knowledgeContext !== undefined ? { knowledgeContext } : {}),
    ...(prepared !== undefined
      ? {
          compiledPolicy: prepared.compiledPolicy,
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

  if (o.dryRun) {
    process.stdout.write(
      `reviewed-run workflow for ${resolved.domain} (maxAttempts=${o.maxAttempts}):\n` +
        `${JSON.stringify(resolved, null, 2)}\n`,
    );
    return { rootRunId: "", finalStatus: "dry-run" };
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
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

  const result = await runReviewedRunWorkflow({
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

async function cmdLockList(): Promise<void> {
  const paths = harnessPaths(getHarnessRoot());

  // Phase 10-1: file domain locks are retired. Warn (once) if any
  // .harness/locks/*.lock sentinels are still lying around.
  warnLegacyFileLocks(paths.locksDir);

  // DB-backed locks (Phase 9 lease + heartbeat + fencing token).
  // Phase 9 post-close (second review) P2-3 fix — lock list is purely
  // observational. A missing DB, an old schema (pre-v5), or a missing
  // `domain_locks` table must NOT crash the command; surface them as
  // structured "unavailable" messages.
  process.stdout.write("db locks:\n");
  if (!existsSync(paths.dbPath)) {
    process.stdout.write("  (db not initialised — run 'harness db init')\n");
    return;
  }
  const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  const db = dbHandle.db;
  try {
    const hasTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'domain_locks'",
      )
      .get();
    if (hasTable === undefined) {
      process.stdout.write(
        "  (unavailable — schema < v5; run 'harness db migrate')\n",
      );
      return;
    }
    const rows = listActiveDomainLocks(db);
    if (rows.length === 0) {
      process.stdout.write("  (none)\n");
      return;
    }
    for (const r of rows) {
      process.stdout.write(
        `  ${r.domainKey}\tlock_id=${r.lockId}\trunId=${r.holderRunId}\tpid=${r.holderPid}\thost=${r.holderHostname}\texpires=${r.expiresAt}\theartbeat=${r.heartbeatAt}\n`,
      );
    }
  } finally {
    dbHandle.close();
  }
}

interface LockReleaseOpts {
  domain: string;
  repoId?: string;
  runId?: string;
  force?: boolean;
  /**
   * Phase 10-1: source selector is retained as a deprecated CLI flag for
   * a short transition. `file` and `both` emit a stderr warning; only the
   * DB-backed lock is actually released. Default = DB-only.
   */
  source?: "file" | "db" | "both";
}

async function cmdLockRelease(o: LockReleaseOpts): Promise<void> {
  const paths = harnessPaths(getHarnessRoot());
  let releasedAny = false;

  // Phase 10-1 post-review P2: `--source file` and `--source both` are
  // both deprecated; warn but still perform the DB release so stale
  // operator scripts that still pass `--source file` actually clear the
  // current (DB) lock.
  if (o.source === "file") {
    process.stderr.write(
      "warning: `--source file` is deprecated in Phase 10 — file domain " +
        "locks are no longer used. Continuing with a DB lock release.\n",
    );
  } else if (o.source === "both") {
    process.stderr.write(
      "warning: `--source both` is deprecated in Phase 10 — only the DB " +
        "domain lock is released.\n",
    );
  }

  // Surface any legacy file lock sentinels so operators know to clean them up.
  warnLegacyFileLocks(paths.locksDir);

  if (existsSync(paths.dbPath)) {
    const dbHandle = openManagedDb({ dbPath: paths.dbPath });
    const db = dbHandle.db;
    try {
      // `domain_key` mirrors workflow-runner's `${repoId}::${domain}`.
      const domainKey =
        o.repoId !== undefined ? `${o.repoId}::${o.domain}` : o.domain;
      // forcing through a runId mismatch is destructive: the heartbeat side
      // will fail with LeaseStolenError. Surface a strong warning.
      if (o.force === true) {
        process.stderr.write(
          "warning: --force on an active DB lease may cause the running " +
            "harness process to fail with LeaseStolenError.\n",
        );
      }
      const r = releaseDomainLockByDomain(db, {
        domainKey,
        ...(o.runId !== undefined ? { runId: o.runId } : {}),
        ...(o.force === true ? { force: true } : {}),
        releasedBy: "cli",
      });
      if (r !== null) {
        process.stdout.write(
          `released db lock ${r.domainKey} (lock_id=${r.lockId}, holder=${r.holderRunId})\n`,
        );
        releasedAny = true;
      }
    } finally {
      dbHandle.close();
    }
  }

  if (!releasedAny) {
    process.stdout.write(
      `no lock for domain ${o.domain}${o.repoId ? ` (repo ${o.repoId})` : ""}\n`,
    );
  }
}

const program = new Command();
program.name("harness");

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

const lockCmd = program.command("lock").description("manage domain locks");
lockCmd
  .command("list")
  .description("list active domain locks")
  .action(async () => {
    await cmdLockList();
  });
lockCmd
  .command("release")
  .description("force-release a domain lock (e.g. after crashed run)")
  .requiredOption("--domain <name>", "domain whose lock to release")
  .option("--repo-id <id>", "repo id (namespaced locks created by `harness run`)")
  .option("--run-id <id>", "only release if the lock belongs to this runId")
  .option("--force", "release even on runId mismatch / unreadable lock", false)
  .option(
    "--source <which>",
    "(deprecated, Phase 10) file | db | both — `file`/`both` warn and only" +
      " the DB lock is released; default is `db`",
    "db",
  )
  .action(async (raw: Record<string, unknown>) => {
    const source = String(raw.source);
    if (source !== "file" && source !== "db" && source !== "both") {
      process.stderr.write(
        `harness error: --source must be one of file | db | both (got ${JSON.stringify(source)})\n`,
      );
      process.exit(1);
    }
    await cmdLockRelease({
      domain: String(raw.domain),
      ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
      ...(raw.runId !== undefined ? { runId: String(raw.runId) } : {}),
      force: Boolean(raw.force),
      source: source as "file" | "db" | "both",
    });
  });

const reviewCmd = program
  .command("review")
  .description("operate on review-decision.yaml under runs/<id>/");
reviewCmd
  .command("list")
  .description(
    "list runs (default: needs_review + changes_requested の review queue)",
  )
  .option("--all", "include runs of every status", false)
  .option(
    "--status <status>",
    "comma-separated status filter (e.g. needs_review,failed-policy-violation)",
  )
  .option("--domain <domain>", "restrict to a single domain")
  .option("--limit <n>", "cap the number of rows")
  .option("--json", "emit JSON ({ validRuns, invalidRuns }) instead of a table", false)
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const opts: Parameters<typeof listReviews>[0] = {
      runsDir: paths.runsDir,
      all: Boolean(raw.all),
    };
    if (raw.status !== undefined) {
      const statuses = String(raw.status)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (statuses.length === 0) {
        process.stderr.write(
          "harness error: --status was empty; pass at least one status\n",
        );
        process.exit(1);
      }
      const unknown = statuses.filter(
        (s) => !(RUN_STATUSES as readonly string[]).includes(s),
      );
      if (unknown.length > 0) {
        process.stderr.write(
          `harness error: unknown --status value(s): ${unknown.join(", ")}\n` +
            `  valid: ${RUN_STATUSES.join(", ")}\n`,
        );
        process.exit(1);
      }
      opts.statuses = statuses;
    }
    if (raw.domain !== undefined) opts.domain = String(raw.domain);
    if (raw.limit !== undefined) {
      const n = Number(raw.limit);
      if (!Number.isInteger(n) || n < 0) {
        process.stderr.write(
          `harness error: --limit must be a non-negative integer (got ${JSON.stringify(String(raw.limit))})\n`,
        );
        process.exit(1);
      }
      opts.limit = n;
    }
    const result = await listReviews(opts);
    if (raw.json) {
      process.stdout.write(formatJson(result));
      return;
    }
    process.stdout.write(formatTable(result));
    // invalid run dirs are surfaced on stderr so they never pollute the
    // table (and so --json's stdout stays parseable).
    if (result.invalid.length > 0) {
      process.stderr.write(
        `warning: ${result.invalid.length} unreadable run dir(s) hidden; use --all or --json to inspect\n`,
      );
      if (Boolean(raw.all)) {
        for (const inv of result.invalid) {
          process.stderr.write(`  ${inv.runId}: ${inv.error}\n`);
        }
      }
    }
  });
reviewCmd
  .command("process")
  .description("apply review-decision.yaml to meta.status")
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--override <decision>",
    "Phase 11-6: human override — approved|changes_requested|rejected",
  )
  .option(
    "--reason <text>",
    "Phase 11-6: override reason (required with --override)",
  )
  .option(
    "--actor-reviewer <id>",
    "Phase 11-6: actor reviewer_id (default: system)",
  )
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    let overrideOpts: {
      decision: "approved" | "changes_requested" | "rejected";
      reason: string;
      actorReviewerId?: string;
    } | undefined;
    if (raw.override !== undefined) {
      const dec = String(raw.override);
      if (
        dec !== "approved" &&
        dec !== "changes_requested" &&
        dec !== "rejected"
      ) {
        process.stderr.write(
          `harness error: --override must be one of approved|changes_requested|rejected (got ${JSON.stringify(dec)})\n`,
        );
        process.exit(1);
      }
      if (raw.reason === undefined) {
        process.stderr.write(
          "harness error: --reason is required when --override is supplied\n",
        );
        process.exit(1);
      }
      overrideOpts = {
        decision: dec,
        reason: String(raw.reason),
        ...(raw.actorReviewer !== undefined
          ? { actorReviewerId: String(raw.actorReviewer) }
          : {}),
      };
    }
    try {
      const result = await processReviewDecision({
        runsDir: paths.runsDir,
        locksDir: paths.locksDir,
        dbPath: paths.dbPath,
        runId: String(raw.runId),
        ...(overrideOpts !== undefined ? { override: overrideOpts } : {}),
      });
      for (const w of result.warnings) {
        process.stdout.write(`warning: ${w}\n`);
      }
      process.stdout.write(
        `run=${result.runId} ${result.previousStatus} → ${result.newStatus} reviewer=${result.reviewer ?? "(none)"} reviewedAt=${result.reviewedAt}\n`,
      );
    } catch (e) {
      // a guard failure (concurrent reviewer, source-mode mismatch) is
      // user-facing → exit 1, not an exit-2 unexpected error.
      if (
        e instanceof ReviewGateError ||
        e instanceof DomainLockBusyError ||
        e instanceof StateConflictError ||
        e instanceof SourceModeError ||
        e instanceof OverrideReasonRequiredError ||
        e instanceof UnauthorizedOverrideError ||
        e instanceof UnknownReviewerError
      ) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
reviewCmd
  .command("auto")
  .description(
    "invoke a codex reviewer agent that reads run artifacts (read-only) and writes review-decision.yaml",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--reviewer-name <name>",
    "stamped into review-decision.yaml.reviewer (default: codex-reviewer)",
  )
  .option(
    "--allow-overwrite",
    "replace review-decision.yaml even if it already has a non-pending decision",
    false,
  )
  .option(
    "--dry-run",
    "run codex and validate the output but do NOT write review-decision.yaml",
    false,
  )
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    // separate codex instance with read-only sandbox; the agent must not
    // touch the worktree/runs files except by us writing review-decision
    // afterward.
    const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
    const runner = createCodexCliRunner({
      codexBin,
      sandbox: "read-only",
    });
    const runId = String(raw.runId);
    const dryRun = Boolean(raw.dryRun);
    // re-ingest the run's artifacts so reviewer-agent logs / the decision
    // become DB-canonical too (Phase 8-13). Skipped for --dry-run, which
    // writes nothing.
    const syncArtifacts = (): void => {
      if (!dryRun) {
        syncRunArtifactsToDb({
          dbPath: paths.dbPath,
          runsDir: paths.runsDir,
          runId,
        });
      }
    };
    try {
      const result = await runReviewerAgent({
        runsDir: paths.runsDir,
        runId,
        dbPath: paths.dbPath,
        ...(raw.reviewerName !== undefined
          ? { reviewerName: String(raw.reviewerName) }
          : {}),
        allowOverwrite: Boolean(raw.allowOverwrite),
        dryRun,
        codexRunner: runner,
      });
      syncArtifacts();
      process.stdout.write(
        `run=${result.runId} decision=${result.decision} reviewer=${result.reviewer} reviewedAt=${result.reviewedAt}\n`,
      );
      if (result.dryRun) {
        process.stdout.write(
          `note: --dry-run — review-decision.yaml was NOT written.\n`,
        );
      } else {
        process.stdout.write(
          `note: review-decision.yaml was overwritten; run 'harness review process --run-id ${result.runId}' to apply.\n`,
        );
      }
    } catch (e) {
      if (e instanceof ReviewerAgentGateError) {
        // the gate path may have written review-auto-error.json — capture it
        syncArtifacts();
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
reviewCmd
  .command("evaluate")
  .description(
    "run the reviewer agent N times against one run to observe verdict stability",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .option("--samples <n>", "number of reviewer samples", "3")
  .option("--reviewer-name <name>", "reviewer identity")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const samples = Number(raw.samples);
    if (!Number.isInteger(samples) || samples < 1) {
      process.stderr.write(
        `harness error: --samples must be a positive integer (got ${JSON.stringify(String(raw.samples))})\n`,
      );
      process.exit(1);
    }
    const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
    const runner = createCodexCliRunner({ codexBin, sandbox: "read-only" });
    try {
      const r = await evaluateReviewer({
        runsDir: paths.runsDir,
        runId: String(raw.runId),
        samples,
        codexRunner: runner,
        ...(raw.reviewerName !== undefined
          ? { reviewerName: String(raw.reviewerName) }
          : {}),
      });
      const dist = Object.entries(r.decisionCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      process.stdout.write(
        `run=${r.runId} samples=${r.samples.length} ${dist}\n`,
      );
      for (const f of r.dangerFlags) {
        process.stderr.write(`danger: ${f}\n`);
      }
    } catch (e) {
      if (e instanceof ReviewEvaluateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
const proposalsCmd = reviewCmd
  .command("proposals")
  .description("review proposal lifecycle (Phase 11-7)");
proposalsCmd
  .command("list")
  .description("list proposals for a run")
  .argument("<runId>", "target run id")
  .option("--include-archived", "include archived proposals", false)
  .action(async (runId: string, raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
    try {
      const rows = new ReviewProposalRepository(dbHandle.db).listForRun(
        runId,
        { includeArchived: Boolean(raw.includeArchived) },
      );
      if (rows.length === 0) {
        process.stdout.write("(none)\n");
        return;
      }
      for (const r of rows) {
        process.stdout.write(
          `  ${String(r.proposalId).padStart(4, "0")}\treviewer=${r.reviewer}\tdecision=${r.decision}\tlifecycle=${(r as ReviewProposalRow & { lifecycleStatus?: string }).lifecycleStatus ?? "?"}\treviewedAt=${r.reviewedAt}\n`,
        );
      }
    } finally {
      dbHandle.close();
    }
  });
proposalsCmd
  .command("archive")
  .description("archive a single proposal (audit-preserving)")
  .argument("<proposalId>", "proposal id")
  .action(async (proposalId: string) => {
    const paths = harnessPaths(getHarnessRoot());
    const id = Number(proposalId);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write(
        `harness error: proposal id must be a positive integer (got ${JSON.stringify(proposalId)})\n`,
      );
      process.exit(1);
    }
    const dbHandle = openManagedDb({ dbPath: paths.dbPath });
    try {
      const ok = new ReviewProposalRepository(dbHandle.db).archive(id);
      process.stdout.write(
        ok
          ? `archived proposal_id=${id}\n`
          : `proposal_id=${id} already archived (no-op)\n`,
      );
    } finally {
      dbHandle.close();
    }
  });
proposalsCmd
  .command("vacuum")
  .description("vacuum (archive) old superseded / processed / rejected_stale proposals")
  .requiredOption("--older-than <days>", "threshold in days (positive integer)")
  .option("--apply", "actually archive (default: dry-run)", false)
  .action(async (raw: Record<string, unknown>) => {
    const days = Number(raw.olderThan);
    if (!Number.isFinite(days) || days <= 0) {
      process.stderr.write(
        `harness error: --older-than must be a positive number of days (got ${JSON.stringify(String(raw.olderThan))})\n`,
      );
      process.exit(1);
    }
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const paths = harnessPaths(getHarnessRoot());
    const dbHandle = openManagedDb({ dbPath: paths.dbPath });
    try {
      const ids = new ReviewProposalRepository(dbHandle.db).vacuumOlderThan({
        olderThan: cutoff,
        apply: Boolean(raw.apply),
      });
      const verb = raw.apply ? "archived" : "would archive";
      process.stdout.write(
        `${verb} ${ids.length} proposal(s) older than ${cutoff.toISOString()}` +
          (ids.length > 0 ? ` — ids: ${ids.join(", ")}` : "") +
          "\n",
      );
      if (!raw.apply) {
        process.stdout.write("  (dry-run — use --apply to perform)\n");
      }
    } finally {
      dbHandle.close();
    }
  });

const reviewersCmd = reviewCmd
  .command("reviewers")
  .description("review reviewer identity registry (Phase 11)");
reviewersCmd
  .command("list")
  .description("list registered reviewers")
  .action(async () => {
    const paths = harnessPaths(getHarnessRoot());
    if (!existsSync(paths.dbPath)) {
      process.stderr.write(
        "harness error: db not initialised — run 'harness db init'\n",
      );
      process.exit(1);
    }
    const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
    try {
      const rows = new ReviewerRepository(dbHandle.db).list();
      if (rows.length === 0) {
        process.stdout.write("(none)\n");
        return;
      }
      for (const r of rows) {
        process.stdout.write(
          `  ${r.reviewerId}\ttype=${r.reviewerType}\tgroup=${r.groupId ?? "-"}\ttrust=${r.trustLevel}\t"${r.displayName}"\n`,
        );
      }
    } finally {
      dbHandle.close();
    }
  });
reviewersCmd
  .command("add")
  .description("register a new reviewer")
  .argument("<reviewer_id>", "stable reviewer id (slug)")
  .requiredOption("--type <type>", "reviewer type: human|codex|external|system")
  .requiredOption("--display-name <name>", "human-readable display name")
  .option("--group <id>", "group id (humans / codex / security / ...)")
  .option(
    "--trust <level>",
    "advisory | normal | required | policy (default: normal)",
    "normal",
  )
  .action(async (reviewerId: string, raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    if (!existsSync(paths.dbPath)) {
      process.stderr.write(
        "harness error: db not initialised — run 'harness db init'\n",
      );
      process.exit(1);
    }
    const type = String(raw.type);
    if (
      type !== "human" &&
      type !== "codex" &&
      type !== "external" &&
      type !== "system"
    ) {
      process.stderr.write(
        `harness error: --type must be one of human|codex|external|system (got ${JSON.stringify(type)})\n`,
      );
      process.exit(1);
    }
    const trust = String(raw.trust ?? "normal");
    if (
      trust !== "advisory" &&
      trust !== "normal" &&
      trust !== "required" &&
      trust !== "policy"
    ) {
      process.stderr.write(
        `harness error: --trust must be one of advisory|normal|required|policy (got ${JSON.stringify(trust)})\n`,
      );
      process.exit(1);
    }
    const dbHandle = openManagedDb({ dbPath: paths.dbPath });
    try {
      const r = new ReviewerRepository(dbHandle.db).add({
        reviewerId,
        reviewerType: type,
        displayName: String(raw.displayName),
        ...(raw.group !== undefined ? { groupId: String(raw.group) } : {}),
        trustLevel: trust,
      });
      process.stdout.write(
        `added reviewer ${r.reviewerId} (type=${r.reviewerType}, trust=${r.trustLevel})\n`,
      );
    } catch (e) {
      if (e instanceof DuplicateReviewerError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    } finally {
      dbHandle.close();
    }
  });

reviewCmd
  .command("compare")
  .description("compare two review-decision.yaml files (e.g. human vs agent)")
  .requiredOption("--human <path>", "human review-decision.yaml")
  .requiredOption("--agent <path>", "agent review-decision.yaml")
  .action(async (raw: Record<string, unknown>) => {
    try {
      const r = await compareDecisions({
        humanPath: String(raw.human),
        agentPath: String(raw.agent),
      });
      process.stdout.write(r.report);
      if (!r.decisionMatch) process.exit(1);
    } catch (e) {
      if (e instanceof ReviewEvaluateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

// Phase 8-7: `index.sqlite` and `harness index` were removed — the
// harness.sqlite read model (`harness db import` / the dashboard)
// superseded the Phase 3-5 listing cache. The command is kept one phase
// as an explicit error stub so `harness index` does not silently 404;
// any leftover scripts get a pointer to the replacement instead.
program
  .command("index")
  .description("removed (Phase 8) — superseded by the harness.sqlite read model")
  .argument("[args...]", "ignored — kept only so the stub catches subcommands")
  .allowUnknownOption()
  .action(() => {
    process.stderr.write(
      "harness error: 'harness index' was removed (Phase 8); index.sqlite is " +
        "superseded by the harness.sqlite read model:\n" +
        "  harness db status            — read-model / DB status\n" +
        "  harness db check-consistency — verify the DB against exported files\n" +
        "  harness dashboard export     — derived run views\n",
    );
    process.exit(1);
  });

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

program
  .command("inbox")
  .description(
    "today's queue: needs_review / changes_requested / failed / cleanup / knowledge",
  )
  .option("--today", "only runs started today", false)
  .option(
    "--needs-action",
    "only sections that need an action (exclude knowledge)",
    false,
  )
  .option("--failed", "only the failed section", false)
  .option("--cleanup", "only the cleanup-candidates section", false)
  .option("--project <id>", "scope to a project (DB-backed, Phase 6)")
  .option("--repo-id <id>", "scope to a repo (DB-backed, Phase 6)")
  .option("--json", "emit JSON instead of text", false)
  .action(async (raw: Record<string, unknown>) => {
    // a project/repo/domain scope answers from the DB read model (Phase 6-6)
    if (hasScopeFilter(raw)) {
      runScopedInbox(getHarnessRoot(), raw);
      return;
    }
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    const inbox = await buildInbox({
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      knowledgeDir: join(harnessRoot, "docs", "knowledge"),
      ...(raw.today ? { today: new Date() } : {}),
    });
    // section selection is decided BEFORE the json branch so --failed /
    // --cleanup / --needs-action apply to JSON output too.
    let sections: InboxSection[] | undefined;
    if (raw.failed) sections = ["failed"];
    else if (raw.cleanup) sections = ["cleanupCandidates"];
    else if (raw.needsAction) {
      sections = [
        "needsReview",
        "changesRequested",
        "failed",
        "cleanupCandidates",
      ];
    }
    if (raw.json) {
      process.stdout.write(
        sections ? formatInboxJson(inbox, sections) : formatInboxJson(inbox),
      );
      return;
    }
    process.stdout.write(
      sections ? formatInbox(inbox, sections) : formatInbox(inbox),
    );
  });

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
    if (hasScopeFilter(raw)) {
      runScopedBacklog(getHarnessRoot(), raw);
      return;
    }
    const paths = harnessPaths(getHarnessRoot());
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
    const items = await listItems(paths.backlogDir, status);
    process.stdout.write(formatItemList(items));
  });
backlogCmd
  .command("show")
  .description("show a backlog item")
  .requiredOption("--item-id <id>", "backlog item id")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      const item = await showItem(paths.backlogDir, String(raw.itemId));
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

const dashboardCmd = program
  .command("dashboard")
  .description("static, read-only HTML dashboard (DB-backed — Phase 6)");
dashboardCmd
  .command("export")
  .description("write docs/dashboard/index.html from the DB read model")
  .option("--out <path>", "output path (default docs/dashboard/index.html)")
  .option("--project <id>", "scope the dashboard to one project")
  .option("--repo-id <id>", "scope the dashboard to one repo")
  .option("--no-auto-import", "do not refresh the DB from files first")
  .action((raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const outPath =
      raw.out !== undefined
        ? String(raw.out)
        : join(harnessRoot, "docs", "dashboard", "index.html");
    const filters = {
      ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
      ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
    };
    try {
      const r = exportDashboard({
        harnessRoot,
        outPath,
        filters,
        // commander maps --no-auto-import to raw.autoImport === false
        autoImport: raw.autoImport !== false,
      });
      const imported = raw.autoImport !== false ? " (auto-imported from files)" : "";
      process.stdout.write(
        `dashboard exported: ${r.outPath} (${r.bytes} bytes)${imported}\n` +
          `consistency: ${r.snapshot.consistencyStatus}\n`,
      );
    } catch (e) {
      if (e instanceof DashboardSnapshotError) {
        process.stderr.write(`harness error: ${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
dashboardCmd
  .command("serve")
  .description("start a read-only HTTP dashboard (Phase 12)")
  .option("--host <host>", "bind host (default 127.0.0.1)", "127.0.0.1")
  .option("--port <port>", "bind port (default 8787)", "8787")
  .option(
    "--token-env <name>",
    "env var name holding the bearer token (Phase 12-7)",
  )
  .option(
    "--no-artifact-body",
    "disable GET /api/artifacts/:id/body (Phase 12-7)",
    false,
  )
  .option(
    "--max-inline-artifact-bytes <n>",
    "inline artifact body size cap (default 1048576)",
    "1048576",
  )
  .option("--cors-origin <origin>", "enable CORS for this origin")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const port = Number(raw.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write(
        `harness error: --port must be 0..65535 (got ${JSON.stringify(String(raw.port))})\n`,
      );
      process.exit(1);
    }
    const host = String(raw.host);
    const isLocal =
      host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!isLocal && raw.tokenEnv === undefined) {
      process.stderr.write(
        `warning: binding to non-local host ${host} without --token-env. ` +
          "All requests will be rejected with 401 (fail-closed). " +
          "Set --token-env <ENV_NAME> to enable auth.\n",
      );
    } else if (host === "0.0.0.0") {
      process.stderr.write(
        "warning: binding to 0.0.0.0 exposes the dashboard to the network.\n",
      );
    }
    const maxInline = Number(raw.maxInlineArtifactBytes);
    if (!Number.isInteger(maxInline) || maxInline < 0) {
      process.stderr.write(
        `harness error: --max-inline-artifact-bytes must be a non-negative integer\n`,
      );
      process.exit(1);
    }
    const token =
      raw.tokenEnv !== undefined ? process.env[String(raw.tokenEnv)] : undefined;
    const server = createDashboardServer({
      dbPath: paths.dbPath,
      host,
      port,
      ...(token !== undefined ? { token } : {}),
      artifactBodyDisabled: raw.artifactBody === false,
      maxInlineArtifactBytes: maxInline,
      ...(raw.corsOrigin !== undefined
        ? { corsOrigin: String(raw.corsOrigin) }
        : {}),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = addr && typeof addr === "object" ? addr.port : port;
        process.stdout.write(
          `harness dashboard listening on http://${host}:${actualPort}\n`,
        );
        resolve();
      });
    });
  });

const sessionCmd = program
  .command("session")
  .description("rule-ordered work-session planning (suggestion only)");
function sessionOpts(): {
  runsDir: string;
  workspacesDir: string;
  backlogDir: string;
  knowledgeDir: string;
} {
  const harnessRoot = getHarnessRoot();
  const paths = harnessPaths(harnessRoot);
  return {
    runsDir: paths.runsDir,
    workspacesDir: paths.workspacesDir,
    backlogDir: paths.backlogDir,
    knowledgeDir: join(harnessRoot, "docs", "knowledge"),
  };
}
sessionCmd
  .command("plan")
  .description("ordered to-do list from the current state (does not run)")
  .action(async () => {
    process.stdout.write(
      formatSessionPlan(await buildSessionPlan(sessionOpts())),
    );
  });
sessionCmd
  .command("start")
  .description("the first N items of the session plan")
  .option("--limit <n>", "how many items to show", "3")
  .action(async (raw: Record<string, unknown>) => {
    const n = Number(raw.limit);
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write(
        `harness error: --limit must be a positive integer (got ${JSON.stringify(String(raw.limit))})\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      formatSessionPlan(await buildSessionPlan(sessionOpts()), n),
    );
  });
sessionCmd
  .command("summary")
  .description("compact snapshot of what is pending now")
  .action(async () => {
    process.stdout.write(
      formatSessionSummary(await buildSessionPlan(sessionOpts())),
    );
  });

const metricsCmd = program
  .command("metrics")
  .description("personal operating metrics over runs / review / retry");
function metricsSince(raw: Record<string, unknown>): Date | undefined {
  if (raw.since === undefined) return undefined;
  try {
    return new Date(Date.now() - parseDuration(String(raw.since)));
  } catch (e) {
    process.stderr.write(`harness error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
metricsCmd
  .command("summary")
  .description("run / review / retry / safety summary")
  .option("--since <dur>", "window, e.g. 30d / 12h")
  .option("--project <id>", "scope to a project (DB-backed, Phase 6)")
  .option("--repo-id <id>", "scope to a repo (DB-backed, Phase 6)")
  .option("--domain <d>", "scope to a domain (with --project / --repo-id)")
  .option("--json", "emit JSON instead of text")
  .action(async (raw: Record<string, unknown>) => {
    if (hasScopeFilter(raw)) {
      runScopedMetrics(getHarnessRoot(), raw);
      return;
    }
    const paths = harnessPaths(getHarnessRoot());
    const since = metricsSince(raw);
    const m = await buildMetrics({
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      ...(since ? { since } : {}),
    });
    process.stdout.write(formatMetricsSummary(m));
  });
metricsCmd
  .command("domain")
  .description("metrics for a single domain")
  .argument("<domain>", "target domain")
  .option("--since <dur>", "window, e.g. 30d / 12h")
  .action(async (domain: string, raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const since = metricsSince(raw);
    const m = await buildMetrics({
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      domain,
      ...(since ? { since } : {}),
    });
    process.stdout.write(formatMetricsSummary(m));
  });
metricsCmd
  .command("failures")
  .description("breakdown of failed-* runs by status")
  .option("--since <dur>", "window, e.g. 30d / 12h")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const since = metricsSince(raw);
    const m = await buildMetrics({
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      ...(since ? { since } : {}),
    });
    process.stdout.write(formatFailures(m));
  });

const maintenanceCmd = program
  .command("maintenance")
  .description("detect and clean up operational debris");
maintenanceCmd
  .command("check")
  .description("report stale locks / orphan worktrees / oversized run dirs")
  .action(async () => {
    const paths = harnessPaths(getHarnessRoot());
    const findings = await checkMaintenance({
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      locksDir: paths.locksDir,
    });
    process.stdout.write(formatFindings(findings));
  });
maintenanceCmd
  .command("cleanup")
  .description("remove cleanable debris (stale locks / orphan worktrees)")
  .option("--dry-run", "list what would be removed, delete nothing", false)
  .option("--older-than <dur>", "only debris older than e.g. 30d / 12h")
  .option("--force", "actually delete (required for a non-dry-run)", false)
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      const result = await runMaintenanceCleanup({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        dryRun: Boolean(raw.dryRun),
        force: Boolean(raw.force),
        ...(raw.olderThan !== undefined
          ? { olderThanMs: parseDuration(String(raw.olderThan)) }
          : {}),
      });
      process.stdout.write(formatCleanupResult(result));
    } catch (e) {
      if (e instanceof MaintenanceError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

const cleanupCmd = program
  .command("cleanup")
  .description(
    "remove worktree + branch for an approved/rejected run (run dir kept by default)",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--force",
    "allow cleanup of needs_review / failed-* / verified / generated (NOT changes_requested or running)",
    false,
  )
  .option(
    "--scope <scope>",
    "workspace (worktree+branch, keep run dir) | run (also delete run dir) | all (also git worktree prune)",
    "workspace",
  )
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const scope = String(raw.scope);
    if (scope !== "workspace" && scope !== "run" && scope !== "all") {
      process.stderr.write(
        `harness error: --scope must be workspace | run | all (got ${JSON.stringify(scope)})\n`,
      );
      process.exit(1);
    }
    try {
      const result = await cleanupRun({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        dbPath: paths.dbPath,
        runId: String(raw.runId),
        force: Boolean(raw.force),
        scope,
      });
      process.stdout.write(
        `run=${result.runId} scope=${result.scope} previousStatus=${result.previousStatus} worktreeRemoved=${result.worktreeRemoved} branchRemoved=${result.branchRemoved} runDirRemoved=${result.runDirRemoved}\n`,
      );
    } catch (e) {
      if (
        e instanceof CleanupGateError ||
        e instanceof DomainLockBusyError ||
        e instanceof StateConflictError ||
        e instanceof SourceModeError
      ) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

const rerunCmd = program
  .command("rerun")
  .description("spawn a new run from a changes_requested parent")
  // NOTE: a plain option (not requiredOption) so the `rerun chain`
  // subcommand can be invoked without --from-review. The action below
  // enforces presence for the bare `rerun` form.
  .option(
    "--from-review <run-id>",
    "parent run id (must be in changes_requested status)",
  )
  .option(
    "--max-attempts <n>",
    `max rerun attempts from the chain root (default ${DEFAULT_MAX_ATTEMPTS}); ` +
      `the n-th rerun is refused once rerunAttempt would exceed n`,
  )
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    if (raw.fromReview === undefined) {
      process.stderr.write(
        "harness error: 'harness rerun' requires --from-review <run-id> " +
          "(did you mean 'harness rerun chain --run-id <id>'?)\n",
      );
      process.exit(1);
    }
    let maxAttempts: number | undefined;
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
    let prep;
    try {
      prep = await prepareRerunFromReview({
        runsDir: paths.runsDir,
        parentRunId: String(raw.fromReview),
        dbPath: paths.dbPath,
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      });
    } catch (e) {
      if (e instanceof RerunGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
    for (const w of prep.warnings) {
      process.stderr.write(`warning: ${w}\n`);
    }

    // Resolve policy the same way `harness run` does. A rerun of a
    // `--project` parent must re-resolve the profile (Phase 6-1) so the
    // child keeps the same compiled policy / context packs / project
    // provenance; a plain `--repo-id` parent reads policies/repos/<id>.yaml.
    const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
    // the parent's repoPath is the repo the chain actually ran against — a
    // `--project` parent may have used `--repo` as an override, so the rerun
    // reuses it instead of re-deriving the path from the profile. It comes
    // from the parent's canonical meta (the `runs` row for a db-first
    // parent), not a possibly-stale exported meta.json (P1-b).
    const parentRepoPath = prep.repoPath;
    let prepared: PreparedProjectRun | undefined;
    let resolved;
    let repoPath: string;
    let repoId: string;
    if (prep.projectId !== undefined) {
      try {
        prepared = await prepareProjectRun({
          harnessRoot,
          projectId: prep.projectId,
          domain: prep.domain,
          repoOverride: parentRepoPath,
        });
      } catch (e) {
        if (e instanceof ProjectError) {
          process.stderr.write(`harness error: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      }
      // the profile must still resolve to the same repo the parent ran
      // against — otherwise the rerun would silently change attribution.
      if (prepared.repoId !== prep.repoId) {
        process.stderr.write(
          `harness error: rerun repo attribution drift — parent ` +
            `${prep.parentRunId} recorded repoId "${prep.repoId}" but project ` +
            `"${prep.projectId}" now resolves to "${prepared.repoId}"\n`,
        );
        process.exit(1);
      }
      resolved = prepared.resolvedPolicy;
      repoPath = prepared.repoPath;
      repoId = prepared.repoId;
    } else {
      const global = await loadGlobalPolicy(paths.globalPolicyPath);
      const repo = await loadRepoPolicy(paths.repoPolicyPath(prep.repoId));
      resolved = resolvePolicy(global, repo, prep.domain);
      repoPath = parentRepoPath;
      repoId = prep.repoId;
    }
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
      domain: prep.domain,
      goal: prep.goal,
      baseBranch: prep.baseBranch,
      codexRunner: runner,
      parentRunId: prep.parentRunId,
      rootRunId: prep.rootRunId,
      rerunAttempt: prep.rerunAttempt,
      ...(prepared !== undefined
        ? {
            compiledPolicy: prepared.compiledPolicy,
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
      `run=${result.runId} parentRunId=${prep.parentRunId} rootRunId=${prep.rootRunId} rerunAttempt=${prep.rerunAttempt} status=${result.status} safetyStatus=${result.safetyStatus} commands=${cmdOk}/${cmdTotal}\n`,
    );
    if (
      result.status === "failed-policy-violation" ||
      result.status === "failed-codex" ||
      result.status === "failed-codex-timeout" ||
      result.status === "failed-diff-collection" ||
      result.status === "failed-command" ||
      result.status === "failed-internal-error"
    ) {
      process.exit(1);
    }
  });
rerunCmd
  .command("chain")
  .description("show the rerun chain a run belongs to (root → descendants)")
  .requiredOption("--run-id <id>", "any run in the chain")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      const root = await buildRerunChain({
        runsDir: paths.runsDir,
        runId: String(raw.runId),
        dbPath: paths.dbPath,
      });
      process.stdout.write(formatChain(root));
    } catch (e) {
      if (e instanceof RerunGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

function knowledgeDirOf(
  harnessRoot: string,
  raw: Record<string, unknown>,
): string {
  return raw.out !== undefined
    ? String(raw.out)
    : join(harnessRoot, "docs", "knowledge");
}

/** DB-first knowledge context — runs dir, knowledge dir, harness DB path. */
function knowledgeDbContext(
  harnessRoot: string,
  raw: Record<string, unknown>,
): KnowledgeDbContext {
  const paths = harnessPaths(harnessRoot);
  return {
    runsDir: paths.runsDir,
    knowledgeDir: knowledgeDirOf(harnessRoot, raw),
    dbPath: paths.dbPath,
  };
}

/** Map a knowledge command failure to a user error (exit 1). */
function knowledgeError(e: unknown): never {
  if (
    e instanceof KnowledgePromoteGateError ||
    e instanceof StateConflictError ||
    e instanceof SourceModeError
  ) {
    process.stderr.write(`harness error: ${(e as Error).message}\n`);
    process.exit(1);
  }
  throw e;
}

const knowledgeCmd = program
  .command("knowledge")
  .description("review and promote knowledge-candidates");
knowledgeCmd
  .command("build-context")
  .description(
    "aggregate promoted knowledge for a domain into docs/knowledge-context/<domain>.md",
  )
  .requiredOption("--domain <domain>", "target domain")
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    try {
      const r = await buildKnowledgeContext({
        knowledgeDir: knowledgeDirOf(harnessRoot, raw),
        outDir: join(harnessRoot, "docs", "knowledge-context"),
        domain: String(raw.domain),
      });
      process.stdout.write(
        `domain=${r.domain} entries=${r.entries.length} out=${r.outPath}\n`,
      );
    } catch (e) {
      if (e instanceof KnowledgeContextError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
knowledgeCmd
  .command("list")
  .description("list a run's knowledge candidates with their status")
  .requiredOption("--run-id <id>", "target run identifier")
  .option("--kind <kind>", "only candidates with this kind")
  .option("--domain <domain>", "only candidates with this domain")
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    try {
      const entries = await listKnowledge({
        runsDir: paths.runsDir,
        knowledgeDir: knowledgeDirOf(harnessRoot, raw),
        runId: String(raw.runId),
        ...(raw.kind !== undefined ? { kind: String(raw.kind) } : {}),
        ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
      });
      if (entries.length === 0) {
        process.stdout.write("no candidates\n");
        return;
      }
      for (const e of entries) {
        const extra =
          e.status === "rejected" ? ` (by ${e.rejectedBy})` : "";
        process.stdout.write(
          `[${e.index}] ${e.status}${extra}  kind=${e.kind} domain=${e.domain} confidence=${e.confidence}\n` +
            `    ${e.title}\n`,
        );
      }
    } catch (e) {
      if (e instanceof KnowledgePromoteGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
knowledgeCmd
  .command("reject")
  .description("record a reject decision for a candidate (sidecar)")
  .requiredOption("--run-id <id>", "target run identifier")
  .requiredOption("--index <n>", "candidate index to reject")
  .requiredOption("--reviewer <name>", "reviewer handle")
  .requiredOption("--reason <text>", "why the candidate is rejected")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0) {
      process.stderr.write(
        `harness error: --index must be a non-negative integer (got ${JSON.stringify(String(raw.index))})\n`,
      );
      process.exit(1);
    }
    try {
      const r = await rejectKnowledgeDbFirst(
        knowledgeDbContext(harnessRoot, raw),
        {
          runId: String(raw.runId),
          index,
          reviewer: String(raw.reviewer),
          reason: String(raw.reason),
        },
      );
      for (const w of r.exportWarnings ?? []) {
        process.stderr.write(`warning: ${w}\n`);
      }
      process.stdout.write(
        `run=${r.runId} rejected candidate ${r.index} by ${r.reviewer}\n`,
      );
    } catch (e) {
      knowledgeError(e);
    }
  });
knowledgeCmd
  .command("promote")
  .description(
    "write each candidate as docs/knowledge/<kind>/<runId>-<idx>-<slug>.md",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .requiredOption("--reviewer <name>", "reviewer handle (stamped into each md)")
  .option("--kind <kind>", "only candidates with this kind are promoted")
  .option(
    "--allow-duplicate",
    "create a md even if an identical content hash already exists",
    false,
  )
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const ctx = knowledgeDbContext(harnessRoot, raw);
    try {
      const r = await promoteKnowledgeDbFirst(ctx, {
        runId: String(raw.runId),
        reviewer: String(raw.reviewer),
        allowDuplicate: Boolean(raw.allowDuplicate),
        ...(raw.kind !== undefined ? { kind: String(raw.kind) } : {}),
      });
      process.stdout.write(
        `run=${r.runId} promoted=${r.promoted.length} skipped=${r.skipped.length} out=${ctx.knowledgeDir}\n`,
      );
      for (const p of r.promoted) {
        process.stdout.write(`  promoted ${p.kind}: ${p.path}\n`);
      }
      for (const s of r.skipped) {
        process.stdout.write(
          `  skipped [${s.index}] ${s.reason}${s.detail ? ` — ${s.detail}` : ""}\n`,
        );
      }
      for (const w of r.exportWarnings ?? []) {
        process.stderr.write(`warning: ${w}\n`);
      }
    } catch (e) {
      knowledgeError(e);
    }
  });

knowledgeCmd
  .command("digest")
  .description("aggregate knowledge candidates / promotions / rejections")
  .option("--since <dur>", "only items within this window, e.g. 7d / 12h")
  .option("--domain <domain>", "restrict to one domain")
  .option("--project <id>", "scope to a project (DB-backed, Phase 6)")
  .option("--repo-id <id>", "scope to a repo (DB-backed, Phase 6)")
  .option("--json", "emit JSON instead of text")
  .action(async (raw: Record<string, unknown>) => {
    if (hasScopeFilter(raw)) {
      runScopedKnowledgeDigest(getHarnessRoot(), raw);
      return;
    }
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    let since: Date | undefined;
    if (raw.since !== undefined) {
      try {
        since = new Date(Date.now() - parseDuration(String(raw.since)));
      } catch (e) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
    }
    const digest = await buildKnowledgeDigest({
      runsDir: paths.runsDir,
      knowledgeDir: join(harnessRoot, "docs", "knowledge"),
      ...(since ? { since } : {}),
      ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
    });
    process.stdout.write(formatDigest(digest));
  });

registerProjectCommands(program);
registerDbCommands(program);

program.parseAsync(process.argv).catch((e: unknown) => {
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
void reviewCmd;
void cleanupCmd;
void rerunCmd;
void knowledgeCmd;
