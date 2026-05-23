import type Database from "better-sqlite3";

/**
 * Review proposal repository (Phase 9-8).
 *
 * `review auto` writes the reviewer-agent verdict as a proposal here;
 * `review process` reads the latest active proposal and promotes it to
 * `review_decisions`. The `(run_id, reviewer)` active partial unique
 * index in schema v5 guarantees at most one active proposal per
 * (run, reviewer) — inserting a new one supersedes the prior.
 */

export type ReviewDecision =
  | "pending"
  | "approved"
  | "changes_requested"
  | "rejected";

export interface ReviewProposalInput {
  runId: string;
  reviewer: string;
  decision: ReviewDecision;
  requiredChanges: string[];
  nonBlockingComments: string[];
  outOfScopeSuggestions: string[];
  reviewedAt: string;
  sourceYaml: string;
  sourceSha256: string;
  createdAt: string;
}

export interface ReviewProposalRow {
  proposalId: number;
  runId: string;
  reviewer: string;
  decision: ReviewDecision;
  requiredChanges: string[];
  nonBlockingComments: string[];
  outOfScopeSuggestions: string[];
  reviewedAt: string;
  sourceYaml: string;
  sourceSha256: string;
  createdAt: string;
  supersededAt: string | null;
  processedAt: string | null;
  reviewDecisionId: string | null;
}

export class ReviewProposalRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new proposal for `(runId, reviewer)`, marking the prior
   * active proposal (if any) as superseded. The partial unique index
   * enforces only one active row per (runId, reviewer); the
   * supersede-then-insert pair runs in a single transaction so two
   * `review auto` racing on the same run cannot both leave an active.
   */
  insertProposal(input: ReviewProposalInput): { proposalId: number } {
    const tx = this.db.transaction((): number => {
      this.db
        .prepare(
          `UPDATE review_proposals
              SET superseded_at = ?
            WHERE run_id = ? AND reviewer = ? AND superseded_at IS NULL`,
        )
        .run(input.createdAt, input.runId, input.reviewer);
      const info = this.db
        .prepare(
          `INSERT INTO review_proposals
             (run_id, reviewer, decision, required_changes_json,
              non_blocking_comments_json, out_of_scope_suggestions_json,
              reviewed_at, source_yaml, source_sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.reviewer,
          input.decision,
          JSON.stringify(input.requiredChanges),
          JSON.stringify(input.nonBlockingComments),
          JSON.stringify(input.outOfScopeSuggestions),
          input.reviewedAt,
          input.sourceYaml,
          input.sourceSha256,
          input.createdAt,
        );
      return Number(info.lastInsertRowid);
    });
    return { proposalId: tx.immediate() };
  }

  /**
   * Return the latest active, **unprocessed** proposal for `runId`. With
   * `reviewer` set, only that reviewer's proposal is considered.
   * Tie-breaker: `reviewed_at DESC, proposal_id DESC` (newer wins).
   *
   * Phase 9 post-close P1 #1 fix — `processed_at IS NULL` is part of the
   * filter so a proposal that was already promoted to `review_decisions`
   * is not handed back to `review process` again. Without this guard a
   * crash between promotion and `markProcessed` would leave an active
   * proposal pointed at a run no longer in `needs_review`, and a retry
   * would fail the status gate even though the work is already done.
   */
  getLatestActiveProposal(
    runId: string,
    reviewer?: string,
  ): ReviewProposalRow | null {
    const row =
      reviewer === undefined
        ? this.db
            .prepare(
              `SELECT * FROM review_proposals
                WHERE run_id = ?
                  AND superseded_at IS NULL
                  AND processed_at IS NULL
                ORDER BY reviewed_at DESC, proposal_id DESC LIMIT 1`,
            )
            .get(runId)
        : this.db
            .prepare(
              `SELECT * FROM review_proposals
                WHERE run_id = ?
                  AND reviewer = ?
                  AND superseded_at IS NULL
                  AND processed_at IS NULL
                ORDER BY reviewed_at DESC, proposal_id DESC LIMIT 1`,
            )
            .get(runId, reviewer);
    return row === undefined ? null : toReviewProposalRow(row);
  }

  /**
   * Return the most recent **processed** proposal for `runId` so callers
   * can detect a crash-survived idempotent state. Used by `review
   * process` to short-circuit a retry when the work is already done.
   */
  getLatestProcessedProposal(
    runId: string,
    reviewer?: string,
  ): ReviewProposalRow | null {
    const row =
      reviewer === undefined
        ? this.db
            .prepare(
              `SELECT * FROM review_proposals
                WHERE run_id = ? AND processed_at IS NOT NULL
                ORDER BY processed_at DESC, proposal_id DESC LIMIT 1`,
            )
            .get(runId)
        : this.db
            .prepare(
              `SELECT * FROM review_proposals
                WHERE run_id = ? AND reviewer = ?
                  AND processed_at IS NOT NULL
                ORDER BY processed_at DESC, proposal_id DESC LIMIT 1`,
            )
            .get(runId, reviewer);
    return row === undefined ? null : toReviewProposalRow(row);
  }

  /**
   * Mark a proposal as processed (promoted to `review_decisions`).
   * `review process` re-invocations look at `processed_at` to no-op.
   *
   * Phase 9 post-close P1 #1 fix — `WHERE processed_at IS NULL` guard
   * makes the UPDATE idempotent: a second call on an already-processed
   * proposal is a silent no-op rather than overwriting the recorded
   * `processed_at` timestamp.
   */
  markProcessed(
    proposalId: number,
    reviewDecisionId: string,
    processedAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE review_proposals
            SET processed_at = ?, review_decision_id = ?
          WHERE proposal_id = ? AND processed_at IS NULL`,
      )
      .run(processedAt, reviewDecisionId, proposalId);
  }
}

function toReviewProposalRow(raw: unknown): ReviewProposalRow {
  const r = raw as Record<string, unknown>;
  return {
    proposalId: r.proposal_id as number,
    runId: r.run_id as string,
    reviewer: r.reviewer as string,
    decision: r.decision as ReviewDecision,
    requiredChanges: JSON.parse(
      (r.required_changes_json as string) ?? "[]",
    ) as string[],
    nonBlockingComments: JSON.parse(
      (r.non_blocking_comments_json as string) ?? "[]",
    ) as string[],
    outOfScopeSuggestions: JSON.parse(
      (r.out_of_scope_suggestions_json as string) ?? "[]",
    ) as string[],
    reviewedAt: r.reviewed_at as string,
    sourceYaml: r.source_yaml as string,
    sourceSha256: r.source_sha256 as string,
    createdAt: r.created_at as string,
    supersededAt: (r.superseded_at as string | null) ?? null,
    processedAt: (r.processed_at as string | null) ?? null,
    reviewDecisionId: (r.review_decision_id as string | null) ?? null,
  };
}
