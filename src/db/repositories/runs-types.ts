// RunRepository の公開 DTO 型（leaf）。dashboard/CLI summary・write 入出力 shape。

export interface RunFilter {
  projectId?: string;
  repoId?: string;
  domain?: string;
  statuses?: string[];
  /** ISO lower bound on started_at (inclusive) */
  since?: string;
  /** ISO upper bound on started_at (inclusive) */
  until?: string;
  reviewer?: string;
  safetyStatus?: string;
  limit?: number;
  offset?: number;
}

/** One row of the dashboard run list. */
export interface DashboardRunSummary {
  runId: string;
  repoId: string;
  projectId: string | null;
  domain: string;
  status: string;
  safetyStatus: string | null;
  reviewer: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  rerunAttempt: number | null;
  prUrl: string | null;
}

/** Full run row for the run-detail view. */
export interface RunDetail extends DashboardRunSummary {
  repoPath: string | null;
  workflow: string;
  baseBranch: string;
  baseSha: string | null;
  runBranch: string | null;
  reviewedAt: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  changedFilesCount: number | null;
  ignoredUntrackedCount: number | null;
  secretSuspectCount: number | null;
  prNumber: number | null;
  promptTemplateName: string | null;
  promptTemplateVersion: number | null;
  knowledgeContextPath: string | null;
}

export interface RunTimelineEvent {
  seq: number;
  type: string;
  occurredAt: string | null;
  payload: unknown;
}

export interface RerunChainNode {
  runId: string;
  parentRunId: string | null;
  rootRunId: string | null;
  rerunAttempt: number | null;
  status: string;
}

export interface CommandResultRow {
  commandIndex: number;
  command: string;
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
}

export interface ReviewDecisionRow {
  decision: string;
  reviewer: string | null;
  summary: string | null;
  reviewedAt: string | null;
  requiredChanges: string[];
}

/** Input to the guarded run status transition. */
export interface UpdateRunStatusInput {
  runId: string;
  /** the transition succeeds only if the current status is one of these */
  expectedStatuses: string[];
  nextStatus: string;
  /** `run_events.type` for the appended lifecycle event */
  eventType: string;
  actor?: string;
  /** when set, a replay of the same id is an idempotent no-op */
  operationId?: string;
  /** ISO timestamp; defaults to now */
  occurredAt?: string;
}

export interface UpdateRunStatusResult {
  /** false when an operation-id replay made this an idempotent no-op */
  changed: boolean;
  /** the run's status after the call */
  status: string;
}

/** One row of `run_changed_files` — a path the run touched. */
export interface ChangedFileInput {
  path: string;
  /** `tracked` | `untracked` | `ignored` */
  status: string;
  /** false when path policy denied the path */
  allowed: boolean;
  /** `post-codex` | `post-command` — which diff pass produced this */
  source: string;
}

/** One row of `policy_violations` — a path path-policy rejected. */
export interface ViolationInput {
  path: string;
  /** the rule kind: `deny_write` | `not_in_write_scope` | `unsafe_path` */
  rule: string;
  reason?: string;
}

/** Input to the guarded review-decision transition (Phase 7-5). */
export interface ApplyReviewDecisionInput {
  runId: string;
  /**
   * the reviewer's decision — also the run's target status, since the
   * three decision values map identically onto run statuses.
   */
  decision: "approved" | "changes_requested" | "rejected";
  reviewer: string | null;
  reviewedAt: string;
  requiredChanges: string[];
  /** raw review-decision.yaml content, stored in review_decisions */
  decisionYaml: string;
  /**
   * Phase 10 post-close (whole-phase review P1 #1) — when supplied, the
   * promotion UPDATE adds `AND state_version = ?`. A concurrent writer
   * that already bumped state_version between the caller's read and this
   * UPDATE triggers a StateConflictError rather than a silent overwrite.
   * Phase 10-5 only bumps state_version in review-related transitions,
   * so passing the caller-read snapshot is the right minimum guard.
   */
  expectedStateVersion?: number;
  /**
   * Phase 11 post-close P1 #2 — link the just-evaluated consensus row
   * + its summary json into review_decisions, so decision provenance
   * (including override actor / reason) is queryable from a single row
   * for dashboard / archive consumers.
   */
  consensusId?: number;
  proposalsSummaryJson?: string;
  /**
   * Phase 9 post-close P1 #1 fix — when the verdict came from a DB
   * `review_proposals` row, mark it processed inside the SAME transaction
   * as the decision promotion. If the process crashes between the run
   * status update and a later `markProcessed`, the proposal would
   * otherwise stay active-but-unprocessed and a retry would fail the
   * `status === needs_review` gate.
   */
  markProposalProcessed?: {
    proposalId: number;
    reviewDecisionId: string;
    /**
     * Phase 10-5 (design §3.E E1): when supplied, the UPDATE adds an
     * `AND source_sha256 = ?` predicate so a stale caller (who read the
     * proposal under an old sha after a concurrent `review auto`
     * mutated it) gets a `StateConflictError` instead of silently
     * stamping `processed_at`.
     */
    expectedSourceSha256?: string;
  };
  /**
   * Phase 2 (consensus production wiring): mark MULTIPLE proposals
   * processed in the SAME transaction as the consensus promotion. Each
   * proposal must still be active (`processed_at IS NULL AND superseded_at
   * IS NULL`); any that is not aborts the whole promotion with a
   * StateConflictError (atomic: the run is not promoted on a stale set).
   */
  markProposalsProcessed?: number[];
}
