import type { RunStatus } from "../logging/run-log.js";

/**
 * `processReviewDecision` の共有 error / result 型（#125 A15: core/review-processor.ts
 * から behaviour-zero 抽出）。path 処理(review-processor-paths.ts)と main の双方が参照
 * するため leaf モジュールに分離（循環回避）。
 */
/**
 * Thrown when review processing is rejected for a reason the user can fix
 * (pending decision, mismatched runId/domain, status that isn't
 * needs_review, malformed review-decision.yaml, missing run dir).
 *
 * The CLI maps this to exit code 1; unexpected exceptions (e.g. unrelated
 * fs errors, programming bugs) propagate to exit code 2.
 */
export class ReviewGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewGateError";
  }
}

export class ReviewConsensusNoActiveProposalsError extends ReviewGateError {
  constructor(readonly runId: string) {
    super(
      `no active review proposals to evaluate for ${runId}; run \`review auto\` first`,
    );
    this.name = "ReviewConsensusNoActiveProposalsError";
  }
}

export class ReviewConsensusPendingError extends ReviewGateError {
  constructor(
    readonly runId: string,
    readonly decisionPath: string,
  ) {
    super(`consensus not yet satisfied for ${runId} (${decisionPath})`);
    this.name = "ReviewConsensusPendingError";
  }
}

export function isConsensusPendingReviewGateError(
  e: unknown,
): e is ReviewConsensusNoActiveProposalsError | ReviewConsensusPendingError {
  return (
    e instanceof ReviewConsensusNoActiveProposalsError ||
    e instanceof ReviewConsensusPendingError
  );
}

export interface ProcessOpts {
  runsDir: string;
  runId: string;
  /**
   * locksDir is retained for callers that still pass it (e.g. CLI/tests).
   * Phase 10-1: the file domain lock has been retired; review processing
   * relies on the DB state guard (status / processed_at / source_sha256 /
   * superseded_at) to reject stale or concurrent writes. The path is
   * used only for the legacy file-lock warning helper.
   */
  locksDir: string;
  /** harness DB path — a `db-first` run is processed through the DB. */
  dbPath: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /**
   * Phase 11-6 — human override path. When provided, the override
   * decision is used instead of reading review_proposals /
   * review-decision.yaml. The override is gated by the run's review
   * rule snapshot (overrides.allowedReviewers / requireReason) and
   * audited in `review_overrides` + `run_events`.
   */
  override?: {
    decision: "approved" | "changes_requested" | "rejected";
    reason: string;
    /** actor reviewer_id; defaults to 'system'. */
    actorReviewerId?: string;
  };
  /** Optional active proposal id guard for callers that previewed a specific proposal. */
  proposalId?: number;
  /** Optional active proposal source hash guard for stale-preview rejection. */
  sourceSha256?: string;
}

export interface ProcessResult {
  runId: string;
  previousStatus: RunStatus;
  newStatus: RunStatus;
  reviewer: string | null;
  reviewedAt: string;
  warnings: string[];
}
