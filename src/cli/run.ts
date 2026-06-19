#!/usr/bin/env node
import process from "node:process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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
import { gitCli } from "../git/git-cli.js";
import { importKnowledgeEntries } from "../db/import/knowledge.js";
import { emptyCounters } from "../db/import/common.js";
import {
  DomainLockBusyError,
  findTransientLeaseCause,
} from "../workspace/db-domain-lock.js";
import {
  ReviewerRepository,
  DuplicateReviewerError,
  UnknownReviewerError,
  InvalidReviewerMetadataError,
  reviewerLensMetadata,
} from "../db/repositories/reviewers.js";
import {
  ReviewProposalRepository,
  type ReviewProposalRow,
} from "../db/repositories/review-proposals.js";
import {
  OverrideReasonRequiredError,
  UnauthorizedOverrideError,
} from "../db/repositories/review-overrides.js";
import {
  adoptAgentWorkspace,
  AgentWorkspaceError,
  canonicalRepoKey,
  changedFilesForWorkspace,
  createAgentWorkspace,
  inspectAgentWorkspace,
  listAgentWorkspaces,
  normalizeWorktreePath,
  removeAgentWorkspace,
  resolveMainWorktree,
  type AgentWorkspace,
} from "../workspace/agent-workspace.js";
import { reconcileWorkspaces } from "../workspace/workspace-reconcile.js";
import {
  createDetachedWorktree,
  removeDetachedWorktree,
} from "../workspace/git-worktree.js";
import {
  assembleWorkspaceStatuses,
  readWorkspaceStatusData,
} from "../workspace/workspace-status-builder.js";
import {
  findWorkspaceConflicts,
  type WorkspaceChangedFiles,
} from "../workspace/workspace-conflicts.js";
import { WorkspaceRepository } from "../db/repositories/workspaces.js";
import {
  buildRecoveryBriefing,
  type RecoveryHitch,
} from "../workspace/workspace-recover.js";
import { HitchRepository } from "../hitch/repository.js";
import { ConvergenceService } from "../hitch/convergence.js";
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
import {
  runReviewedRunWorkflow,
  ReviewWorkflowUnsupportedError,
  assertReviewedRunWorkflowSupported,
} from "../core/reviewed-run-workflow.js";
import {
  evaluateReviewer,
  compareDecisions,
  ReviewEvaluateError,
} from "../core/review-evaluator.js";
import {
  listKnowledge,
  KnowledgePromoteGateError,
  splitFrontmatter,
} from "../core/knowledge-promoter.js";
import {
  deprecateKnowledgeDbFirst,
  promoteKnowledgeDbFirst,
  rejectKnowledgeDbFirst,
  type KnowledgeDbContext,
} from "../core/knowledge-db.js";
import {
  getCurrentKnowledgeRevision,
  listCurrentKnowledgeRevisions,
  recordKnowledgeEntryRevision,
} from "../db/repositories/knowledge-entry-revisions.js";
import {
  buildKnowledgeContext,
  buildKnowledgeContextFromDb,
  KnowledgeContextError,
  domainSlug,
} from "../core/knowledge-context.js";
import {
  recordOperationalKnowledge,
  listOperationalKnowledge,
  getOperationalKnowledge,
  deprecateOperationalKnowledge,
  operationalKnowledgeDigest,
  OperationalKnowledgeError,
} from "../core/operational-knowledge.js";
import {
  exportOperationalKnowledge,
  importOperationalKnowledge,
} from "../core/operational-knowledge-files.js";
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
import {
  hasScopeFilter,
  runMetricsDelta,
  runScopedMetrics,
  runMetricsSnapshot,
  runScopedKnowledgeDigest,
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
    const syncArtifacts = (untrustedReviewerEventsPublished?: boolean): void => {
      if (!dryRun) {
        syncRunArtifactsToDb({
          dbPath: paths.dbPath,
          runsDir: paths.runsDir,
          runId,
          ...(untrustedReviewerEventsPublished !== undefined
            ? {
                untrustedReviewerArtifacts: {
                  reviewerEventsPublished: untrustedReviewerEventsPublished,
                },
              }
            : {}),
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
          `note: review proposal was recorded; run 'harness review process --run-id ${result.runId}' to apply.\n`,
        );
      }
    } catch (e) {
      if (e instanceof ReviewerAgentGateError) {
        // the gate path may have written review-auto-error.json — capture it
        syncArtifacts(e.reviewerEventsPublished);
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
        ...(existsSync(paths.dbPath) ? { dbPath: paths.dbPath } : {}),
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
  .option("--group <id>", "only list reviewers in this group")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    if (!existsSync(paths.dbPath)) {
      process.stderr.write(
        "harness error: db not initialised — run 'harness db init'\n",
      );
      process.exit(1);
    }
    const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
    try {
      const reviewers = new ReviewerRepository(dbHandle.db);
      const rows =
        raw.group !== undefined
          ? reviewers.listByGroup(String(raw.group))
          : reviewers.list();
      if (rows.length === 0) {
        process.stdout.write("(none)\n");
        return;
      }
      for (const r of rows) {
        const lens = reviewerLensMetadata(r);
        const lensPart = lens === null ? "" : `\tlens=${lens.lens}`;
        process.stdout.write(
          `  ${r.reviewerId}\ttype=${r.reviewerType}\tgroup=${r.groupId ?? "-"}\ttrust=${r.trustLevel}${lensPart}\t"${r.displayName}"\n`,
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
  .option("--lens <axis>", "review lens axis for multi-lens consensus")
  .option(
    "--lens-prompt <text>",
    "untrusted reviewer prompt guidance for the selected lens",
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
      const metadata: Record<string, unknown> = {};
      if (raw.lens !== undefined) metadata.lens = String(raw.lens);
      if (raw.lensPrompt !== undefined) {
        metadata.lens_prompt = String(raw.lensPrompt);
      }
      const r = new ReviewerRepository(dbHandle.db).add({
        reviewerId,
        reviewerType: type,
        displayName: String(raw.displayName),
        ...(raw.group !== undefined ? { groupId: String(raw.group) } : {}),
        trustLevel: trust,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      process.stdout.write(
        `added reviewer ${r.reviewerId} (type=${r.reviewerType}, trust=${r.trustLevel})\n`,
      );
    } catch (e) {
      if (
        e instanceof DuplicateReviewerError ||
        e instanceof InvalidReviewerMetadataError
      ) {
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
  .command("snapshot")
  .description("record a metrics aggregate snapshot and prune retention")
  .option("--project <id>", "scope to a project")
  .option("--repo-id <id>", "scope to a repo")
  .option("--domain <d>", "scope to a domain")
  .option("--retention-days <n>", "snapshot retention in days", "90")
  .option("--json", "emit JSON instead of text")
  .action((raw: Record<string, unknown>) => {
    runMetricsSnapshot(getHarnessRoot(), raw);
  });
metricsCmd
  .command("delta")
  .description("compare live metrics to an older aggregate snapshot")
  .option("--since <dur>", "baseline age, e.g. 7d / 12h", "7d")
  .option("--project <id>", "scope to a project")
  .option("--repo-id <id>", "scope to a repo")
  .option("--domain <d>", "scope to a domain")
  .option("--json", "emit JSON instead of text")
  .action((raw: Record<string, unknown>) => {
    runMetricsDelta(getHarnessRoot(), raw);
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
    const resolvedCodexBinaryVersion = codexBinaryVersion(codexBin);
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
      codexBinaryVersion: resolvedCodexBinaryVersion,
      parentRunId: prep.parentRunId,
      rootRunId: prep.rootRunId,
      rerunAttempt: prep.rerunAttempt,
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
      `run=${result.runId} parentRunId=${prep.parentRunId} rootRunId=${prep.rootRunId} rerunAttempt=${prep.rerunAttempt} status=${result.status} safetyStatus=${result.safetyStatus} commands=${cmdOk}/${cmdTotal}\n`,
    );
    if (
      result.status === "failed-policy-violation" ||
      result.status === "failed-codex" ||
      result.status === "failed-codex-timeout" ||
      result.status === "failed-diff-collection" ||
      result.status === "failed-budget-exceeded" ||
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

function knowledgeExportPath(
  knowledgeRoot: string,
  row: { path: string | null; kind: string; entryId: string },
): string {
  const prefix = "docs/knowledge/";
  if (row.path !== null && row.path.startsWith(prefix)) {
    return join(knowledgeRoot, row.path.slice(prefix.length));
  }
  const safe = row.entryId.replace(/[^A-Za-z0-9._-]/g, "-");
  return join(knowledgeRoot, row.kind, `${safe}.md`);
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
  .option("--project <id>", "scope DB-current revisions to a project")
  .option("--repo-id <id>", "scope DB-current revisions to a repo")
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    try {
      let r;
      if (raw.project !== undefined || raw.repoId !== undefined) {
        const paths = harnessPaths(harnessRoot);
        const handle = openManagedDb({ dbPath: paths.dbPath });
        try {
          runMigrations(handle.db);
          r = await buildKnowledgeContextFromDb({
            db: handle.db,
            outDir: join(harnessRoot, "docs", "knowledge-context"),
            domain: String(raw.domain),
            ...(raw.project !== undefined
              ? { projectId: String(raw.project) }
              : {}),
            ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
          });
        } finally {
          handle.close();
        }
      } else {
        r = await buildKnowledgeContext({
          knowledgeDir: knowledgeDirOf(harnessRoot, raw),
          outDir: join(harnessRoot, "docs", "knowledge-context"),
          domain: String(raw.domain),
        });
      }
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
  .command("deprecate")
  .description("mark a DB-current knowledge entry deprecated")
  .argument("<entry-id>", "knowledge entry id, e.g. docs/knowledge/<kind>/<file>.md")
  .option("--actor <actor>", "actor label", "cli")
  .option("--reason <text>", "revision reason", "knowledge deprecate")
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .action(async (entryId: string, raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    try {
      const r = await deprecateKnowledgeDbFirst(
        knowledgeDbContext(harnessRoot, raw),
        {
          entryId,
          actor: String(raw.actor ?? "cli"),
          reason: String(raw.reason ?? "knowledge deprecate"),
        },
      );
      process.stdout.write(
        `deprecated ${r.entryId} revision=${r.revisionId} version=${r.version} out=${r.path}\n`,
      );
      for (const w of r.exportWarnings ?? []) {
        process.stderr.write(`warning: ${w}\n`);
      }
    } catch (e) {
      knowledgeError(e);
    }
  });

knowledgeCmd
  .command("import")
  .description("import docs/knowledge markdown into DB-current revisions")
  .option("--from-docs", "import from docs/knowledge", false)
  .option("--json", "emit JSON instead of text", false)
  .action((raw: Record<string, unknown>) => {
    if (raw.fromDocs !== true) {
      process.stderr.write(
        "harness error: 'knowledge import' requires --from-docs\n",
      );
      process.exit(1);
    }
    const root = getHarnessRoot();
    const paths = harnessPaths(root);
    const handle = openManagedDb({ dbPath: paths.dbPath });
    try {
      runMigrations(handle.db);
      const report = emptyCounters();
      importKnowledgeEntries(
        handle.db,
        join(root, "docs", "knowledge"),
        report,
        { currentPointerMode: "set-current" },
      );
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(report, null, 2)}\n`
          : `knowledge import: entries=${report.knowledgeEntries} candidates=${report.knowledgeCandidates}\n`,
      );
    } finally {
      handle.close();
    }
  });

knowledgeCmd
  .command("export")
  .description("export DB-current knowledge revisions back to docs")
  .option("--to-docs", "export to docs/knowledge", false)
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .option("--json", "emit JSON instead of text", false)
  .action((raw: Record<string, unknown>) => {
    if (raw.toDocs !== true) {
      process.stderr.write(
        "harness error: 'knowledge export' requires --to-docs\n",
      );
      process.exit(1);
    }
    const root = getHarnessRoot();
    const paths = harnessPaths(root);
    const knowledgeRoot = knowledgeDirOf(root, raw);
    const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
    try {
      const rows = listCurrentKnowledgeRevisions(handle.db);
      const written: string[] = [];
      for (const r of rows) {
        const outPath = knowledgeExportPath(knowledgeRoot, r);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, r.bodyMarkdown, "utf8");
        written.push(outPath);
      }
      const out = { written };
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(out, null, 2)}\n`
          : `knowledge export: wrote ${written.length} file(s)\n`,
      );
    } finally {
      handle.close();
    }
  });

knowledgeCmd
  .command("show")
  .description("show a DB-current knowledge entry revision")
  .argument("<entry-id>", "knowledge entry id")
  .option("--json", "emit JSON instead of markdown", false)
  .action((entryId: string, raw: Record<string, unknown>) => {
    const handle = openManagedDb({
      dbPath: harnessPaths(getHarnessRoot()).dbPath,
      readonly: true,
    });
    try {
      if (isOperationalEntry(handle.db, entryId)) {
        process.stderr.write(
          `harness error: ${entryId} is operational knowledge; use 'knowledge ops show'\n`,
        );
        process.exit(1);
      }
      const revision = getCurrentKnowledgeRevision(handle.db, entryId);
      if (revision === null) {
        process.stderr.write(`harness error: no knowledge entry ${entryId}\n`);
        process.exit(1);
      }
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(revision, null, 2)}\n`
          : revision.bodyMarkdown.endsWith("\n")
            ? revision.bodyMarkdown
            : `${revision.bodyMarkdown}\n`,
      );
    } finally {
      handle.close();
    }
  });

knowledgeCmd
  .command("edit")
  .description("edit a DB-current knowledge entry using $EDITOR")
  .argument("<entry-id>", "knowledge entry id")
  .option("--actor <actor>", "actor label", "cli")
  .option("--reason <text>", "revision reason", "manual edit")
  .action((entryId: string, raw: Record<string, unknown>) => {
    const editor = process.env.EDITOR;
    if (!editor) {
      process.stderr.write(
        "harness error: $EDITOR is not set; use knowledge show/import/export to edit explicitly\n",
      );
      process.exit(1);
    }
    const handle = openManagedDb({ dbPath: harnessPaths(getHarnessRoot()).dbPath });
    try {
      runMigrations(handle.db);
      if (isOperationalEntry(handle.db, entryId)) {
        process.stderr.write(
          `harness error: ${entryId} is operational knowledge; edit it with 'knowledge ops add --key <key>'\n`,
        );
        process.exit(1);
      }
      const current = getCurrentKnowledgeRevision(handle.db, entryId);
      if (current === null) {
        process.stderr.write(`harness error: no knowledge entry ${entryId}\n`);
        process.exit(1);
      }
      const currentEntry = handle.db
        .prepare(
          `SELECT kind, path
             FROM knowledge_entries
            WHERE entry_id = ?`,
        )
        .get(entryId) as { kind: string; path: string | null } | undefined;
      const dir = mkdtempSync(join(tmpdir(), "harness-knowledge-edit-"));
      const editPath = join(dir, "entry.md");
      writeFileSync(editPath, current.bodyMarkdown, "utf8");
      const child = spawnSync(editor, [editPath], { stdio: "inherit" });
      if (child.status !== 0) {
        process.stderr.write(`harness error: editor exited with status ${child.status}\n`);
        process.exit(1);
      }
      const bodyMarkdown = readFileSync(editPath, "utf8");
      const parsed = splitFrontmatter(bodyMarkdown);
      const frontmatter = parsed.frontmatter ?? {};
      const revision = recordKnowledgeEntryRevision(handle.db, {
        entryId,
        bodyMarkdown,
        frontmatter,
        title:
          typeof frontmatter.title === "string"
            ? frontmatter.title
            : current.title ?? entryId,
        actor: String(raw.actor),
        reason: String(raw.reason),
      }).revision;
      handle.db
        .prepare(
          `UPDATE knowledge_entries
              SET project_id = ?, repo_id = ?, domain = ?, kind = ?,
                  path = ?, body = ?, frontmatter_json = ?, title = ?,
                  source_mode = 'db-first',
                  export_status = 'dirty',
                  last_export_error = NULL
            WHERE entry_id = ?`,
        )
        .run(
          typeof frontmatter.project_id === "string"
            ? frontmatter.project_id
            : null,
          typeof frontmatter.repo_id === "string" ? frontmatter.repo_id : null,
          typeof frontmatter.domain === "string" ? frontmatter.domain : null,
          typeof frontmatter.kind === "string"
            ? frontmatter.kind
            : currentEntry?.kind ?? "imported",
          typeof frontmatter.path === "string"
            ? frontmatter.path
            : currentEntry?.path ?? entryId,
          parsed.body,
          JSON.stringify(frontmatter),
          typeof frontmatter.title === "string"
            ? frontmatter.title
            : current.title,
          entryId,
        );
      process.stdout.write(
        `knowledge edit: ${entryId} revision=${revision.revisionId} version=${revision.version}\n`,
      );
    } finally {
      handle.close();
    }
  });

/** True when `entryId` is an operational entry (so codebase commands refuse it). */
function isOperationalEntry(
  db: ReturnType<typeof openManagedDb>["db"],
  entryId: string,
): boolean {
  const row = db
    .prepare("SELECT category FROM knowledge_entries WHERE entry_id = ?")
    .get(entryId) as { category: string } | undefined;
  return row?.category === "operational";
}

/** Append a repeated `--tag` value into an accumulator (commander collect). */
function collectTag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// --- operational knowledge (issue #57): author non-codebase learnings ----
// (toolchain / CI / environment / harness-usage). Authored directly (no
// candidate stage) and never injected into coder prompts — see operational-
// knowledge.ts and docs/specs/db.md (schema v19).
const knowledgeOpsCmd = knowledgeCmd
  .command("ops")
  .description("operational (non-codebase) knowledge: author / list / show / deprecate");

knowledgeOpsCmd
  .command("add")
  .description("author an operational knowledge entry")
  .requiredOption("--title <title>", "short title")
  .option("--body <text>", "markdown body (or use --body-file / stdin)")
  .option("--body-file <path>", "read the markdown body from a file")
  .option("--key <slug>", "stable slug → ops/<slug> (default: generated id)")
  .option("--kind <kind>", "sub-kind, e.g. toolchain / ci / environment", "operational")
  .option("--tag <tag>", "tag (repeatable)", collectTag, [])
  .option("--project <id>", "scope to a project (default: portable)")
  .option("--repo-id <id>", "scope to a repo (default: portable)")
  .option("--domain <domain>", "scope to a domain (default: portable)")
  .option("--actor <actor>", "actor label", "cli")
  .option("--json", "emit JSON instead of text", false)
  .action((raw: Record<string, unknown>) => {
    let body: string;
    if (typeof raw.body === "string") {
      body = raw.body;
    } else if (typeof raw.bodyFile === "string") {
      body = readFileSync(raw.bodyFile, "utf8");
    } else if (process.stdin.isTTY) {
      // no piped body on an interactive terminal — fail fast instead of
      // blocking on a stdin read the user did not intend.
      process.stderr.write(
        "harness error: body is required; pass --body, --body-file, or pipe stdin\n",
      );
      process.exit(1);
    } else {
      body = readFileSync(0, "utf8"); // stdin
    }
    const handle = openManagedDb({ dbPath: harnessPaths(getHarnessRoot()).dbPath });
    try {
      runMigrations(handle.db);
      const result = recordOperationalKnowledge(handle.db, {
        title: String(raw.title),
        body,
        kind: String(raw.kind),
        tags: raw.tag as string[],
        actor: String(raw.actor),
        ...(typeof raw.key === "string" ? { key: raw.key } : {}),
        ...(typeof raw.project === "string" ? { projectId: raw.project } : {}),
        ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
        ...(typeof raw.domain === "string" ? { domain: raw.domain } : {}),
      });
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(result, null, 2)}\n`
          : `knowledge ops add: ${result.entryId} version=${result.version}` +
              `${result.reusedExisting ? " (unchanged)" : ""}\n`,
      );
    } catch (e) {
      if (e instanceof OperationalKnowledgeError) {
        process.stderr.write(`harness error: ${e.message}\n`);
        process.exit(1);
      }
      throw e;
    } finally {
      handle.close();
    }
  });

knowledgeOpsCmd
  .command("list")
  .description("list operational knowledge entries")
  .option("--project <id>", "scope to a project (portable entries still shown)")
  .option("--repo-id <id>", "scope to a repo (portable entries still shown)")
  .option("--domain <domain>", "scope to a domain")
  .option("--include-deprecated", "include deprecated entries", false)
  .option("--json", "emit JSON instead of text", false)
  .action((raw: Record<string, unknown>) => {
    const handle = openManagedDb({
      dbPath: harnessPaths(getHarnessRoot()).dbPath,
      readonly: true,
    });
    try {
      const entries = listOperationalKnowledge(handle.db, {
        includeDeprecated: raw.includeDeprecated === true,
        ...(typeof raw.project === "string" ? { projectId: raw.project } : {}),
        ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
        ...(typeof raw.domain === "string" ? { domain: raw.domain } : {}),
      });
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify({ entries }, null, 2)}\n`);
        return;
      }
      if (entries.length === 0) {
        process.stdout.write("(no operational knowledge)\n");
        return;
      }
      for (const e of entries) {
        const scopeParts = [
          e.projectId !== null ? `project=${e.projectId}` : null,
          e.repoId !== null ? `repo=${e.repoId}` : null,
          e.domain !== null ? `domain=${e.domain}` : null,
        ].filter((p): p is string => p !== null);
        const scope = scopeParts.length > 0 ? scopeParts.join(" ") : "portable";
        const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
        process.stdout.write(
          `${e.entryId}\t${e.kind}\t${scope}\t${e.title}${tags}\n`,
        );
      }
    } finally {
      handle.close();
    }
  });

knowledgeOpsCmd
  .command("show")
  .description("show an operational knowledge entry")
  .argument("<entry-id>", "operational entry id (ops/...)")
  .option("--json", "emit JSON instead of markdown", false)
  .action((entryId: string, raw: Record<string, unknown>) => {
    const handle = openManagedDb({
      dbPath: harnessPaths(getHarnessRoot()).dbPath,
      readonly: true,
    });
    try {
      const entry = getOperationalKnowledge(handle.db, entryId);
      if (entry === null) {
        process.stderr.write(
          `harness error: no operational knowledge entry ${entryId}\n`,
        );
        process.exit(1);
      }
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(entry, null, 2)}\n`
          : `${entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`}`,
      );
    } finally {
      handle.close();
    }
  });

knowledgeOpsCmd
  .command("deprecate")
  .description("deprecate an operational knowledge entry (hidden from list)")
  .argument("<entry-id>", "operational entry id (ops/...)")
  .option("--actor <actor>", "actor label", "cli")
  .option("--reason <text>", "deprecation reason")
  .option("--json", "emit JSON instead of text", false)
  .action((entryId: string, raw: Record<string, unknown>) => {
    const handle = openManagedDb({ dbPath: harnessPaths(getHarnessRoot()).dbPath });
    try {
      runMigrations(handle.db);
      const result = deprecateOperationalKnowledge(handle.db, {
        entryId,
        actor: String(raw.actor),
        ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
      });
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(result, null, 2)}\n`
          : `knowledge ops deprecate: ${result.entryId}` +
              `${result.alreadyDeprecated ? " (already deprecated)" : ""}\n`,
      );
    } catch (e) {
      if (e instanceof OperationalKnowledgeError) {
        process.stderr.write(`harness error: ${e.message}\n`);
        process.exit(1);
      }
      throw e;
    } finally {
      handle.close();
    }
  });

/** Default compat dir for operational knowledge files (DB-canonical → file). */
function opsKnowledgeDirOf(root: string, raw: Record<string, unknown>): string {
  if (typeof raw.dir === "string" && raw.dir !== "") return resolve(raw.dir);
  return join(root, "docs", "ops-knowledge");
}

knowledgeOpsCmd
  .command("digest")
  .description("aggregate operational knowledge (total / active / deprecated / by kind)")
  .option("--project <id>", "scope to a project (portable entries still counted)")
  .option("--repo-id <id>", "scope to a repo (portable entries still counted)")
  .option("--domain <domain>", "scope to a domain")
  .option("--json", "emit JSON instead of text", false)
  .action((raw: Record<string, unknown>) => {
    const handle = openManagedDb({
      dbPath: harnessPaths(getHarnessRoot()).dbPath,
      readonly: true,
    });
    try {
      const d = operationalKnowledgeDigest(handle.db, {
        ...(typeof raw.project === "string" ? { projectId: raw.project } : {}),
        ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
        ...(typeof raw.domain === "string" ? { domain: raw.domain } : {}),
      });
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
        return;
      }
      const kinds = Object.keys(d.byKind)
        .sort()
        .map((k) => `  ${k}: ${d.byKind[k]}`)
        .join("\n");
      process.stdout.write(
        `operational knowledge digest\n` +
          `total: ${d.total}  active: ${d.active}  deprecated: ${d.deprecated}\n` +
          `${kinds}${kinds ? "\n" : ""}`,
      );
    } finally {
      handle.close();
    }
  });

knowledgeOpsCmd
  .command("export")
  .description("export operational knowledge to docs/ops-knowledge/ (DB → file compat)")
  .option("--to-docs", "export to docs/ops-knowledge", false)
  .option("--dir <dir>", "output dir (default: HARNESS_ROOT/docs/ops-knowledge)")
  .option("--json", "emit JSON instead of text", false)
  .action(async (raw: Record<string, unknown>) => {
    if (raw.toDocs !== true) {
      process.stderr.write(
        "harness error: 'knowledge ops export' requires --to-docs\n",
      );
      process.exit(1);
    }
    const root = getHarnessRoot();
    const outDir = opsKnowledgeDirOf(root, raw);
    const handle = openManagedDb({
      dbPath: harnessPaths(root).dbPath,
      readonly: true,
    });
    try {
      const result = await exportOperationalKnowledge(handle.db, outDir);
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(result, null, 2)}\n`
          : `knowledge ops export: wrote ${result.written.length} file(s) to ${outDir}\n`,
      );
    } finally {
      handle.close();
    }
  });

knowledgeOpsCmd
  .command("import")
  .description("import operational knowledge from docs/ops-knowledge/ (file → DB, idempotent)")
  .option("--from-docs", "import from docs/ops-knowledge", false)
  .option("--dir <dir>", "input dir (default: HARNESS_ROOT/docs/ops-knowledge)")
  .option("--actor <actor>", "actor label", "db-import")
  .option("--json", "emit JSON instead of text", false)
  .action(async (raw: Record<string, unknown>) => {
    if (raw.fromDocs !== true) {
      process.stderr.write(
        "harness error: 'knowledge ops import' requires --from-docs\n",
      );
      process.exit(1);
    }
    const root = getHarnessRoot();
    const inDir = opsKnowledgeDirOf(root, raw);
    const handle = openManagedDb({ dbPath: harnessPaths(root).dbPath });
    try {
      runMigrations(handle.db);
      const result = await importOperationalKnowledge(handle.db, inDir, {
        actor: String(raw.actor),
      });
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify(result, null, 2)}\n`
          : `knowledge ops import: imported ${result.imported}` +
              `${result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ""}\n`,
      );
    } finally {
      handle.close();
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

// --- agent workspaces ----------------------------------------------------
// Isolated git worktrees so multiple LLM agents / terminals can work the same
// project concurrently without colliding on a shared checkout, while sharing
// the harness state (HARNESS_ROOT / `.harness` DB). git is the source of truth.

/** The repo a workspace command operates on (default: current directory). */
function workspaceRepoPath(raw: Record<string, unknown>): string {
  return resolve(typeof raw.repo === "string" && raw.repo !== "" ? raw.repo : process.cwd());
}

/** Default location for per-agent worktrees: a sibling `<repo>.agents/` dir. */
function workspacesDirFor(repoPath: string, raw: Record<string, unknown>): string {
  if (typeof raw.dir === "string" && raw.dir !== "") return resolve(raw.dir);
  return join(dirname(repoPath), `${basename(repoPath)}.agents`);
}

/**
 * Resolve the stable git context for a workspace command: the MAIN worktree
 * (so a subdir / symlink / worktree invocation all normalize to one location
 * that survives removing an agent worktree) plus the worktrees dir.
 */
async function resolveWorkspaceCtx(
  raw: Record<string, unknown>,
): Promise<{ repoPath: string; workspacesDir: string }> {
  const repoPath = await resolveMainWorktree({
    repoPath: workspaceRepoPath(raw),
  });
  return { repoPath, workspacesDir: workspacesDirFor(repoPath, raw) };
}

function withWorkspaceErrorExit(e: unknown): never {
  if (e instanceof AgentWorkspaceError) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

/**
 * Resolve a single agent's LIVE workspace path-first (reconciled), so the agent
 * commands (inspect / checkpoint / recover / remove) work for adopted
 * non-`agent/*` worktrees too — not just the `agent/*` convention. Returns null
 * when the agent has no live worktree.
 */
async function resolveLiveWorkspace(
  repoPath: string,
  workspacesDir: string,
  repoKey: string,
  agent: string,
): Promise<AgentWorkspace | null> {
  const rows = withWorkspaceRepo((repo) => repo.listByRepo(repoKey));
  const { live } = await reconcileWorkspaces({ repoPath, workspacesDir }, rows);
  return live.find((w) => w.agent === agent) ?? null;
}

/**
 * Run a function against the shared workspace DB index (HARNESS_ROOT/.harness).
 * git stays the source of truth for a worktree's existence; this row carries
 * the harness-side metadata (objective / advisory hitch link / heartbeat).
 */
function withWorkspaceRepo<T>(
  fn: (repo: WorkspaceRepository, db: ReturnType<typeof openManagedDb>["db"]) => T,
): T {
  const handle = openManagedDb({
    dbPath: harnessPaths(getHarnessRoot()).dbPath,
  });
  try {
    runMigrations(handle.db);
    return fn(new WorkspaceRepository(handle.db), handle.db);
  } finally {
    handle.close();
  }
}

const workspaceCmd = program
  .command("workspace")
  .description(
    "manage per-agent isolated git worktrees for concurrent multi-agent work",
  );

workspaceCmd
  .command("create")
  .description(
    "create (or return) an isolated worktree on the agent/<name> branch",
  )
  .argument("<agent>", "agent name (used as the branch suffix and directory)")
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--base <commit-ish>", "branch base for a new agent branch", "HEAD")
  .option("--dir <dir>", "where to place agent worktrees (default: <repo>.agents)")
  .option("--json", "emit JSON instead of text", false)
  .action(async (agent: string, raw: Record<string, unknown>) => {
    try {
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const ws = await createAgentWorkspace(
        { repoPath, workspacesDir },
        { agent, base: String(raw.base ?? "HEAD") },
      );
      // Track the worktree in the shared DB index (git remains the source of
      // truth for its existence; this row carries harness-side metadata). Key
      // by the canonical git identity so the same repo is one row regardless of
      // how it is reached (subdir / symlink / worktree).
      const repoKey = await canonicalRepoKey({ repoPath });
      withWorkspaceRepo((repo) =>
        repo.upsert({
          agent,
          repoPath: repoKey,
          branch: ws.branch,
          worktreePath: ws.path,
        }),
      );
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify(ws, null, 2)}\n`);
        return;
      }
      const sharedRoot = getHarnessRoot();
      process.stdout.write(
        `${ws.created ? "created" : "exists"} workspace for agent "${agent}"\n` +
          `  path:   ${ws.path}\n` +
          `  branch: ${ws.branch}\n\n` +
          `Start the agent here, sharing the harness state DB:\n` +
          `  cd ${ws.path}\n` +
          `  export HARNESS_ROOT=${sharedRoot}\n`,
      );
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("verify-pr")
  .description(
    "check out a PR head in a DETACHED (branch-free) worktree for verification, " +
      "avoiding the 'branch already used by worktree' conflict a run worktree causes (#82)",
  )
  .argument("<number>", "PR number")
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--remote <name>", "remote to fetch the PR head from", "origin")
  .option("--rm", "remove the verify worktree for this PR instead of creating it", false)
  .option("--json", "emit JSON instead of text", false)
  .action(async (number: string, raw: Record<string, unknown>) => {
    try {
      if (!/^\d+$/.test(number)) {
        throw new AgentWorkspaceError(`PR number must be a positive integer: ${number}`);
      }
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const worktreePath = join(workspacesDir, `verify-pr-${number}`, "repo");
      if (raw.rm === true) {
        await removeDetachedWorktree({ repoPath, worktreePath });
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify({ removed: worktreePath }, null, 2)}\n`
            : `removed verify worktree: ${worktreePath}\n`,
        );
        return;
      }
      // GitHub exposes a PR head at refs/pull/<n>/head on the origin remote.
      const remote = String(raw.remote ?? "origin");
      // Fetch into a PR-specific local ref (not the shared FETCH_HEAD), so two
      // concurrent verify-pr runs in the same repo cannot race — a plain
      // `rev-parse FETCH_HEAD` could read another PR's just-fetched head. `--`
      // stops git option parsing so a `--remote=--upload-pack=…` value is treated
      // as a remote name, not a git flag (argument-injection surface).
      const localRef = `refs/harness/verify-pr/${number}`;
      const fetched = await gitCli(
        ["fetch", "--", remote, `+pull/${number}/head:${localRef}`],
        { cwd: repoPath },
      );
      if (fetched.exitCode !== 0) {
        throw new AgentWorkspaceError(
          `failed to fetch pull/${number}/head from "${remote}": ${fetched.stderr.trim()}`,
        );
      }
      const rev = await gitCli(["rev-parse", localRef], { cwd: repoPath });
      if (rev.exitCode !== 0) {
        throw new AgentWorkspaceError(
          `failed to resolve fetched PR head: ${rev.stderr.trim()}`,
        );
      }
      const sha = rev.stdout.trim();
      const { path } = await createDetachedWorktree({
        repoPath,
        worktreePath,
        commitish: sha,
      });
      process.stdout.write(
        raw.json === true
          ? `${JSON.stringify({ pr: Number(number), sha, path }, null, 2)}\n`
          : `verify worktree for PR #${number} (detached at ${sha.slice(0, 12)}):\n` +
              `  path: ${path}\n\n` +
              `Inspect read-only, then remove it with:\n` +
              `  harness workspace verify-pr ${number} --rm${raw.repo !== undefined ? ` --repo ${String(raw.repo)}` : ""}\n`,
      );
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("adopt")
  .description(
    "register an EXISTING git worktree as an agent (any branch; never creates)",
  )
  .argument("<agent>", "agent name")
  .requiredOption("--worktree <path>", "path to an existing worktree of the repo")
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--json", "emit JSON instead of text", false)
  .action(async (agent: string, raw: Record<string, unknown>) => {
    try {
      const repoPath = await resolveMainWorktree({
        repoPath: workspaceRepoPath(raw),
      });
      const repoKey = await canonicalRepoKey({ repoPath });
      const ws = await adoptAgentWorkspace(
        { repoPath, workspacesDir: workspacesDirFor(repoPath, raw) },
        { agent, worktreePath: String(raw.worktree) },
      );
      withWorkspaceRepo((repo) => {
        // one-agent-per-path and one-worktree-per-agent: a collision would let
        // reconcile emit the same worktree twice or orphan an existing tree.
        const rows = repo.listByRepo(repoKey);
        const byOtherAgent = rows.find(
          (r) => r.worktreePath === ws.path && r.agent !== agent,
        );
        if (byOtherAgent !== undefined) {
          throw new AgentWorkspaceError(
            `worktree ${ws.path} is already adopted by agent "${byOtherAgent.agent}"`,
          );
        }
        const existing = rows.find((r) => r.agent === agent);
        if (existing !== undefined && existing.worktreePath !== ws.path) {
          throw new AgentWorkspaceError(
            `agent "${agent}" already has a workspace at ${existing.worktreePath}; ` +
              `remove it first or use a different agent name`,
          );
        }
        repo.upsert({
          agent,
          repoPath: repoKey,
          branch: ws.branch,
          worktreePath: ws.path,
        });
      });
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify(ws, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `adopted worktree as agent "${agent}"\n` +
          `  path:   ${ws.path}\n` +
          `  branch: ${ws.branch}\n`,
      );
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("list")
  .description("list workspaces: agent/* worktrees + adopted (any-branch)")
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--json", "emit JSON instead of text", false)
  .action(async (raw: Record<string, unknown>) => {
    try {
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const repoKey = await canonicalRepoKey({ repoPath });
      const rows = withWorkspaceRepo((repo) => repo.listByRepo(repoKey));
      // reconcile by worktree path: agent/* worktrees + adopted (any-branch) rows.
      const { live, recordByPath, stale } = await reconcileWorkspaces(
        { repoPath, workspacesDir },
        rows,
      );
      const enriched = live.map((w) => {
        // attribute by exact live path, not agent name (see reconcile docs).
        const r = recordByPath.get(normalizeWorktreePath(w.path)) ?? null;
        return {
          ...w,
          hitchId: r?.hitchId ?? null,
          objective: r?.objective ?? null,
          lastActiveAt: r?.lastActiveAt ?? null,
        };
      });
      if (raw.json === true) {
        process.stdout.write(
          `${JSON.stringify({ workspaces: enriched, stale }, null, 2)}\n`,
        );
        return;
      }
      if (enriched.length === 0 && stale.length === 0) {
        process.stdout.write("no agent workspaces\n");
        return;
      }
      for (const w of enriched) {
        const hitchTag = w.hitchId ? ` hitch=${w.hitchId}` : "";
        const obj = w.objective ? ` — ${w.objective}` : "";
        process.stdout.write(`${w.agent}\t${w.branch}\t${w.path}${hitchTag}${obj}\n`);
      }
      for (const r of stale) {
        process.stdout.write(
          `${r.agent}\t${r.branch}\t(stale: worktree missing; run 'harness workspace remove ${r.agent}' to clear)\n`,
        );
      }
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("inspect")
  .description(
    "deterministic git briefing of an agent's workspace (branch / dirty / ahead-behind)",
  )
  .argument("<agent>", "agent name")
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
  .option("--base <commit-ish>", "compare ahead/behind against this ref", "main")
  .option("--json", "emit JSON instead of text", false)
  .action(async (agent: string, raw: Record<string, unknown>) => {
    try {
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const repoKey = await canonicalRepoKey({ repoPath });
      const ws = await resolveLiveWorkspace(repoPath, workspacesDir, repoKey, agent);
      if (ws === null) {
        throw new AgentWorkspaceError(`no workspace for agent "${agent}"`);
      }
      const insp = await inspectAgentWorkspace(
        { repoPath, workspacesDir },
        { agent, base: String(raw.base ?? "main"), workspace: ws },
      );
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify(insp, null, 2)}\n`);
        return;
      }
      const aheadBehind = insp.baseResolved
        ? `${insp.ahead} ahead / ${insp.behind} behind (vs ${insp.base})`
        : `base "${insp.base}" not found`;
      const last = insp.lastCommit
        ? `${insp.lastCommit.sha.slice(0, 8)} ${insp.lastCommit.subject}`
        : "(none)";
      const dirty =
        insp.dirtyFiles.length === 0
          ? "clean"
          : `${insp.dirtyFiles.length} uncommitted: ` +
            insp.dirtyFiles.slice(0, 10).join(", ") +
            (insp.dirtyFiles.length > 10 ? ", …" : "");
      process.stdout.write(
        `workspace "${insp.agent}" (${insp.branch})\n` +
          `  path:         ${insp.path}\n` +
          `  last commit:  ${last}\n` +
          `  vs base:      ${aheadBehind}\n` +
          `  working tree: ${dirty}\n`,
      );
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("conflicts")
  .description(
    "find agent workspaces that have changed the same files (overlap pre-check)",
  )
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
  .option("--base <commit-ish>", "base ref for committed-ahead changes", "main")
  .option("--json", "emit JSON instead of text", false)
  .action(async (raw: Record<string, unknown>) => {
    try {
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const repoKey = await canonicalRepoKey({ repoPath });
      const rows = withWorkspaceRepo((repo) => repo.listByRepo(repoKey));
      const { live } = await reconcileWorkspaces(
        { repoPath, workspacesDir },
        rows,
      );
      const entries: WorkspaceChangedFiles[] = [];
      for (const w of live) {
        entries.push({
          agent: w.agent,
          files: await changedFilesForWorkspace(
            { repoPath, workspacesDir },
            { agent: w.agent, base: String(raw.base ?? "main"), workspace: w },
          ),
        });
      }
      const conflicts = findWorkspaceConflicts(entries);
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify({ conflicts }, null, 2)}\n`);
        return;
      }
      if (conflicts.length === 0) {
        process.stdout.write(
          `no overlapping changes across ${entries.length} workspace(s)\n`,
        );
        return;
      }
      for (const c of conflicts) {
        process.stdout.write(
          `${c.a} ⨯ ${c.b}: ${c.files.length} shared file(s)\n` +
            c.files.map((f) => `    ${f}`).join("\n") +
            "\n",
        );
      }
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("status")
  .description(
    "at-a-glance progress of every agent workspace (deterministic projection)",
  )
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
  .option("--base <commit-ish>", "base ref for ahead/behind", "main")
  .option(
    "--stale-after <hours>",
    "flag a workspace whose heartbeat is older than this many hours",
    "24",
  )
  .option("--json", "emit JSON instead of text", false)
  .action(async (raw: Record<string, unknown>) => {
    try {
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const repoKey = await canonicalRepoKey({ repoPath });
      const nowMs = Date.now();
      const rawStaleAfter = raw.staleAfter ?? "24";
      // reject a blank string explicitly: Number("") / Number("  ") === 0 would
      // otherwise silently flag every workspace as idle.
      const staleHours =
        typeof rawStaleAfter === "string" && rawStaleAfter.trim() === ""
          ? NaN
          : Number(rawStaleAfter);
      if (!Number.isFinite(staleHours) || staleHours < 0) {
        throw new AgentWorkspaceError(
          `--stale-after must be a non-negative number of hours (got ${JSON.stringify(raw.staleAfter)})`,
        );
      }
      // read DB facts in one short window, then CLOSE the handle before the
      // (slow) git inspections — no DB lock is held during git work.
      const handle = openManagedDb({
        dbPath: harnessPaths(getHarnessRoot()).dbPath,
      });
      let data;
      try {
        runMigrations(handle.db);
        data = readWorkspaceStatusData(handle.db, repoKey);
      } finally {
        handle.close();
      }
      const statuses = await assembleWorkspaceStatuses(
        { repoPath, workspacesDir },
        data,
        {
          base: String(raw.base ?? "main"),
          nowMs,
          staleThresholdMs: staleHours * 3_600_000,
          repoKey, // verify each worktree still belongs to this repo
        },
      );
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
        return;
      }
      if (statuses.length === 0) {
        process.stdout.write("no agent workspaces\n");
        return;
      }
      for (const s of statuses) {
        const git =
          s.git === null
            ? "worktree-missing"
            : s.git.baseResolved
              ? `+${s.git.ahead}/-${s.git.behind} ${s.git.dirtyCount}dirty`
              : `base? ${s.git.dirtyCount}dirty`;
        const hitchCol = s.hitchId ? `${s.hitchId}${s.hitchDecision ? `:${s.hitchDecision}` : ":missing"}` : "-";
        const obj = s.objective ? ` — ${s.objective}` : "";
        const active = `${s.lastActiveAt ?? "-"}${s.staleHeartbeat ? " ⚠idle" : ""}`;
        process.stdout.write(
          `${s.agent}\t${s.label}\t${git}\t${hitchCol}\t${active}${obj}\n`,
        );
      }
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("checkpoint")
  .description(
    "save an advisory checkpoint (LLM note + a deterministic state snapshot)",
  )
  .argument("<agent>", "agent name")
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
  .option("--base <commit-ish>", "base ref for the state snapshot", "main")
  .option("--note <text>", "advisory narrative (what / why / next steps)")
  .option("--hitch <hitch-id>", "link an advisory hitch to the workspace")
  .option("--objective <text>", "set the workspace's objective")
  .option("--by <actor>", "actor recorded on the checkpoint", "cli")
  .option("--json", "emit JSON instead of text", false)
  .action(async (agent: string, raw: Record<string, unknown>) => {
    try {
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const repoKey = await canonicalRepoKey({ repoPath });
      const ws = await resolveLiveWorkspace(repoPath, workspacesDir, repoKey, agent);
      if (ws === null) {
        throw new AgentWorkspaceError(
          `no workspace for agent "${agent}"; run 'harness workspace create ${agent}' first`,
        );
      }
      const insp = await inspectAgentWorkspace(
        { repoPath, workspacesDir },
        { agent, base: String(raw.base ?? "main"), workspace: ws },
      );
      const hitchId = typeof raw.hitch === "string" ? raw.hitch : null;
      const checkpoint = withWorkspaceRepo((repo) => {
        // ensure the workspace is tracked, then record the advisory checkpoint.
        const record = repo.upsert({
          agent,
          repoPath: repoKey,
          branch: ws.branch,
          worktreePath: ws.path,
        });
        if (hitchId !== null) repo.linkHitch(repoKey, agent, hitchId);
        if (typeof raw.objective === "string") {
          repo.setObjective(repoKey, agent, raw.objective);
        }
        return repo.recordCheckpoint({
          workspaceId: record.workspaceId,
          note: typeof raw.note === "string" ? raw.note : null,
          headSha: insp.head,
          dirtyCount: insp.dirtyFiles.length,
          hitchId: hitchId ?? record.hitchId,
          createdBy: String(raw.by ?? "cli"),
        });
      });
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify(checkpoint, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `checkpoint saved for agent "${agent}"\n` +
          `  head:  ${checkpoint.headSha ? checkpoint.headSha.slice(0, 8) : "(none)"}\n` +
          `  dirty: ${checkpoint.dirtyCount} file(s)\n` +
          (checkpoint.hitchId ? `  hitch: ${checkpoint.hitchId}\n` : "") +
          (checkpoint.note ? `  note:  ${checkpoint.note}\n` : ""),
      );
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("recover")
  .description(
    "reconstruct a workspace's state (git + linked hitch) and recommend next steps",
  )
  .argument("<agent>", "agent name")
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
  .option("--base <commit-ish>", "base ref for ahead/behind", "main")
  .option("--json", "emit JSON instead of text", false)
  .action(async (agent: string, raw: Record<string, unknown>) => {
    try {
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const repoKey = await canonicalRepoKey({ repoPath });
      const ws = await resolveLiveWorkspace(repoPath, workspacesDir, repoKey, agent);
      if (ws === null) {
        throw new AgentWorkspaceError(
          `no workspace for agent "${agent}"; run 'harness workspace create ${agent}' first`,
        );
      }
      const inspection = await inspectAgentWorkspace(
        { repoPath, workspacesDir },
        { agent, base: String(raw.base ?? "main"), workspace: ws },
      );
      const { objective, hitch, latestCheckpoint } = withWorkspaceRepo(
        (wsRepo, db) => {
          const record = wsRepo.get(repoKey, agent);
          const latest =
            record === null
              ? null
              : wsRepo.latestCheckpoint(record.workspaceId);
          let hitchSummary: RecoveryHitch | null = null;
          if (record?.hitchId != null) {
            const hitchRepo = new HitchRepository(db);
            // a dangling advisory link (hitch deleted) → convergence stays null.
            const exists = hitchRepo.getSession(record.hitchId) !== null;
            hitchSummary = {
              hitchId: record.hitchId,
              convergence: exists
                ? (() => {
                    const c = new ConvergenceService(hitchRepo).evaluate(
                      record.hitchId as string,
                    );
                    return {
                      decision: c.decision,
                      reason: c.reason,
                      nextActionKind: c.recommendedNextAction.kind,
                    };
                  })()
                : null,
            };
          }
          return {
            objective: record?.objective ?? null,
            hitch: hitchSummary,
            latestCheckpoint:
              latest === null
                ? null
                : {
                    note: latest.note,
                    createdAt: latest.createdAt,
                    createdBy: latest.createdBy,
                  },
          };
        },
      );
      const briefing = buildRecoveryBriefing({
        inspection,
        objective,
        hitch,
        latestCheckpoint,
      });
      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify(briefing, null, 2)}\n`);
        return;
      }
      const insp = briefing.inspection;
      const gitLine = insp.baseResolved
        ? `${insp.ahead} ahead / ${insp.behind} behind ${insp.base}, ${insp.dirtyFiles.length} uncommitted`
        : `base "${insp.base}" not found, ${insp.dirtyFiles.length} uncommitted`;
      const hitchLine =
        briefing.hitch === null
          ? "(none)"
          : briefing.hitch.convergence === null
            ? `${briefing.hitch.hitchId} (no longer exists)`
            : `${briefing.hitch.hitchId} — ${briefing.hitch.convergence.decision} (${briefing.hitch.convergence.reason})`;
      const cp = briefing.latestCheckpoint;
      process.stdout.write(
        `recover "${agent}" (${insp.branch})\n` +
          `  git:        ${gitLine}\n` +
          `  objective:  ${briefing.objective ?? "(none)"}\n` +
          `  hitch:      ${hitchLine}\n` +
          `  checkpoint: ${cp ? `${cp.createdAt} by ${cp.createdBy}${cp.note ? ` — ${cp.note}` : ""}` : "(none)"}\n` +
          `  next steps:\n` +
          briefing.nextSteps.map((s) => `    - ${s}`).join("\n") +
          "\n",
      );
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

workspaceCmd
  .command("remove")
  .description("remove an agent's worktree (and its branch)")
  .argument("<agent>", "agent name")
  .option("--repo <path>", "the project repo (default: current directory)")
  .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
  .option("--force", "discard uncommitted changes in the worktree", false)
  .option("--keep-branch", "remove the worktree but keep the agent/<name> branch", false)
  .action(async (agent: string, raw: Record<string, unknown>) => {
    try {
      // resolveWorkspaceCtx pins git ops to the MAIN worktree, so removing an
      // agent worktree (even when --repo points at it) does not pull the cwd out
      // from under the later git steps. The canonical key is also computed up
      // front so the DB cleanup runs regardless.
      const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
      const repoKey = await canonicalRepoKey({ repoPath });
      // path-first: resolve the live workspace so an adopted (non-agent/*)
      // worktree is actually removed, not just its DB row.
      const ws = await resolveLiveWorkspace(repoPath, workspacesDir, repoKey, agent);
      const res = await removeAgentWorkspace(
        { repoPath, workspacesDir },
        {
          agent,
          force: raw.force === true,
          keepBranch: raw.keepBranch === true,
          ...(ws !== null ? { workspace: ws } : {}),
        },
      );
      // Clear the DB index row too (also clears a stale row whose worktree was
      // already gone). git remains the source of truth for the worktree itself.
      const rowCleared = withWorkspaceRepo((repo) =>
        repo.remove(repoKey, agent),
      );
      process.stdout.write(
        res.removed || rowCleared
          ? `removed workspace for agent "${agent}"\n`
          : `no workspace for agent "${agent}"\n`,
      );
    } catch (e) {
      withWorkspaceErrorExit(e);
    }
  });

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
void reviewCmd;
void cleanupCmd;
void rerunCmd;
void knowledgeCmd;
