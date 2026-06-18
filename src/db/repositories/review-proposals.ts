import type Database from "better-sqlite3";
import { ReviewerAgentGateError } from "../../core/reviewer-agent-errors.js";

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
  promptSha256?: string;
  promptProvenance?: ReviewPromptProvenance;
  failIfSupersedes?: boolean;
}

export interface ReviewPromptProvenance {
  template: { name: string; version: number };
  knowledge: { entryId: string; version: number }[];
  lens?: {
    reviewerId: string;
    lens: string;
    lensPromptSha256: string | null;
  };
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
  promptSha256: string | null;
  promptProvenanceJson: string | null;
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
      const run = this.db
        .prepare("SELECT status, source_mode FROM runs WHERE run_id = ?")
        .get(input.runId) as
        | { status: string; source_mode: string }
        | undefined;
      if (run === undefined) {
        throw new ReviewerAgentGateError(
          `run ${input.runId} not found; only db-first needs_review runs can accept review proposals`,
        );
      }
      if (run.source_mode !== "db-first" || run.status !== "needs_review") {
        throw new ReviewerAgentGateError(
          `run ${input.runId} is source_mode="${run.source_mode}" ` +
            `status="${run.status}"; only db-first needs_review runs can ` +
            `accept review proposals`,
        );
      }
      // Phase 11-7: when superseding a prior active proposal, flip its
      // lifecycle_status to 'superseded' as well so list/vacuum and
      // consensus filters see a consistent state machine.
      const superseded = this.db
        .prepare(
          `UPDATE review_proposals
              SET superseded_at = ?, lifecycle_status = 'superseded'
            WHERE run_id = ? AND reviewer = ? AND superseded_at IS NULL`,
        )
        .run(input.createdAt, input.runId, input.reviewer);
      if (input.failIfSupersedes === true && superseded.changes > 0) {
        throw new ReviewerAgentGateError(
          `既存 active proposal を supersede しようとした（並行 review 競合）: ` +
            `run ${input.runId}, reviewer ${input.reviewer}`,
        );
      }
      const info = this.db
        .prepare(
          `INSERT INTO review_proposals
             (run_id, reviewer, decision, required_changes_json,
              non_blocking_comments_json, out_of_scope_suggestions_json,
              reviewed_at, source_yaml, source_sha256, created_at,
              prompt_sha256, prompt_provenance_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.promptSha256 ?? null,
          input.promptProvenance === undefined
            ? null
            : JSON.stringify(input.promptProvenance),
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

  getById(proposalId: number): ReviewProposalRow | null {
    const row = this.db
      .prepare(`SELECT * FROM review_proposals WHERE proposal_id = ?`)
      .get(proposalId);
    return row === undefined ? null : toReviewProposalRow(row);
  }

  supersedeActiveForReviewers(input: {
    runId: string;
    reviewerIds: readonly string[];
    supersededAt: string;
  }): number {
    if (input.reviewerIds.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE review_proposals
          SET superseded_at = ?, lifecycle_status = 'superseded'
        WHERE run_id = ?
          AND reviewer = ?
          AND superseded_at IS NULL
          AND processed_at IS NULL`,
    );
    const tx = this.db.transaction(() => {
      let changed = 0;
      for (const reviewerId of input.reviewerIds) {
        changed += stmt.run(
          input.supersededAt,
          input.runId,
          reviewerId,
        ).changes;
      }
      return changed;
    });
    return tx.immediate();
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
   *
   * Phase 9 post-close (second review) P1-4 fix — also require
   * `superseded_at IS NULL`. Without this, a process that read a
   * proposal, was paused, and woke up after a concurrent `review auto`
   * superseded the proposal would still stamp `processed_at` on the
   * stale row. Returns `true` when the row was actually updated,
   * `false` when a guard rejected it (caller can surface a state
   * conflict).
   */
  /**
   * Phase 11-7 — list proposals for a run, optionally including
   * archived rows. Used by the `harness review proposals list` CLI.
   */
  listForRun(
    runId: string,
    opts: { includeArchived?: boolean } = {},
  ): ReviewProposalRow[] {
    const sql = opts.includeArchived
      ? `SELECT * FROM review_proposals WHERE run_id = ?
         ORDER BY created_at DESC, proposal_id DESC`
      : `SELECT * FROM review_proposals WHERE run_id = ?
           AND lifecycle_status != 'archived'
         ORDER BY created_at DESC, proposal_id DESC`;
    const rows = this.db.prepare(sql).all(runId);
    return (rows as unknown[]).map((r) => toReviewProposalRow(r));
  }

  /**
   * Phase 11-7 — archive a single proposal (audit-preserving delete).
   * Idempotent: already-archived rows stay as-is.
   */
  archive(proposalId: number, now: Date = new Date()): boolean {
    const r = this.db
      .prepare(
        `UPDATE review_proposals
            SET lifecycle_status = 'archived', archived_at = ?
          WHERE proposal_id = ? AND lifecycle_status != 'archived'`,
      )
      .run(now.toISOString(), proposalId);
    return r.changes > 0;
  }

  /**
   * Phase 11-7 — vacuum eligible rows older than `olderThan`.
   * Eligible lifecycle: 'superseded' / 'processed' / 'rejected_stale'.
   * `active` is never vacuumed. Default is dry-run; the `apply` flag
   * actually flips them to `archived`.
   *
   * Returns the list of proposal_ids that were (or would be) archived.
   */
  vacuumOlderThan(input: {
    olderThan: Date;
    apply?: boolean;
    now?: Date;
  }): number[] {
    const cutoff = input.olderThan.toISOString();
    const candidates = this.db
      .prepare(
        `SELECT proposal_id FROM review_proposals
          WHERE lifecycle_status IN ('superseded', 'processed', 'rejected_stale')
            AND created_at < ?`,
      )
      .all(cutoff) as { proposal_id: number }[];
    const ids = candidates.map((r) => r.proposal_id);
    if (input.apply && ids.length > 0) {
      const now = (input.now ?? new Date()).toISOString();
      const stmt = this.db.prepare(
        `UPDATE review_proposals
            SET lifecycle_status = 'archived', archived_at = ?
          WHERE proposal_id = ? AND lifecycle_status != 'archived'`,
      );
      const tx = this.db.transaction(() => {
        for (const id of ids) stmt.run(now, id);
      });
      tx();
    }
    return ids;
  }

  markProcessed(
    proposalId: number,
    reviewDecisionId: string,
    processedAt: string,
    /**
     * Phase 10-5 (design §3.E E1) — when supplied, the UPDATE is also
     * guarded by `source_sha256 = ?`. A stale caller holding an old
     * sha after a concurrent `review auto` mutated the same proposal
     * row in place (e.g. retry) gets `changes=0` rather than silently
     * stamping `processed_at`.
     */
    expectedSourceSha256?: string,
  ): boolean {
    // Phase 11-7: bump lifecycle_status to 'processed' alongside the
    // processed_at timestamp so list/vacuum and consensus consumers see
    // a consistent state machine.
    const sql =
      expectedSourceSha256 === undefined
        ? `UPDATE review_proposals
              SET processed_at = ?, review_decision_id = ?,
                  lifecycle_status = 'processed'
            WHERE proposal_id = ?
              AND processed_at IS NULL
              AND superseded_at IS NULL`
        : `UPDATE review_proposals
              SET processed_at = ?, review_decision_id = ?,
                  lifecycle_status = 'processed'
            WHERE proposal_id = ?
              AND processed_at IS NULL
              AND superseded_at IS NULL
              AND source_sha256 = ?`;
    const r =
      expectedSourceSha256 === undefined
        ? this.db.prepare(sql).run(processedAt, reviewDecisionId, proposalId)
        : this.db
            .prepare(sql)
            .run(
              processedAt,
              reviewDecisionId,
              proposalId,
              expectedSourceSha256,
            );
    return r.changes > 0;
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
    promptSha256: (r.prompt_sha256 as string | null) ?? null,
    promptProvenanceJson: (r.prompt_provenance_json as string | null) ?? null,
  };
}
