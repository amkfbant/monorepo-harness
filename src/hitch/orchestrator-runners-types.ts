// orchestrator-runners の共有 const / error / 型（leaf）。createOrchestratorRunners の

import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import type { RunDomainCodingOpts } from "../core/workflow-runner.js";

import type { PrPublisher, PrMerger, PrMergeMethod } from "../core/pr-creator.js";

import type { CopilotReviewer } from "../core/copilot-reviewer.js";
import type { CopilotReviewConfig } from "../core/copilot-review-run.js";

import { OPEN_FINDING_LIFECYCLES, UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES } from "./repository.js";

import type { HitchLifecycleStatus, HitchSession } from "./types.js";
import type { ReviewerLensPrompt } from "../core/reviewer-agent.js";
import type { RefuteRequiredChange } from "../core/refute-binding.js";

export const FINDING_BATCH_LIMIT = 200;

/**
 * (#230 / codex#252-P2 / plan P2-i) Per-invocation jury budget cap. Each jury
 * finding costs 4-7 codex calls (3 lens propose + optional 3 critique + 1
 * refute), so the worst case per invocation is `JURY_BATCH_LIMIT * 7` codex
 * calls. Kept well under `FINDING_BATCH_LIMIT` (200) — at 25 the worst case is
 * 175 codex calls. Candidates beyond the cap are deferred to the NEXT orchestrate
 * invocation (the result carries `moreUnknownsPending` and the orchestrator
 * halts THIS invocation cleanly; convergence re-fires needs_classification).
 */
export const JURY_BATCH_LIMIT = 25;

/** Default per-call jury codex timeout (ms) — mirrors the reviewer budget. */
export const JURY_CODEX_TIMEOUT_MS = 600_000;

export const OPEN_FINDING_LIFECYCLE_SET: ReadonlySet<HitchLifecycleStatus> = new Set(
  OPEN_FINDING_LIFECYCLES,
);
export const UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET: ReadonlySet<HitchLifecycleStatus> =
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
  reviewRuleResolution: NonNullable<RunDomainCodingOpts["reviewRuleResolution"]>;
  project: NonNullable<RunDomainCodingOpts["project"]>;
  projectContextPacks?: NonNullable<RunDomainCodingOpts["projectContextPacks"]>;
}

export interface OrchestratorRunnerDeps {
  dbPath: string;
  harnessRoot: string;
  createdBy: string;
  coderRunner: CodexExecRunner;
  /**
   * (#191) Backend of `coderRunner`, captured with its construction and threaded
   * to the coder `runDomainCoding` call so the coder dispatch (redaction / usage
   * / model) can't diverge from the injected runner. Absent → 'codex'. Reviewer
   * stays codex (its claude dispatch is a separate follow-up).
   */
  coderBackend?: "codex" | "claude";
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

export type ReviewDispatchPlan =
  | { kind: "single" }
  | {
      kind: "frozen-consensus";
      reviewerIds: string[];
      reviewers: FrozenReviewerDispatch[];
    };

export interface FrozenReviewerDispatch {
  reviewerId: string;
  reviewerLens?: ReviewerLensPrompt;
}

export interface ReviewerDispatchFailure {
  reviewerId: string;
  reason: string;
}

export interface RefuteDispatchTarget extends RefuteRequiredChange {
  changeText: string;
  targetChangeHash: string;
}

export interface RefuteDispatchPlan {
  reviewerIds: string[];
  targets: RefuteDispatchTarget[];
}

/**
 * Why a frozen-consensus review cannot start. `unregistered` = a frozen
 * reviewer id has no `reviewers` row; `under_quorum`/`wrong_group` = a
 * requirement's group has fewer registered members than it needs (a frozen id
 * resolves to a different group, or simply is not registered for that group);
 * `no_reviewers` = the rule resolved to an empty frozen set (defensive).
 */
export type ConsensusPreflightCauseKind =
  | "no_reviewers"
  | "under_quorum"
  | "wrong_group"
  | "unregistered"
  | "invalid_lens"
  | "missing_lens"
  | "missing_axis"
  | "duplicate_lens";

/**
 * Typed preflight failure raised BEFORE any reviewer is dispatched. It is a
 * plain `Error` subclass so the orchestrator's generic step catch still turns
 * it into a clean escalation (the discriminator + counts are carried for the
 * operator / tests, not for any new control flow).
 */
export class ConsensusReviewPreflightError extends Error {
  readonly causeKind: ConsensusPreflightCauseKind;
  readonly group?: string;
  readonly required?: number;
  readonly registered?: number;
  readonly requiredAxes?: string[];
  readonly coveredAxes?: string[];
  readonly missingAxes?: string[];
  readonly duplicateAxes?: string[];
  constructor(
    message: string,
    detail: {
      causeKind: ConsensusPreflightCauseKind;
      group?: string;
      required?: number;
      registered?: number;
      requiredAxes?: string[];
      coveredAxes?: string[];
      missingAxes?: string[];
      duplicateAxes?: string[];
    },
  ) {
    super(`consensus review preflight failed: ${message}`);
    this.name = "ConsensusReviewPreflightError";
    this.causeKind = detail.causeKind;
    if (detail.group !== undefined) this.group = detail.group;
    if (detail.required !== undefined) this.required = detail.required;
    if (detail.registered !== undefined) this.registered = detail.registered;
    if (detail.requiredAxes !== undefined) this.requiredAxes = detail.requiredAxes;
    if (detail.coveredAxes !== undefined) this.coveredAxes = detail.coveredAxes;
    if (detail.missingAxes !== undefined) this.missingAxes = detail.missingAxes;
    if (detail.duplicateAxes !== undefined) {
      this.duplicateAxes = detail.duplicateAxes;
    }
  }
}
