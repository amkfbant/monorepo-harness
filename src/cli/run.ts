#!/usr/bin/env node
import process from "node:process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { runDomainCoding } from "../core/workflow-runner.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import {
  domainLockName,
  domainLockPath,
  DomainLockError,
  type LockInfo,
} from "../workspace/domain-lock.js";
import {
  processReviewDecision,
  ReviewGateError,
} from "../core/review-processor.js";
import { cleanupRun, CleanupGateError } from "../core/cleanup.js";
import {
  listReviews,
  scanAllRuns,
  applyListFilters,
  formatTable,
  formatJson,
} from "../core/review-lister.js";
import {
  rebuildIndex,
  loadFromIndex,
  indexStatus,
  showRunFromIndex,
} from "../index/run-index.js";
import { createPullRequest, PrGateError } from "../core/pr-creator.js";
import { createGhPrPublisher } from "../core/gh-pr-publisher.js";
import {
  renderRunShow,
  renderRunTimeline,
  renderRunArtifacts,
  RunViewError,
} from "../core/run-viewer.js";
import {
  buildInbox,
  formatInbox,
  formatInboxJson,
  type InboxSection,
} from "../core/inbox.js";
import {
  addItem,
  listItems,
  showItem,
  setItemStatus,
  recordBacklogRun,
  formatItem,
  formatItemList,
  BacklogError,
  type BacklogStatus,
  type BacklogPriority,
} from "../core/backlog.js";
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
import { exportDashboard } from "../core/dashboard.js";
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
import { runReviewedRunWorkflow } from "../core/reviewed-run-workflow.js";
import {
  evaluateReviewer,
  compareDecisions,
  ReviewEvaluateError,
} from "../core/review-evaluator.js";
import {
  promoteKnowledge,
  rejectKnowledge,
  listKnowledge,
  KnowledgePromoteGateError,
} from "../core/knowledge-promoter.js";
import {
  buildKnowledgeContext,
  KnowledgeContextError,
  domainSlug,
} from "../core/knowledge-context.js";
import { registerProjectCommands } from "./project.js";
import { registerDbCommands } from "./db.js";
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
  if (!existsSync(paths.locksDir)) {
    process.stdout.write("no locks\n");
    return;
  }
  const entries = (await readdir(paths.locksDir)).filter((e) =>
    e.endsWith(".lock"),
  );
  if (entries.length === 0) {
    process.stdout.write("no locks\n");
    return;
  }
  // Surface unreadable locks too — those are exactly the ones operators
  // need to see (crash recovery, manual debugging).
  for (const e of entries) {
    const lockPath = join(paths.locksDir, e);
    try {
      const raw = await readFile(lockPath, "utf8");
      const info = JSON.parse(raw) as LockInfo;
      process.stdout.write(
        `${e}\trunId=${info.runId}\tpid=${info.pid}\thost=${info.hostname}\tacquiredAt=${info.acquiredAt}\n`,
      );
    } catch (err) {
      process.stdout.write(
        `${e}\tstatus=unreadable\terror=${(err as Error).message}\n`,
      );
    }
  }
}

interface LockReleaseOpts {
  domain: string;
  repoId?: string;
  runId?: string;
  force?: boolean;
}

async function cmdLockRelease(o: LockReleaseOpts): Promise<void> {
  const paths = harnessPaths(getHarnessRoot());
  // a run created by `harness run` namespaces the lock by repo id — pass
  // --repo-id to release it. Without --repo-id the legacy domain-only
  // lock name is used (manual recovery of old locks).
  const path = domainLockPath(paths.locksDir, o.domain, o.repoId);
  if (!existsSync(path)) {
    process.stdout.write(
      `no lock for domain ${o.domain}${o.repoId ? ` (repo ${o.repoId})` : ""}\n`,
    );
    return;
  }
  let info: LockInfo | undefined;
  try {
    info = JSON.parse(await readFile(path, "utf8")) as LockInfo;
  } catch {
    if (!o.force) {
      throw new Error(
        `lockfile at ${path} is unreadable; rerun with --force to delete anyway`,
      );
    }
  }
  if (info && o.runId !== undefined && info.runId !== o.runId) {
    if (!o.force) {
      throw new Error(
        `runId mismatch: lock has ${info.runId}, requested ${o.runId}. Use --force to override.`,
      );
    }
  }
  await rm(path, { force: true });
  process.stdout.write(
    `released ${domainLockName(o.domain, o.repoId)} (${path})\n`,
  );
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

function runViewAction(
  render: (runsDir: string, runId: string) => Promise<string>,
) {
  return async (raw: Record<string, unknown>): Promise<void> => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      process.stdout.write(await render(paths.runsDir, String(raw.runId)));
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
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      process.stdout.write(
        await renderRunShow(
          paths.runsDir,
          String(raw.runId),
          paths.backlogDir,
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
  .action(runViewAction(renderRunTimeline));
runCmd
  .command("artifacts")
  .description("list the artifact files in a run dir")
  .requiredOption("--run-id <id>", "target run identifier")
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
  .action(async (raw: Record<string, unknown>) => {
    await cmdLockRelease({
      domain: String(raw.domain),
      ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
      ...(raw.runId !== undefined ? { runId: String(raw.runId) } : {}),
      force: Boolean(raw.force),
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
  .option(
    "--use-index",
    "read from the SQLite index instead of scanning runs/ (Phase 3-5)",
    false,
  )
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
    let result;
    if (raw.useIndex) {
      // index path: load every run from the SQLite index, then apply the
      // SAME filter/sort/limit logic as the file scan.
      try {
        const scan = loadFromIndex(paths.indexDbPath);
        result = applyListFilters(scan.valid, scan.invalid, opts);
      } catch (e) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
    } else {
      result = await listReviews(opts);
    }
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
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    try {
      const result = await processReviewDecision({
        runsDir: paths.runsDir,
        locksDir: paths.locksDir,
        runId: String(raw.runId),
      });
      for (const w of result.warnings) {
        process.stdout.write(`warning: ${w}\n`);
      }
      process.stdout.write(
        `run=${result.runId} ${result.previousStatus} → ${result.newStatus} reviewer=${result.reviewer ?? "(none)"} reviewedAt=${result.reviewedAt}\n`,
      );
    } catch (e) {
      if (e instanceof ReviewGateError || e instanceof DomainLockError) {
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
    try {
      const result = await runReviewerAgent({
        runsDir: paths.runsDir,
        runId: String(raw.runId),
        ...(raw.reviewerName !== undefined
          ? { reviewerName: String(raw.reviewerName) }
          : {}),
        allowOverwrite: Boolean(raw.allowOverwrite),
        dryRun: Boolean(raw.dryRun),
        codexRunner: runner,
      });
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

const indexCmd = program
  .command("index")
  .description(
    "SQLite run index — a derived cache; runs/ stays the source of truth",
  );
// Phase 6: `index.sqlite` is superseded by the `harness.sqlite` read model
// (`harness db import` / the dashboard). `index` still works for legacy
// `review list --use-index`, but new tooling should use `harness db`.
indexCmd.hook("preAction", () => {
  process.stderr.write(
    "warning: 'harness index' is deprecated (Phase 6); the harness.sqlite " +
      "read model via 'harness db import' supersedes index.sqlite\n",
  );
});
indexCmd
  .command("rebuild")
  .description("rebuild the SQLite index from a full runs/ scan")
  .action(async () => {
    const paths = harnessPaths(getHarnessRoot());
    const scan = await scanAllRuns(paths.runsDir);
    const stats = rebuildIndex(paths.indexDbPath, scan);
    process.stdout.write(
      `index rebuilt: runs=${stats.runCount} invalid=${stats.invalidCount} db=${stats.dbPath}\n`,
    );
  });
indexCmd
  .command("status")
  .description("show SQLite index status")
  .action(() => {
    const paths = harnessPaths(getHarnessRoot());
    const st = indexStatus(paths.indexDbPath);
    if (!st.exists) {
      process.stdout.write(
        `index: not built (${st.dbPath}); run 'harness index rebuild'\n`,
      );
      return;
    }
    if (st.corrupt) {
      process.stderr.write(
        `index: corrupt (${st.dbPath}): ${st.error}; run 'harness index rebuild'\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `index: runs=${st.runCount} invalid=${st.invalidCount} ` +
        `rebuiltAt=${st.rebuiltAt ?? "?"} size=${st.sizeBytes ?? 0}B db=${st.dbPath}\n`,
    );
  });
indexCmd
  .command("show")
  .description("show one run's indexed row")
  .requiredOption("--run-id <id>", "target run identifier")
  .action((raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      const found = showRunFromIndex(paths.indexDbPath, String(raw.runId));
      if (!found) {
        process.stderr.write(
          `harness error: run ${String(raw.runId)} not in index ` +
            `(rebuild if it is new)\n`,
        );
        process.exit(1);
      }
      if (found.kind === "invalid") {
        process.stdout.write(
          `${JSON.stringify({ runId: found.runId, status: "invalid", error: found.error }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`${JSON.stringify(found.entry, null, 2)}\n`);
      }
    } catch (e) {
      process.stderr.write(`harness error: ${(e as Error).message}\n`);
      process.exit(1);
    }
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
      if (e instanceof PrGateError) {
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
  .option("--json", "emit JSON instead of text", false)
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    const inbox = await buildInbox({
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      indexDbPath: paths.indexDbPath,
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
  if (e instanceof BacklogError) {
    process.stderr.write(`harness error: ${(e as Error).message}\n`);
    process.exit(1);
  }
  throw e;
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
    const paths = harnessPaths(getHarnessRoot());
    try {
      const item = await addItem(paths.backlogDir, {
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
      });
      process.stdout.write(`added ${item.id} [${item.status}]\n`);
    } catch (e) {
      backlogError(e);
    }
  });
backlogCmd
  .command("list")
  .description("list backlog items")
  .option("--status <status>", "open | doing | done | deferred")
  .action(async (raw: Record<string, unknown>) => {
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
    const paths = harnessPaths(getHarnessRoot());
    try {
      const item = await setItemStatus(
        paths.backlogDir,
        String(raw.itemId),
        "done",
      );
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
    const paths = harnessPaths(getHarnessRoot());
    try {
      const item = await setItemStatus(
        paths.backlogDir,
        String(raw.itemId),
        "deferred",
      );
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
    const paths = harnessPaths(getHarnessRoot());
    let item;
    try {
      item = await showItem(paths.backlogDir, String(raw.itemId));
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
      const updated = await recordBacklogRun(
        paths.backlogDir,
        item.id,
        runId,
      );
      process.stdout.write(
        `backlog ${item.id} → doing, linked run ${runId} ` +
          `(${updated.linkedRuns.length} total)\n`,
      );
    }
    if (failed) process.exit(1);
  });

const dashboardCmd = program
  .command("dashboard")
  .description("static, read-only HTML dashboard");
dashboardCmd
  .command("export")
  .description("write docs/dashboard/index.html (no server, read-only)")
  .option("--out <path>", "output path (default docs/dashboard/index.html)")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    const outPath =
      raw.out !== undefined
        ? String(raw.out)
        : join(harnessRoot, "docs", "dashboard", "index.html");
    const r = await exportDashboard({
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      indexDbPath: paths.indexDbPath,
      knowledgeDir: join(harnessRoot, "docs", "knowledge"),
      outPath,
    });
    process.stdout.write(
      `dashboard exported: ${r.outPath} (${r.bytes} bytes)\n`,
    );
  });

const sessionCmd = program
  .command("session")
  .description("rule-ordered work-session planning (suggestion only)");
function sessionOpts(): {
  runsDir: string;
  workspacesDir: string;
  indexDbPath: string;
  backlogDir: string;
  knowledgeDir: string;
} {
  const harnessRoot = getHarnessRoot();
  const paths = harnessPaths(harnessRoot);
  return {
    runsDir: paths.runsDir,
    workspacesDir: paths.workspacesDir,
    indexDbPath: paths.indexDbPath,
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
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const since = metricsSince(raw);
    const m = await buildMetrics({
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      indexDbPath: paths.indexDbPath,
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
      indexDbPath: paths.indexDbPath,
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
      indexDbPath: paths.indexDbPath,
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
        runId: String(raw.runId),
        force: Boolean(raw.force),
        scope,
      });
      process.stdout.write(
        `run=${result.runId} scope=${result.scope} previousStatus=${result.previousStatus} worktreeRemoved=${result.worktreeRemoved} branchRemoved=${result.branchRemoved} runDirRemoved=${result.runDirRemoved}\n`,
      );
    } catch (e) {
      if (e instanceof CleanupGateError || e instanceof DomainLockError) {
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
    // reuses it instead of re-deriving the path from the profile.
    const parentMeta = JSON.parse(
      await readFile(
        join(paths.runsDir, prep.parentRunId, "meta.json"),
        "utf8",
      ),
    ) as { repoPath: string };
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
          repoOverride: parentMeta.repoPath,
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
      repoPath = parentMeta.repoPath;
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
    const paths = harnessPaths(getHarnessRoot());
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0) {
      process.stderr.write(
        `harness error: --index must be a non-negative integer (got ${JSON.stringify(String(raw.index))})\n`,
      );
      process.exit(1);
    }
    try {
      const r = await rejectKnowledge({
        runsDir: paths.runsDir,
        runId: String(raw.runId),
        index,
        reviewer: String(raw.reviewer),
        reason: String(raw.reason),
      });
      process.stdout.write(
        `run=${r.runId} rejected candidate ${r.index} by ${r.reviewer}\n`,
      );
    } catch (e) {
      if (e instanceof KnowledgePromoteGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
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
    const paths = harnessPaths(harnessRoot);
    const knowledgeDir = knowledgeDirOf(harnessRoot, raw);
    try {
      const r = await promoteKnowledge({
        runsDir: paths.runsDir,
        knowledgeDir,
        runId: String(raw.runId),
        reviewer: String(raw.reviewer),
        allowDuplicate: Boolean(raw.allowDuplicate),
        ...(raw.kind !== undefined ? { kind: String(raw.kind) } : {}),
      });
      process.stdout.write(
        `run=${r.runId} promoted=${r.promoted.length} skipped=${r.skipped.length} out=${knowledgeDir}\n`,
      );
      for (const p of r.promoted) {
        process.stdout.write(`  promoted ${p.kind}: ${p.path}\n`);
      }
      for (const s of r.skipped) {
        process.stdout.write(
          `  skipped [${s.index}] ${s.reason}${s.detail ? ` — ${s.detail}` : ""}\n`,
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
  .command("digest")
  .description("aggregate knowledge candidates / promotions / rejections")
  .option("--since <dur>", "only items within this window, e.g. 7d / 12h")
  .option("--domain <domain>", "restrict to one domain")
  .action(async (raw: Record<string, unknown>) => {
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
  process.exit(2);
});

// silence unused suppress
void runCmd;
void reviewCmd;
void cleanupCmd;
void rerunCmd;
void knowledgeCmd;
