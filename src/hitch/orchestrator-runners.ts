import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openManagedDb, withManagedDb } from "../db/managed-connection.js";
import { harnessPaths } from "../config/paths.js";
import { conventionalPrTitle } from "./conventional-pr-title.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import {
  runDomainCoding,
  RunFinalizedError,
  VALIDATED_CONTINUATION_STATUSES,
  type ContinueFromSpec,
  type ContinueFromSkipReason,
  type RunDomainCodingOpts,
} from "../core/workflow-runner.js";
import type { RunStatus } from "../logging/run-log.js";
import { resolveBaseSha } from "../git/diff.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { DEFAULT_GIT_TIMEOUT_MS } from "../policy/schema.js";
import { runReviewerAgent } from "../core/reviewer-agent.js";
import { processReviewDecision } from "../core/review-processor.js";
import {
  createPullRequest,
  pushReviewedBranchForEscalation,
  type PrPublisher,
  type PrMerger,
  type PrMergeMethod,
} from "../core/pr-creator.js";
import {
  evaluateMergeGate,
  quorumSatisfiedFromRequirements,
  type MergeGateConsensus,
} from "../core/merge-gate.js";
import {
  computeAutoMergeTier,
  type AutoMergeTier,
} from "../core/automerge-tiers.js";
import { loadAutoMergeSensitivityMap } from "../core/automerge-tiers-config.js";
import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import { ReviewOverridesRepository } from "../db/repositories/review-overrides.js";
import {
  startOperation,
  succeedOperation,
  failOperation,
} from "../db/repositories/operations.js";
import type { CopilotReviewer } from "../core/copilot-reviewer.js";
import {
  runCopilotReview,
  type CopilotReviewConfig,
} from "../core/copilot-review-run.js";
import {
  REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS,
  type ConsensusSummary,
} from "../core/review-consensus.js";
import {
  HitchRepository,
  OPEN_FINDING_LIFECYCLES,
  UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
} from "./repository.js";
import {
  augmentGoalWithFailedCloseChecks,
  augmentGoalWithFailedRun,
  augmentGoalWithOpenFindings,
  type CloseCheckFailureContext,
} from "./coder-goal-context.js";
import { classifyFindingForHitch } from "./classification.js";
import { deferFindingToBacklog } from "./followups.js";
import { ConvergenceService } from "./convergence.js";
import { evaluateCloseConditions } from "./close-checks.js";
import { recordConvergenceDecisionWithStatus } from "./convergence-status.js";
import { assertHitchCanStartMutation } from "./mutation-gate.js";
import {
  importReviewProposalToHitch,
  proposalReviewerAdvisories,
  selectProcessedProposalForReviewImport,
} from "./review-integration.js";
import { runCommandCloseChecks } from "./orchestrator-close-check-runner.js";
import { dbConsensusSnapshotProvider } from "./consensus-stall-check.js";
import { nextReviewMode } from "./review-mode.js";
import type { OrchestratorRunners } from "./orchestrator-types.js";
import type {
  HitchFinding,
  HitchAttemptType,
  HitchLifecycleStatus,
  HitchCloseCondition,
  HitchReviewMode,
  HitchSession,
} from "./types.js";
import { findTransientLeaseCause } from "../workspace/db-domain-lock.js";

export { selectProcessedProposalForReviewImport } from "./review-integration.js";

const FINDING_BATCH_LIMIT = 200;

const OPEN_FINDING_LIFECYCLE_SET: ReadonlySet<HitchLifecycleStatus> = new Set(
  OPEN_FINDING_LIFECYCLES,
);
const UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET: ReadonlySet<HitchLifecycleStatus> =
  new Set(UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES);

/**
 * Thrown by `closeAndPr`'s pre-side-effect guard when the hitch is not
 * `close_ready`. It is raised BEFORE any side effect (no PR/push/merge), so a
 * caller (e.g. `hitch await-merge`) can distinguish a benign convergence DRIFT
 * from a real close/merge failure by the error TYPE rather than re-reading
 * convergence (which is racy).
 */
export class HitchNotCloseReadyError extends Error {
  constructor(
    readonly hitchId: string,
    readonly decision: string,
  ) {
    super(
      `hitch ${hitchId} is not close_ready (decision=${decision}); ` +
        `refusing to close and open a PR`,
    );
    this.name = "HitchNotCloseReadyError";
  }
}

export class HitchHasAdoptedPrError extends Error {
  constructor(readonly hitchId: string) {
    super(
      `hitch ${hitchId} has an adopted PR; adopt-pr is audit/status-only and ` +
        `adopted PRs are human-merge only. Refusing to create or auto-merge a ` +
        `PR. Use hitch close --force after the human merge to close the record.`,
    );
    this.name = "HitchHasAdoptedPrError";
  }
}

/**
 * Lifecycle states that still demand attention (i.e. an "open" finding). A
 * finding whose scope is `unknown` and whose lifecycle is one of these must be
 * deterministically classified before the hitch can converge.
 */
/**
 * The concrete repo/run context a hitch session does not itself store. The
 * session has `repoId` / `domain` and the goal text (title/description), but
 * the on-disk repo path and base branch must be supplied by the caller. The
 * CLI resolves these from its `--repo` / `--base-branch` flags; tests pass a
 * throwaway git repo.
 */
export interface HitchRunContext {
  repoPath: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
}

export interface ProjectRuntimeDeps {
  compiledPolicy: NonNullable<RunDomainCodingOpts["compiledPolicy"]>;
  project: NonNullable<RunDomainCodingOpts["project"]>;
  projectContextPacks?: NonNullable<RunDomainCodingOpts["projectContextPacks"]>;
}

export interface OrchestratorRunnerDeps {
  dbPath: string;
  harnessRoot: string;
  createdBy: string;
  coderRunner: CodexExecRunner;
  coderCodexBinaryVersion?: string | null;
  reviewerRunner: CodexExecRunner;
  /**
   * Abort the in-flight coder/reviewer codex run (#132). Threaded to
   * `runDomainCoding` / `runReviewerAgent`, which forward it to the codex runner;
   * the course orchestrator aborts it on lease loss so the killed codex run
   * finalizes `failed-codex` (fail-closed).
   */
  signal?: AbortSignal;
  /**
   * Publisher used by `closeAndPr`. The git side is exercised with a local
   * bare remote in tests via a fake; production wires the real `gh` publisher.
   * Required for `closeAndPr` (a clear error is thrown if it is missing).
   */
  publisher?: PrPublisher;
  /**
   * Phase 3: opt-in auto-merge. Omitted (default) = auto-merge OFF — `closeAndPr`
   * only creates the PR. When present, `closeAndPr` evaluates the merge gate
   * after creating the PR and, if it passes, merges via `merger`; a hard-blocked
   * gate escalates (fail-closed); CI-not-green leaves the PR open.
   */
  autoMerge?: {
    merger: PrMerger;
    /**
     * Returns whether the PR's required checks are green FOR the expected
     * reviewed commit (a head mismatch returns false → leave the PR open).
     */
    ciStatus: (prNumber: number, expectedHeadSha: string) => Promise<boolean>;
    method?: PrMergeMethod;
    /**
     * Opt-in: fetch the PR's external review verdicts (codex GitHub App /
     * Copilot). A `CHANGES_REQUESTED` verdict is ingested ONCE as an
     * unknown-scope advisory hitch finding so the merge gate escalates
     * (fail-closed) for the operator to classify (§6: external output is
     * advisory, never auto-trusted). Approvals have NO gating effect.
     */
    reviewVerdicts?: (
      prNumber: number,
    ) => Promise<{ author: string; state: string }[]>;
    /**
     * Opt-in bounded await for external review verdicts, symmetric with the CI
     * bounded await: external reviewers (codex App / Copilot) post their verdict
     * asynchronously after the PR opens, so a one-shot orchestrate may evaluate
     * the gate before they weigh in. When set, poll `reviewVerdicts` until a
     * CHANGES_REQUESTED appears or the budget is spent. Fail-safe: a late verdict
     * is still caught by the resumable close_ready re-check on a later run.
     */
    reviewAwait?: {
      timeoutMs: number;
      intervalMs: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    };
  };
  /**
   * Best-effort Copilot PR review (opt-in; default OFF). When present,
   * `closeAndPr` requests a Copilot review after creating the PR and records
   * an audit row. The outcome is observational ONLY — it never gates close or
   * auto-merge, and any exception is swallowed (non-gating safety boundary).
   */
  copilotReview?: {
    reviewer: CopilotReviewer;
    config?: Partial<CopilotReviewConfig>;
  };
  /**
   * Resolve the repo/run context for a hitch's session. Defaults to deriving
   * the goal text from the session title/description, the repoId/domain from
   * the session, and the base branch to `main`; the repo path is taken from
   * `repoPath` below. Override for full control (e.g. project-mode runs).
   */
  resolveRunContext?: (session: HitchSession) => HitchRunContext;
  /**
   * Repo path used by the default `resolveRunContext`. Ignored when a custom
   * `resolveRunContext` is supplied.
   */
  repoPath?: string;
  /** Base branch used by the default `resolveRunContext` (default "main"). */
  baseBranch?: string;
  /**
   * Project-profile run inputs. When present, the coder runner threads these
   * through to runDomainCoding so post-diff validation uses the compiled
   * project policy rather than reloading the broader raw repo policy.
   */
  projectRuntime?: ProjectRuntimeDeps;
}

function assertProjectRuntimeComplete(
  projectRuntime: ProjectRuntimeDeps | undefined,
): void {
  if (projectRuntime === undefined) return;
  if (projectRuntime === null || typeof projectRuntime !== "object") {
    throw new Error(
      "projectRuntime must be an object with compiledPolicy and project",
    );
  }
  const runtime = projectRuntime as Partial<ProjectRuntimeDeps>;
  // Reject nullish (not just undefined): runDomainCoding treats a null
  // compiledPolicy as absent (`?? raw`), so a malformed project-runtime would
  // silently fall back to the broader raw repo policy — the exact safety
  // boundary this gate exists to close.
  if (runtime.compiledPolicy == null || runtime.project == null) {
    throw new Error(
      "project runtime deps must be passed atomically as projectRuntime " +
        "with compiledPolicy and project",
    );
  }
  const compiled = runtime.compiledPolicy as { global?: unknown; repo?: unknown };
  if (compiled.global == null || compiled.repo == null) {
    throw new Error(
      "projectRuntime.compiledPolicy must contain both global and repo policy",
    );
  }
}

function assertCoderProjectRuntime(
  deps: OrchestratorRunnerDeps,
  session: HitchSession,
): void {
  assertProjectRuntimeComplete(deps.projectRuntime);
  if (session.projectId !== null && deps.projectRuntime === undefined) {
    throw new Error(
      `hitch ${session.hitchId} is project-scoped (projectId=${session.projectId}); ` +
        "the coder runner requires compiled project policy via projectRuntime. " +
        "Raw repo policy fallback is a safety boundary violation.",
    );
  }
}

function projectRuntimeFields(
  deps: OrchestratorRunnerDeps,
): Partial<
  Pick<
    RunDomainCodingOpts,
    "compiledPolicy" | "project" | "projectContextPacks"
  >
> {
  const projectRuntime = deps.projectRuntime;
  if (projectRuntime === undefined) return {};
  return {
    compiledPolicy: projectRuntime.compiledPolicy,
    project: projectRuntime.project,
    ...(projectRuntime.projectContextPacks !== undefined
      ? { projectContextPacks: projectRuntime.projectContextPacks }
      : {}),
  };
}

function defaultGoalText(session: HitchSession): string {
  const parts = [session.title, session.description ?? ""]
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return parts.join("\n\n");
}

function resolveRunContext(
  deps: OrchestratorRunnerDeps,
  session: HitchSession,
): HitchRunContext {
  if (deps.resolveRunContext !== undefined) {
    return deps.resolveRunContext(session);
  }
  if (session.repoId === null || session.domain === null) {
    throw new Error(
      `hitch ${session.hitchId} has no repoId/domain; cannot run the coder ` +
        `(provide resolveRunContext or set the hitch's repoId+domain)`,
    );
  }
  if (deps.repoPath === undefined) {
    throw new Error(
      `hitch ${session.hitchId}: no repoPath configured for the orchestrator ` +
        `(pass deps.repoPath or deps.resolveRunContext)`,
    );
  }
  return {
    repoPath: deps.repoPath,
    repoId: session.repoId,
    domain: session.domain,
    goal: defaultGoalText(session),
    baseBranch: deps.baseBranch ?? "main",
  };
}

/** Attempt types that produce a coding run whose runId review/PR operate on. */
const CODING_ATTEMPT_TYPES = new Set<HitchAttemptType>(["implement", "rerun"]);

interface LatestCodingRun {
  runId: string;
  iteration: number;
}

/**
 * The latest run id recorded against a hitch — the run the review / pr steps
 * operate on. Attempts are ordered (iteration ASC, created_at ASC), so the
 * last CODING attempt (implement / rerun) carrying a runId is the most recent
 * run. A close-check or other attempt's runId must not be picked.
 */
export function latestRunId(repo: HitchRepository, hitchId: string): string {
  return latestCodingRun(repo, hitchId).runId;
}

function latestCodingRun(repo: HitchRepository, hitchId: string): LatestCodingRun {
  const found = latestCodingRunOrNull(repo, hitchId);
  if (found === null) {
    throw new Error(
      `hitch ${hitchId} has no recorded run yet; run the coder before reviewing`,
    );
  }
  return found;
}

function latestCodingRunOrNull(
  repo: HitchRepository,
  hitchId: string,
): LatestCodingRun | null {
  const attempts = repo.listAttempts(hitchId);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    if (typeof attempt.runId === "string" && attempt.runId !== "") {
      return { runId: attempt.runId, iteration: attempt.iteration };
    }
  }
  return null;
}

/**
 * (#163) The continuation inputs for a rerun, threaded into `runDomainCoding`.
 * `continueFrom` + `resolvedBaseSha` drive the uncommitted materialization of
 * the parent run's work; the lineage fields populate meta.json / the rerun
 * chain. When a continuation cannot be set up safely the resolver returns
 * `continueFrom: undefined` and a `skippedReason` (fail-closed → fresh run).
 */
interface ContinuationResolution {
  continueFrom?: ContinueFromSpec;
  /**
   * (#163 P2) Lineage parent — set on a materialized continuation AND on every
   * fail-closed skip that has a resolvable parent, so `runDomainCoding` records
   * the rerun chain (`parent_run_id` / dup-fence) even when materialization was
   * skipped. Absent only for `parent_run_missing` (no parent at all).
   */
  parentRunId?: string;
  resolvedBaseSha?: string;
  rootRunId?: string;
  rerunAttempt?: number;
  skippedReason?: ContinueFromSkipReason;
}

/** Minimal run-row fields the continuation resolver reads (read-only). */
interface ParentRunRow {
  runId: string;
  baseSha: string | null;
  status: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  rerunAttempt: number | null;
}

function readRunRow(
  db: Database.Database,
  runId: string,
): ParentRunRow | null {
  const r = db
    .prepare(
      "SELECT run_id, base_sha, status, parent_run_id, root_run_id, rerun_attempt " +
        "FROM runs WHERE run_id = ?",
    )
    .get(runId) as
    | {
        run_id: string;
        base_sha: string | null;
        status: string | null;
        parent_run_id: string | null;
        root_run_id: string | null;
        rerun_attempt: number | null;
      }
    | undefined;
  if (r === undefined) return null;
  return {
    runId: r.run_id,
    baseSha: r.base_sha,
    status: r.status,
    parentRunId: r.parent_run_id,
    rootRunId: r.root_run_id,
    rerunAttempt: r.rerun_attempt,
  };
}

/**
 * (#163) Derive the rerun-chain root for a parent run. Fast path: the parent
 * already records `root_run_id`. Otherwise walk `parent_run_id` links up to
 * the root — a legacy parent that itself has a parentRunId must NOT default to
 * its own runId (that would re-root a chain mid-way). A parent with no
 * parentRunId is itself the root.
 */
function deriveRootRunId(db: Database.Database, parent: ParentRunRow): string {
  if (parent.rootRunId !== null && parent.rootRunId !== "") {
    return parent.rootRunId;
  }
  if (parent.parentRunId === null || parent.parentRunId === "") {
    return parent.runId;
  }
  // Walk up parent_run_id links, bounded by the row count to avoid a cycle
  // hang (a corrupt self/loop link falls back to the deepest node reached).
  let current = parent;
  const seen = new Set<string>([current.runId]);
  for (let i = 0; i < 10_000; i++) {
    const next =
      current.parentRunId !== null && current.parentRunId !== ""
        ? readRunRow(db, current.parentRunId)
        : null;
    if (next === null) return current.runId;
    if (seen.has(next.runId)) return current.runId; // cycle guard
    if (next.rootRunId !== null && next.rootRunId !== "") return next.rootRunId;
    seen.add(next.runId);
    current = next;
  }
  return current.runId;
}

/**
 * (#163) The rerun_attempt for the NEXT child = parent depth + 1. Fast path:
 * the parent records `rerun_attempt` (its own depth) → child is `parent + 1`.
 * Otherwise the parent is a LEGACY rerun row whose `rerun_attempt` was never
 * stamped: reconstruct the parent's depth by walking `parent_run_id` links (the
 * number of ancestors), so a migrated chain keeps the correct depth instead of
 * collapsing to `0 + 1`. A run with no parentRunId is depth 0 (its child = 1).
 */
function deriveRerunAttempt(db: Database.Database, parent: ParentRunRow): number {
  if (parent.rerunAttempt !== null) {
    return parent.rerunAttempt + 1;
  }
  if (parent.parentRunId === null || parent.parentRunId === "") {
    return 1; // parent is the root (depth 0) → its first child is attempt 1.
  }
  // Count ancestors via the parent_run_id chain (bounded; cycle-guarded).
  let depth = 0;
  let current = parent;
  const seen = new Set<string>([current.runId]);
  for (let i = 0; i < 10_000; i++) {
    if (current.parentRunId === null || current.parentRunId === "") break;
    const next = readRunRow(db, current.parentRunId);
    if (next === null) break;
    if (seen.has(next.runId)) break; // cycle guard
    // a stamped ancestor pins absolute depth: parent depth = ancestor + steps.
    if (next.rerunAttempt !== null) {
      depth += next.rerunAttempt + 1;
      return depth + 1;
    }
    depth += 1;
    seen.add(next.runId);
    current = next;
  }
  // parent depth = number of ancestors walked → child = depth + 1.
  return depth + 1;
}

/**
 * (#163) Resolve the effective `limits.gitTimeoutMs` the run will use, so the
 * resolver's read-only base `git rev-parse` is bounded by the SAME timeout as
 * the run itself. Uses the compiled project policy when present (mirroring
 * `runDomainCoding`), else loads the repo policy files; any load failure falls
 * back to the harness default rather than throwing on the read-only path.
 */
async function resolveGitTimeoutMs(
  deps: OrchestratorRunnerDeps,
  context: HitchRunContext,
): Promise<number> {
  try {
    const paths = harnessPaths(deps.harnessRoot);
    const { global, repo } = deps.projectRuntime?.compiledPolicy ?? {
      global: await loadGlobalPolicy(paths.globalPolicyPath),
      repo: await loadRepoPolicy(paths.repoPolicyPath(context.repoId)),
    };
    return resolvePolicy(global, repo, context.domain).limits.gitTimeoutMs;
  } catch {
    return DEFAULT_GIT_TIMEOUT_MS;
  }
}

/**
 * (#163) Sync DB-read half of the continuation resolver. Reads the latest
 * coding run row + derives the rerun-chain root + computes the parent worktree
 * path — all read-only, inside one short-lived DB handle. Returns null when
 * there is no resolvable parent (→ fresh-from-base, `parent_run_missing`).
 */
interface ParentContinuationFacts {
  parentRunId: string;
  parentBaseSha: string;
  parentStatus: string | null;
  parentWorktreePath: string;
  rootRunId: string;
  rerunAttempt: number;
}

function readParentContinuationFacts(opts: {
  db: Database.Database;
  repo: HitchRepository;
  hitchId: string;
  harnessRoot: string;
}): ParentContinuationFacts | null {
  const latest = latestCodingRunOrNull(opts.repo, opts.hitchId);
  if (latest === null) return null;
  const parent = readRunRow(opts.db, latest.runId);
  if (parent === null || parent.baseSha === null || parent.baseSha === "") {
    return null;
  }
  return {
    parentRunId: parent.runId,
    parentBaseSha: parent.baseSha,
    parentStatus: parent.status,
    parentWorktreePath: join(
      harnessPaths(opts.harnessRoot).workspacesDir,
      parent.runId,
      "repo",
    ),
    rootRunId: deriveRootRunId(opts.db, parent),
    // (#163 P3) chain-depth aware: a legacy parent with no rerun_attempt is not
    // collapsed to `0 + 1` — its depth is reconstructed from the parent chain.
    rerunAttempt: deriveRerunAttempt(opts.db, parent),
  };
}

/**
 * (#163) Async base-gate half of the continuation resolver. GATEs on (1) the
 * parent run being POLICY-VALIDATED (a completed+passed status — see
 * `VALIDATED_CONTINUATION_STATUSES`), (2) base-equality (parent.baseSha === the
 * freshly resolved base), and (3) the parent worktree's existence. Performs NO
 * git mutation and NO DB write — only a read-only `git rev-parse` for the base
 * and a worktree-existence stat. Every ambiguity fails CLOSED to a fresh run
 * with a recorded `skippedReason`; a thrown git error maps to
 * `parent_work_unmaterializable`, never a throw.
 *
 * (#163 P2) LINEAGE is recorded on the success branch AND on every skip branch
 * with a resolvable parent — only the MATERIALIZATION is gated, never the rerun
 * chain / dup-fence audit.
 */
async function gateContinuation(opts: {
  facts: ParentContinuationFacts;
  context: HitchRunContext;
  gitTimeoutMs: number;
}): Promise<ContinuationResolution> {
  const { facts } = opts;
  // Lineage is always recorded (chain + dup-fence), regardless of whether the
  // continuation materializes or fails closed to a fresh run.
  const lineage = {
    parentRunId: facts.parentRunId,
    rootRunId: facts.rootRunId,
    rerunAttempt: facts.rerunAttempt,
  };

  // (#163 P1) Validated-parent gate: continue ONLY from a run whose status
  // proves it passed path-policy validation (safetyStatus=allowed). A failed /
  // non-validated parent (failed-policy-violation carries out-of-scope/deny
  // paths; failed-internal-error may be an un-resettable partial-carry worktree;
  // failed-codex never completed validation) must NOT be carried — a
  // fresh-from-base rerun re-derives without the forbidden/partial changes.
  if (
    facts.parentStatus === null ||
    !VALIDATED_CONTINUATION_STATUSES.has(facts.parentStatus as RunStatus)
  ) {
    return { ...lineage, skippedReason: "parent_not_validated" };
  }

  let freshBaseSha: string;
  try {
    freshBaseSha = await resolveBaseSha({
      repoPath: opts.context.repoPath,
      baseBranch: opts.context.baseBranch,
      timeoutMs: opts.gitTimeoutMs,
    });
  } catch {
    // Cannot resolve the base → cannot prove base-equality; fail closed to a
    // fresh run. We deliberately return NO `resolvedBaseSha`: `runDomainCoding`
    // then resolves its own base for a normal fresh-from-base run (the existing
    // behavior) and records the skip reason once the run row exists. This is a
    // clean no-throw skip — the resolver does not pin a base it could not
    // resolve, and introduces no throw path before the run/attempt row.
    return { ...lineage, skippedReason: "parent_work_unmaterializable" };
  }

  // Base-equality gate: the parent's work was made against parent.baseSha. If
  // the base branch advanced, carrying that work forward would diverge from
  // the new base — fail closed and let codex re-implement from the fresh base.
  if (facts.parentBaseSha !== freshBaseSha) {
    return {
      ...lineage,
      skippedReason: "base_advanced",
      resolvedBaseSha: freshBaseSha,
    };
  }

  if (!existsSync(facts.parentWorktreePath)) {
    // worktree cleaned / never created — nothing to materialize.
    return {
      ...lineage,
      skippedReason: "parent_work_unavailable",
      resolvedBaseSha: freshBaseSha,
    };
  }

  return {
    ...lineage,
    continueFrom: {
      parentRunId: facts.parentRunId,
      parentWorktreePath: facts.parentWorktreePath,
    },
    resolvedBaseSha: freshBaseSha,
  };
}

// Exported for unit tests: the safety boundary "only short-circuit a run that
// is approved" must be pinned directly. A changes_requested / rejected decided
// run must NOT short-circuit and must NOT append a close-check. Exercising this
// through `review()` would require an on-disk reviewer fixture; the helper is a
// deterministic DB-only function, so it is the precise unit under test.
export function tryShortCircuitApprovedDecidedReview(input: {
  db: Database.Database;
  hitchId: string;
  runId: string;
  createdBy: string;
}): { runId: string; decision: "approved" } | null {
  const run = input.db
    .prepare("SELECT status FROM runs WHERE run_id = ?")
    .get(input.runId) as { status: string } | undefined;
  if (run?.status !== "approved") return null;

  // Gate on the run's DB-canonical decision (review_decisions), NOT the latest
  // individual proposal. In consensus mode the latest processed proposal can be
  // a non-approving member while the aggregated run decision is approved; gating
  // on the proposal would miss it and fall through to a re-review that escalates
  // an already-approved run (codex review). The canonical reviewer / source SHA
  // also come from here, so the refreshed evidence describes the decision, not
  // one member proposal.
  const decisionRow = input.db
    .prepare(
      "SELECT decision, reviewer, source_sha256 FROM review_decisions WHERE run_id = ?",
    )
    .get(input.runId) as
    | { decision: string; reviewer: string | null; source_sha256: string }
    | undefined;
  if (decisionRow?.decision !== "approved") return null;

  const repo = new HitchRepository(input.db);
  const session = repo.requireSession(input.hitchId);
  const reviewConditions = session.closeConditions.filter(
    (condition) => condition.kind === "review_consensus",
  );
  if (reviewConditions.length === 0) return null;

  // This path is ONLY an idempotent refresh of an already-completed review
  // import. Require a COMPLETED review cycle for this run: a cycle row is
  // persisted BEFORE its findings are imported and withManagedDb is not
  // transactional, so a crash mid-import leaves an incomplete cycle whose
  // findings / advisories / required follow-ups were never folded in. If no
  // completed import exists (never imported, or a crashed partial), fail-closed
  // and escalate rather than record a passed close-check that could close the
  // hitch without its findings (codex review).
  const completedImport = repo
    .listReviewCycles(input.hitchId)
    .some(
      (cycle) =>
        cycle.sourceRunId === input.runId && cycle.completedAt !== null,
    );
  if (!completedImport) {
    throw new Error(
      `approved run ${input.runId} has no completed review import; refusing ` +
        `to short-circuit close (a crashed/partial review import must be ` +
        `re-reviewed or resolved by an operator)`,
    );
  }

  // Supplementary proposal fields (proposalId, advisories) for traceability;
  // the authoritative decision/reviewer/source come from review_decisions.
  const proposal = new ReviewProposalRepository(
    input.db,
  ).getLatestProcessedProposal(input.runId);
  const advisories =
    proposal !== null ? proposalReviewerAdvisories(proposal) : [];
  const checkedAt = new Date().toISOString();
  for (const condition of reviewConditions) {
    repo.recordCloseCheck({
      hitchId: input.hitchId,
      conditionId: condition.id,
      status: "passed",
      checkedBy: decisionRow.reviewer ?? proposal?.reviewer ?? "review",
      checkedAt,
      evidence: {
        runId: input.runId,
        decision: "approved",
        processStatus: "approved",
        sourceSha256: decisionRow.source_sha256,
        reviewConsensusSemantics: REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS,
        idempotentRedrive: true,
        ...(proposal !== null
          ? {
              proposalId: proposal.proposalId,
              reviewDecisionId: proposal.reviewDecisionId,
            }
          : {}),
        ...(advisories.length > 0 ? { reviewerAdvisories: advisories } : {}),
      },
      message:
        "review consensus approved the run (static pass; tests not executed by review_consensus)",
    });
  }

  // Do NOT escalate here when other required conditions are still pending.
  // After refreshing the review_consensus evidence, let convergence re-evaluate
  // and route the remaining pending conditions deterministically: a pending
  // command close-check → run_close_check (auto-run), non-command/external
  // evidence (manual/artifact/operation) → operator wait (ask_human). Throwing
  // here would mis-escalate an auto-satisfiable command close-check (#184).
  const convergence = new ConvergenceService(repo).evaluate(input.hitchId);
  recordConvergenceDecisionWithStatus({
    repository: repo,
    hitchId: input.hitchId,
    decision: convergence.decision,
    reason: convergence.reason,
    metrics: { ...convergence.metrics },
    recommendedNextAction: convergence.recommendedNextAction,
    createdBy: input.createdBy,
  });

  return { runId: input.runId, decision: "approved" };
}

function closeConditionLabel(condition: HitchCloseCondition): string {
  return condition.description === undefined ||
    condition.description.trim() === ""
    ? condition.id
    : `${condition.id} (${condition.description})`;
}

function closeCheckFreshAfter(
  repo: HitchRepository,
  hitchId: string,
): string | null {
  const timestamps: string[] = [];
  for (const attempt of repo.listAttempts(hitchId)) {
    if (attempt.attemptType === "close-check") continue;
    timestamps.push(attempt.completedAt ?? attempt.startedAt ?? attempt.createdAt);
  }
  const latestFindingMutationAt = repo.latestFindingMutationAt(hitchId);
  if (latestFindingMutationAt !== null) {
    timestamps.push(latestFindingMutationAt);
  }
  for (const cycle of repo.listReviewCycles(hitchId)) {
    timestamps.push(cycle.completedAt ?? cycle.createdAt);
  }
  return timestamps.reduce<string | null>(
    (latest, timestamp) =>
      latest === null || timestamp > latest ? timestamp : latest,
    null,
  );
}

function stringEvidence(
  evidence: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = evidence[key];
  return typeof value === "string" ? value : undefined;
}

function numberEvidence(
  evidence: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = evidence[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanEvidence(
  evidence: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = evidence[key];
  return typeof value === "boolean" ? value : undefined;
}

function failedRequiredCloseChecks(
  repo: HitchRepository,
  session: HitchSession,
): CloseCheckFailureContext[] {
  const close = evaluateCloseConditions({
    conditions: session.closeConditions,
    checks: repo.listCloseChecks(session.hitchId),
    findingCounts: repo.countFindingSummary(session.hitchId),
    freshAfter: closeCheckFreshAfter(repo, session.hitchId),
    allowEmptyCloseConditions: session.policy.allowEmptyCloseConditions,
  });
  return close.conditions
    .filter(
      (evaluated) =>
        evaluated.condition.required &&
        evaluated.status === "failed" &&
        evaluated.check !== null,
    )
    .map((evaluated) => {
      const evidence = evaluated.check?.evidence ?? {};
      const description = evaluated.condition.description;
      const command = stringEvidence(evidence, "command");
      const exitCode = numberEvidence(evidence, "exitCode");
      const timedOut = booleanEvidence(evidence, "timedOut");
      const message = evaluated.check?.message ?? undefined;
      const stdout =
        stringEvidence(evidence, "stdoutTail") ??
        stringEvidence(evidence, "stdout");
      const stderr =
        stringEvidence(evidence, "stderrTail") ??
        stringEvidence(evidence, "stderr");
      const stdoutPath = stringEvidence(evidence, "stdoutPath");
      const stderrPath = stringEvidence(evidence, "stderrPath");
      return {
        conditionId: evaluated.condition.id,
        conditionKind: evaluated.condition.kind,
        ...(description !== undefined ? { description } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(timedOut !== undefined ? { timedOut } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(stdout !== undefined ? { stdout } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
        ...(stdoutPath !== undefined ? { stdoutPath } : {}),
        ...(stderrPath !== undefined ? { stderrPath } : {}),
      };
    });
}

function reviewModeForHitch(
  repo: HitchRepository,
  session: HitchSession,
): HitchReviewMode {
  return nextReviewMode(session, repo.listReviewCycles(session.hitchId));
}

function isUnresolvedOutOfScopeFinding(finding: HitchFinding): boolean {
  return (
    finding.scopeStatus === "out_of_scope" &&
    UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET.has(finding.lifecycleStatus)
  );
}

export function createOrchestratorRunners(
  deps: OrchestratorRunnerDeps,
): OrchestratorRunners {
  assertProjectRuntimeComplete(deps.projectRuntime);
  const paths = harnessPaths(deps.harnessRoot);
  const assertGate = (
    hitchId: string,
    mutationKind: "run.start" | "review.auto",
  ): void => {
    withManagedDb({ dbPath: deps.dbPath }, (db) => {
      assertHitchCanStartMutation({
        repository: new HitchRepository(db),
        hitchId,
        mutationKind,
        syncCreatedBy: deps.createdBy,
      });
    });
  };

  return {
    coder: async (hitchId) => {
      assertGate(hitchId, "run.start");
      const { attemptId, context, goalText, parentFacts, isRerun } = withManagedDb(
        { dbPath: deps.dbPath },
        (db) => {
          const repo = new HitchRepository(db);
          const s = repo.requireSession(hitchId);
          assertCoderProjectRuntime(deps, s);
          const ctx = resolveRunContext(deps, s);
          // a hitch that already has a coding attempt is iterating on review
          // feedback → "rerun"; the first pass is "implement".
          const codingAttempts = repo
            .listAttempts(hitchId)
            .filter(
              (a) =>
                a.attemptType === "implement" || a.attemptType === "rerun",
            );
          const prior = codingAttempts.length > 0;
          // (#163) On a rerun, gather the read-only facts needed to CONTINUE the
          // parent run's work (parent run row + chain root + worktree path) in
          // this same DB read. The async base-equality gate runs AFTER the DB
          // handle closes (no async work under withManagedDb). The first
          // `implement` pass has no parent → no continuation.
          const facts = prior
            ? readParentContinuationFacts({
                db,
                repo,
                hitchId,
                harnessRoot: deps.harnessRoot,
              })
            : null;
          // If the most recent coding run failed before review, this is a
          // recovery rerun — inject the failed run status so the coder fixes the
          // cause rather than re-coding blind (convergence routes here).
          const latestCoding = codingAttempts[codingAttempts.length - 1];
          const failedRunStatus =
            latestCoding?.status === "failed"
              ? String(
                  (latestCoding.result as { runStatus?: unknown } | undefined)
                    ?.runStatus ?? "failed",
                )
              : "";
          // On a rerun, inject the open in-scope findings review raised into the
          // coder goal so it knows what to fix (the hitch-mode analogue of the
          // run-level required_changes injection). The first `implement` pass
          // has none. unknown-scope findings are intentionally excluded — they
          // must be classified first (fail-closed).
          const openInScope = prior
            ? repo
                .listFindings({ hitchId, scopeStatus: "in_scope", limit: 200 })
                .filter((fnd) =>
                  OPEN_FINDING_LIFECYCLE_SET.has(fnd.lifecycleStatus),
                )
            : [];
          const closeCheckFailures = prior
            ? failedRequiredCloseChecks(repo, s)
            : [];
          const attempt = repo.createAttempt({
            hitchId,
            attemptType: prior ? "rerun" : "implement",
            status: "running",
          });
          return {
            attemptId: attempt.attemptId,
            context: ctx,
            parentFacts: facts,
            isRerun: prior,
            goalText: augmentGoalWithFailedRun(
              augmentGoalWithFailedCloseChecks(
                augmentGoalWithOpenFindings(ctx.goal, openInScope),
                closeCheckFailures,
              ),
              failedRunStatus,
            ),
          };
        },
      );
      // (#163) Resolve the continuation OUTSIDE the DB handle: the base-equality
      // gate does a read-only `git rev-parse` (async). A skipped/absent
      // continuation → fresh-from-base (the runDomainCoding default); no throw,
      // no escalation. `runDomainCoding` records the skip reason as a run event.
      const continuation: ContinuationResolution =
        parentFacts !== null
          ? await gateContinuation({
              facts: parentFacts,
              context,
              gitTimeoutMs: await resolveGitTimeoutMs(deps, context),
            })
          : isRerun
            ? // a rerun with no resolvable parent run row: fail closed and record
              // why (the run still proceeds fresh-from-base).
              { skippedReason: "parent_run_missing" }
            : {};
      try {
        const result = await runDomainCoding({
          harnessRoot: deps.harnessRoot,
          repoPath: context.repoPath,
          repoId: context.repoId,
          domain: context.domain,
          goal: goalText,
          baseBranch: context.baseBranch,
          codexRunner: deps.coderRunner,
          codexBinaryVersion: deps.coderCodexBinaryVersion ?? null,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          ...projectRuntimeFields(deps),
          // (#163) Continuation: when the gate passed, carry the parent run's
          // uncommitted work into this run's worktree and pin the gate-validated
          // base; the lineage fields populate meta.json + the rerun chain.
          ...(continuation.continueFrom !== undefined
            ? { continueFrom: continuation.continueFrom }
            : {}),
          ...(continuation.resolvedBaseSha !== undefined
            ? { resolvedBaseSha: continuation.resolvedBaseSha }
            : {}),
          // (#163 P2) lineage (parent_run_id + dup-fence) is forwarded for a
          // rerun whether or not materialization happened — only the carry is
          // gated, not the chain/audit. A skipped continuation must still record
          // its real parent (never become a new root) and be fenced to one child.
          ...(continuation.parentRunId !== undefined
            ? { continuationParentRunId: continuation.parentRunId }
            : {}),
          ...(continuation.rootRunId !== undefined
            ? { rootRunId: continuation.rootRunId }
            : {}),
          ...(continuation.rerunAttempt !== undefined
            ? { rerunAttempt: continuation.rerunAttempt }
            : {}),
          ...(continuation.skippedReason !== undefined
            ? { continueFromSkipped: continuation.skippedReason }
            : {}),
        });
        const succeeded = result.status === "needs_review";
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new HitchRepository(db).completeAttempt({
            attemptId,
            status: succeeded ? "succeeded" : "failed",
            runId: result.runId,
            result: {
              runStatus: result.status,
              safetyStatus: result.safetyStatus,
            },
          });
        });
        return { runId: result.runId, runStatus: result.status };
      } catch (e) {
        const transientLeaseError = findTransientLeaseCause(e);
        if (transientLeaseError !== undefined) {
          try {
            withManagedDb({ dbPath: deps.dbPath }, (db) => {
              new HitchRepository(db).discardAttempt(attemptId);
            });
          } catch {
            // Preserve the original transient lock/lease error. A cleanup race
            // must not convert a fail-closed retry condition into escalation.
          }
          throw transientLeaseError;
        }
        // a finalized run still produced a runId — record the failed attempt
        // so convergence can see the budget was spent.
        const runId =
          e instanceof RunFinalizedError ? e.runId : undefined;
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new HitchRepository(db).completeAttempt({
            attemptId,
            status: "failed",
            ...(runId !== undefined ? { runId } : {}),
            errorMessage: (e as Error).message,
          });
        });
        throw e;
      }
    },
    review: async (hitchId) => {
      assertGate(hitchId, "review.auto");
      const runId = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        latestRunId(new HitchRepository(db), hitchId),
      );
      const decided = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        tryShortCircuitApprovedDecidedReview({
          db,
          hitchId,
          runId,
          createdBy: deps.createdBy,
        }),
      );
      if (decided !== null) return decided;

      // 1. produce a review proposal (review_proposals row) for the run.
      const reviewResult = await runReviewerAgent({
        runsDir: paths.runsDir,
        runId,
        dbPath: deps.dbPath,
        codexRunner: deps.reviewerRunner,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      // 2. promote the proposal to the run's status (approved / ...).
      const processed = await processReviewDecision({
        runsDir: paths.runsDir,
        runId,
        locksDir: paths.locksDir,
        dbPath: deps.dbPath,
      });

      // 3. fold the processed proposal into the hitch: a review cycle, any
      //    findings it carried, and the `review_consensus` close-check that
      //    lets convergence advance toward close.
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new HitchRepository(db);
        const session = repo.requireSession(hitchId);
        const proposal = selectProcessedProposalForReviewImport({ db, runId });
        if (proposal === null) {
          // no DB proposal (should not happen on the db-first path) — still
          // record an empty cycle so the budget reflects the review.
          const cycle = repo.startReviewCycle({
            hitchId,
            reviewMode: reviewModeForHitch(repo, session),
            sourceRunId: runId,
          });
          repo.completeReviewCycle({
            cycleId: cycle.cycleId,
            summary: `decision=${processed.newStatus}`,
          });
          return;
        }
        importReviewProposalToHitch({
          repository: repo,
          hitchId,
          proposal,
          processResult: processed,
          createdBy: deps.createdBy,
          // Phase 2-3: escalate if the consensus for this hitch's review runs
          // is stuck (long pending / no progress). No-op for the common
          // single-reviewer, decisive-verdict flow.
          consensusStall: { provider: dbConsensusSnapshotProvider(db) },
        });
      });
      return { runId, decision: reviewResult.decision };
    },
    closeCheck: async (hitchId) =>
      runCommandCloseChecks({
        deps,
        hitchId,
        resolveContext: (session) => {
          assertCoderProjectRuntime(deps, session);
          return resolveRunContext(deps, session);
        },
      }),
    classify: async (hitchId) =>
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new HitchRepository(db);
        const session = repo.requireSession(hitchId);
        const filter = {
          hitchId,
          scopeStatus: "unknown" as const,
          lifecycleStatusIn: OPEN_FINDING_LIFECYCLES,
        };
        let previousRemaining = repo.countFindings(filter);
        while (true) {
          const batch = repo.listFindings({
            ...filter,
            limit: FINDING_BATCH_LIMIT,
          });
          if (batch.length === 0) break;

          for (const finding of batch) {
            const classification = classifyFindingForHitch(session, finding);
            if (classification.scopeStatus === "unknown") {
              return {
                resolved: false,
                escalateReason: `cannot classify finding ${finding.findingId}`,
              };
            }
            repo.classifyFinding({
              findingId: finding.findingId,
              scopeStatus: classification.scopeStatus,
              reason: classification.reason,
            });
          }

          const remaining = repo.countFindings(filter);
          if (remaining === 0) return { resolved: true };
          if (remaining >= previousRemaining) {
            return {
              resolved: false,
              escalateReason:
                `classification made no progress for hitch ${hitchId}; ` +
                `${remaining} unknown findings remain`,
            };
          }
          previousRemaining = remaining;
        }
        const remaining = repo.countFindings(filter);
        if (remaining === 0) return { resolved: true };
        return {
          resolved: false,
          escalateReason:
            `classification did not drain hitch ${hitchId}; ` +
            `${remaining} unknown findings remain`,
        };
      }),
    defer: async (hitchId) => {
      // No mutation gate: deferral is a hitch-repo bookkeeping op (moving an
      // out-of-scope follow-up to the backlog), not a workspace mutation.
      // `deferFindingToBacklog` opens its own managed db for the backlog write,
      // so collect the finding ids under one open, close it, then loop the
      // async defers each with a fresh repo to avoid a same-dbPath lock clash.
      const filter = {
        hitchId,
        scopeStatus: "out_of_scope" as const,
        lifecycleStatusIn: UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
      };
      let deferred = 0;
      let previousRemaining = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        new HitchRepository(db).countFindings(filter),
      );
      while (true) {
        const findingIds = withManagedDb({ dbPath: deps.dbPath }, (db) => {
          const repo = new HitchRepository(db);
          return repo
            .listFindings({ ...filter, limit: FINDING_BATCH_LIMIT })
            .map((f) => f.findingId);
        });
        if (findingIds.length === 0) break;

        let batchDeferred = 0;
        for (const findingId of findingIds) {
          const { db, close } = openManagedDb({ dbPath: deps.dbPath });
          try {
            const result = await deferFindingToBacklog({
              repository: new HitchRepository(db),
              findingId,
              reason:
                "auto-deferred by orchestrator (out-of-scope follow-up)",
              createBacklogItem: true,
              backlogContext: {
                backlogDir: paths.backlogDir,
                dbPath: deps.dbPath,
              },
            });
            if (
              result.finding.lifecycleStatus === "deferred" &&
              !isUnresolvedOutOfScopeFinding(result.finding)
            ) {
              batchDeferred += 1;
            }
          } finally {
            close();
          }
        }
        deferred += batchDeferred;

        const remaining = withManagedDb({ dbPath: deps.dbPath }, (db) =>
          new HitchRepository(db).countFindings(filter),
        );
        if (remaining === 0) return { deferred };
        if (batchDeferred === 0 || remaining >= previousRemaining) {
          return { deferred };
        }
        previousRemaining = remaining;
      }
      // Loop only breaks when the unresolved out-of-scope set is empty, so
      // `deferred` already reflects every finding that reached the backlog.
      return { deferred };
    },
    closeAndPr: async (hitchId) => {
      // No mutation gate here: closeAndPr is only dispatched on a
      // `close_ready` convergence decision, which deliberately denies
      // run.start/review. Closing + PR is the terminal step, not a run.
      if (deps.publisher === undefined) {
        throw new Error(
          "closeAndPr requires a publisher in OrchestratorRunnerDeps",
        );
      }
      const { runId, base, repoPath, prTitle } = withManagedDb(
        { dbPath: deps.dbPath },
        (db) => {
          const repo = new HitchRepository(db);
          const session = repo.requireSession(hitchId);
          // Safety boundary (#169): an operator-adopted PR is audit/status-only
          // and human-merge only. The merge execution path is shared by
          // closeAndPr / orchestrate --auto-merge / await-merge, so the guard
          // must live here — before any PR create/reuse/merge side effect —
          // not only on the await-merge CLI. Fail closed: never let the harness
          // create or auto-merge a PR for a hitch whose record points at an
          // adopted (externally verified) PR.
          if (repo.hasAdoptedPr(hitchId)) {
            throw new HitchHasAdoptedPrError(hitchId);
          }
          // Defense in depth: closeAndPr must only ever run on a hitch whose
          // convergence is `close_ready`. The orchestrator dispatch already
          // guarantees this, but a direct caller (or a future code path) must
          // not be able to close a non-ready hitch — fail closed.
          const convergence = new ConvergenceService(repo).evaluate(hitchId);
          if (convergence.decision !== "close_ready") {
            throw new HitchNotCloseReadyError(hitchId, convergence.decision);
          }
          const context = resolveRunContext(deps, session);
          const rid = latestRunId(repo, hitchId);
          return {
            runId: rid,
            base: context.baseBranch,
            repoPath: context.repoPath,
            // #103 — Conventional-Commit title derived from the hitch title so
            // release-please picks the squash commit up.
            prTitle: conventionalPrTitle({
              hitchTitle: session.title ?? "",
              runId: rid,
            }),
          };
        },
      );

      // Phase 3: when auto-merge is enabled, preflight the APPROVAL portion of
      // the merge gate (close-ready ∧ consensus approved w/ quorum, or human
      // override) BEFORE creating a non-draft PR. If it is hard-blocked, the PR
      // (which would be ready/mergeable) is never created — escalate instead.
      // CI is not part of the preflight (it needs the PR to exist).
      if (deps.autoMerge !== undefined) {
        const preflight = withManagedDb({ dbPath: deps.dbPath }, (db) => {
          const repo = new HitchRepository(db);
          const closeReady =
            new ConvergenceService(repo).evaluate(hitchId).decision === "close_ready";
          const { consensus, humanApproved } = gatherApproval(db, runId);
          return evaluateMergeGate({
            autoMergeEnabled: true,
            closeReady,
            consensus,
            humanApproved,
            ciGreen: true, // CI is checked after the PR exists
            tierEligible:
              effectiveAutoMergeTier(db, runId, deps.harnessRoot) === 0,
          });
        });
        if (preflight.hardBlocked) {
          // Return escalateReason only; the orchestrator performs the
          // escalated status transition (consistent with runAutoMerge).
          return {
            prUrl: "",
            draft: false,
            escalateReason: `auto-merge preflight hard-blocked: ${preflight.blockers.join(", ")}`,
          };
        }
      }

      // Create the PR FIRST. A PR failure must NOT leave a permanently-closed
      // hitch with no PR, so the close is the last side effect.
      const pr = await createPullRequest({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        runId,
        base,
        title: prTitle,
        // A draft PR cannot be merged; when auto-merge is enabled the PR must be
        // ready so `gh pr merge` can complete. Otherwise keep the safe default
        // (draft) so a human opens it.
        draft: deps.autoMerge === undefined,
        publisher: deps.publisher,
        dbPath: deps.dbPath,
      });

      // Best-effort Copilot review (opt-in). Observational only: it NEVER
      // gates close/merge, and ANY failure (including an unexpected throw) is
      // swallowed — the hitch proceeds regardless (existing safety boundary:
      // external output must not drive a state transition).
      if (deps.copilotReview !== undefined) {
        try {
          // Capture the start before the review runs so the audit `started_at`
          // reflects when the work began (the DB write happens after, contrast
          // with auto-merge which starts its operation before the external work).
          const startedAt = new Date();
          const outcome = await runCopilotReview({
            reviewer: deps.copilotReview.reviewer,
            prNumber: pr.prNumber,
            ...(deps.copilotReview.config !== undefined
              ? { config: deps.copilotReview.config }
              : {}),
          });
          withManagedDb({ dbPath: deps.dbPath }, (db) => {
            const operationId = `op-${randomUUID()}`;
            startOperation(db, {
              operationId,
              operationType: "copilot-review",
              targetType: "pr",
              targetId: String(pr.prNumber),
              actor: deps.createdBy,
              dryRun: false,
              input: { hitchId, prNumber: pr.prNumber },
              now: startedAt,
            });
            if (outcome.status === "failed") {
              failOperation(
                db,
                operationId,
                "copilot_review_failed",
                outcome.detail,
              );
            } else {
              // reviewed | skipped are terminal best-effort outcomes (the result
              // JSON's `status` distinguishes them). `pending` would be misread
              // as deferred work and flagged stale by the doctor.
              succeedOperation(db, operationId, outcome);
            }
          });
        } catch {
          // non-gating: a Copilot review failure must never break close/merge.
        }
      }

      // Phase 3: opt-in auto-merge after the PR exists. Default OFF.
      if (deps.autoMerge !== undefined) {
        const outcome = await runAutoMerge(
          deps,
          hitchId,
          runId,
          repoPath,
          pr.prNumber,
          pr.headSha,
        );
        if (outcome.escalateReason !== undefined) {
          return {
            prUrl: pr.prUrl,
            draft: pr.draft,
            escalateReason: outcome.escalateReason,
          };
        }
        // merged → closed. A CI-not-green transient (recheckable) leaves the
        // hitch `close_ready` with the PR open: a later `hitch orchestrate`
        // re-enters closeAndPr (idempotent PR + a fresh gate evaluation) and
        // merges once CI is green — the resumable "later merge" path, no new
        // status / migration needed. Any other transient (e.g. tier-not-eligible)
        // is permanent for a re-check, so the hitch closes for a human merge.
        const nextStatus = outcome.merged
          ? "closed"
          : outcome.recheckable === true
            ? "close_ready"
            : "closed";
        const summary = outcome.merged
          ? "hitch converged; PR merged"
          : outcome.recheckable === true
            ? "PR open; awaiting CI — re-run orchestrate to merge"
            : "hitch converged; PR opened";
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new HitchRepository(db).updateStatus(hitchId, nextStatus, summary, {
            createdBy: deps.createdBy,
          });
        });
        return { prUrl: pr.prUrl, draft: pr.draft, merged: outcome.merged };
      }

      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        new HitchRepository(db).updateStatus(
          hitchId,
          "closed",
          "hitch converged; PR opened",
          { createdBy: deps.createdBy },
        );
      });
      return { prUrl: pr.prUrl, draft: pr.draft, merged: false };
    },
    salvageReviewBranch: async (hitchId) => {
      const runId = withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const rid = latestRunId(new HitchRepository(db), hitchId);
        const run = db
          .prepare("SELECT status FROM runs WHERE run_id = ?")
          .get(rid) as { status: string } | undefined;
        return run !== undefined && run.status !== "needs_review"
          ? null
          : rid;
      });
      if (runId === null) return null;
      return pushReviewedBranchForEscalation({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        runId,
        dbPath: deps.dbPath,
      });
    },
  };
}

/**
 * Phase 3: evaluate the merge gate for a freshly-created PR and, if it passes,
 * merge (recording an operation-audit row). A hard-blocked gate returns an
 * escalateReason (fail-closed: do NOT merge, do NOT close). CI-not-green
 * returns `{ merged: false }` so the caller closes the hitch and leaves the PR
 * open for a later merge.
 */
async function runAutoMerge(
  deps: OrchestratorRunnerDeps,
  hitchId: string,
  runId: string,
  repoPath: string,
  prNumber: number,
  reviewedHeadSha: string | undefined,
): Promise<{ merged: boolean; escalateReason?: string; recheckable?: boolean }> {
  const autoMerge = deps.autoMerge!;
  // The merge is pinned to the REVIEWED commit (the SHA createPullRequest
  // committed + pushed after the fingerprint check), never the PR's later
  // head. Without it we cannot prove the merge target was reviewed → escalate.
  if (reviewedHeadSha === undefined) {
    return {
      merged: false,
      escalateReason: `auto-merge: reviewed head commit for PR #${prNumber} is unknown`,
    };
  }
  const expectedHeadSha = reviewedHeadSha;
  // Advisory ingestion of external review verdicts (opt-in). A
  // CHANGES_REQUESTED verdict becomes an unknown-scope finding, which makes the
  // close-readiness re-eval below fail → the gate escalates for the operator to
  // classify (fail-closed; external approvals are never trusted to merge).
  await ingestExternalReviewVerdicts(deps, hitchId, prNumber);
  const tier = withManagedDb({ dbPath: deps.dbPath }, (db) =>
    effectiveAutoMergeTier(db, runId, deps.harnessRoot),
  );
  const tierEligible = tier === 0;
  const ciGreen = tierEligible
    ? await autoMerge.ciStatus(prNumber, expectedHeadSha)
    : true;
  const gate = withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    // Re-evaluate close-readiness at merge time from the DB facts — a finding
    // or close-check could have changed since the PR was created.
    const closeReady =
      new ConvergenceService(repo).evaluate(hitchId).decision === "close_ready";
    const { consensus, humanApproved } = gatherApproval(db, runId);
    return evaluateMergeGate({
      autoMergeEnabled: true,
      closeReady,
      consensus,
      humanApproved,
      ciGreen,
      tierEligible,
    });
  });
  if (gate.canMerge) {
    const method: PrMergeMethod = autoMerge.method ?? "squash";
    const operationId = `op-${randomUUID()}`;
    withManagedDb({ dbPath: deps.dbPath }, (db) => {
      startOperation(db, {
        operationId,
        operationType: "merge",
        targetType: "pr",
        targetId: String(prNumber),
        actor: deps.createdBy,
        dryRun: false,
        // Record the gate snapshot so an auditor can later verify which
        // reviewed commit was pinned and what the gate saw.
        input: {
          hitchId,
          runId,
          prNumber,
          method,
          expectedHeadSha,
          ciGreen,
          tier,
          gate,
        },
      });
    });
    try {
      const result = await autoMerge.merger.merge({
        repoDir: repoPath,
        prNumber,
        method,
        expectedHeadSha,
      });
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        succeedOperation(db, operationId, result);
      });
      return { merged: true };
    } catch (e) {
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        failOperation(db, operationId, "merge_failed", (e as Error).message);
      });
      throw e;
    }
  }
  if (gate.hardBlocked) {
    // fail-closed: a human-required blocker must not be auto-merged or silently
    // closed — escalate so a human resolves it.
    return {
      merged: false,
      escalateReason: `auto-merge gate hard-blocked: ${gate.blockers.join(", ")}`,
    };
  }
  // transient: leave the PR open for a later merge. `recheckable` is true only
  // for CI-not-green (a temporal blocker that a re-run can clear); a
  // tier_not_auto_eligible block is permanent (the path's tier never changes),
  // so the hitch closes for a human merge rather than waiting on a re-check.
  return { merged: false, recheckable: gate.blockers.includes("ci_not_green") };
}

/** Gather the consensus + human-override approval facts for the merge gate. */
function gatherApproval(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): { consensus: MergeGateConsensus | null; humanApproved: boolean } {
  const active = new ReviewConsensusRepository(db).findActive(runId);
  let consensus: MergeGateConsensus | null = null;
  if (active !== null) {
    const summary = JSON.parse(active.summaryJson) as ConsensusSummary;
    consensus = {
      status: active.status,
      quorumSatisfied: quorumSatisfiedFromRequirements(summary.requirements),
    };
  }
  const override = new ReviewOverridesRepository(db).findLatest(runId);
  return { consensus, humanApproved: override?.decision === "approved" };
}

function changedPathsForRun(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT path
       FROM run_changed_files
       WHERE run_id = ? AND allowed = 1 AND status <> 'ignored'
       ORDER BY path`,
    )
    .all(runId) as { path: string }[];
  const dbPaths = rows
    .map((r) => r.path)
    .filter((p): p is string => typeof p === "string" && p !== "");
  if (dbPaths.length > 0) return dbPaths;

  const row = db
    .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
    .get(runId) as { meta_json: string | null } | undefined;
  if (row?.meta_json === undefined || row.meta_json === null) return [];
  const meta = JSON.parse(row.meta_json) as {
    reviewed?: { paths?: unknown };
  };
  const reviewedPaths = meta.reviewed?.paths;
  if (!Array.isArray(reviewedPaths)) return [];
  return reviewedPaths.filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
}

/** Whether the run's captured diff weakened the test suite (run-time signal). */
function runWeakensTests(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): boolean {
  const row = db
    .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
    .get(runId) as { meta_json: string | null } | undefined;
  if (row?.meta_json === undefined || row.meta_json === null) return false;
  try {
    const meta = JSON.parse(row.meta_json) as {
      reviewed?: { weakensTests?: unknown };
    };
    return meta.reviewed?.weakensTests === true;
  } catch {
    return false;
  }
}

/**
 * Auto-merge tier for a run: the sensitivity-map tier, but a Tier-0
 * (tests/docs-only) change that WEAKENS tests (deletes a test file or adds a
 * skip/only marker) is downgraded to Tier-1 so it cannot auto-merge — coverage
 * must not be removed by an automatic merge. Fail-closed (only tightens).
 */
function effectiveAutoMergeTier(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
  harnessRoot: string,
): AutoMergeTier {
  const base = computeAutoMergeTier(
    changedPathsForRun(db, runId),
    loadAutoMergeSensitivityMap(harnessRoot),
  );
  return base === 0 && runWeakensTests(db, runId) ? 1 : base;
}

/**
 * Opt-in advisory ingestion of external PR review verdicts (codex GitHub App /
 * Copilot). Each `CHANGES_REQUESTED` verdict is recorded ONCE as an
 * unknown-scope hitch finding; the close-readiness re-eval in the merge gate
 * then fails, so the gate escalates for the operator to classify. External
 * approvals are NEVER ingested — an external "approve" cannot authorise a merge
 * (§0/§6: external output may only push fail-closed, never approve). Best
 * effort: a fetch failure is swallowed so it cannot break the merge path.
 */
function defaultReviewSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch the PR's CHANGES_REQUESTED verdicts once; a fetch failure yields none. */
async function fetchBlockingVerdicts(
  fetchVerdicts: (prNumber: number) => Promise<{ author: string; state: string }[]>,
  prNumber: number,
): Promise<{ author: string; state: string }[]> {
  try {
    const verdicts = await fetchVerdicts(prNumber);
    return verdicts.filter((v) => v.state.toUpperCase() === "CHANGES_REQUESTED");
  } catch {
    return [];
  }
}

async function ingestExternalReviewVerdicts(
  deps: OrchestratorRunnerDeps,
  hitchId: string,
  prNumber: number,
): Promise<void> {
  const fetchVerdicts = deps.autoMerge?.reviewVerdicts;
  if (fetchVerdicts === undefined) return;
  let blocking = await fetchBlockingVerdicts(fetchVerdicts, prNumber);
  const awaitCfg = deps.autoMerge?.reviewAwait;
  if (blocking.length === 0 && awaitCfg !== undefined) {
    // Bounded await: give async external reviewers a window to weigh in before
    // the gate is evaluated. Stop on the first blocking verdict or budget spent.
    const now = awaitCfg.now ?? Date.now;
    const sleep = awaitCfg.sleep ?? defaultReviewSleep;
    const start = now();
    while (now() - start < awaitCfg.timeoutMs) {
      const remaining = awaitCfg.timeoutMs - (now() - start);
      await sleep(Math.min(awaitCfg.intervalMs, remaining));
      blocking = await fetchBlockingVerdicts(fetchVerdicts, prNumber);
      if (blocking.length > 0) break;
    }
  }
  if (blocking.length === 0) return;
  withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    const seen = new Set(
      repo.listFindings({ hitchId, limit: 10_000 }).map((f) => f.stableKey),
    );
    for (const v of blocking) {
      const stableKey = `external-review:${prNumber}:${v.author}`;
      if (seen.has(stableKey)) continue; // ingest each verdict once (no reopen loop)
      repo.upsertFinding({
        hitchId,
        source: "review",
        sourceRef: `external_review:${prNumber}:${v.author}`,
        severity: "P1",
        category: "external-review-changes-requested",
        scopeStatus: "unknown",
        summary: `External reviewer ${v.author} requested changes on PR #${prNumber}`,
        classificationReason:
          "external review verdict ingested as advisory; classify before acting",
        stableKey,
      });
    }
  });
}
