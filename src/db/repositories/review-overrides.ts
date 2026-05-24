import type Database from "better-sqlite3";

/**
 * `review_overrides` repository (Phase 11-6).
 *
 * Human override audit log. Each override row records actor / decision
 * / reason / optional consensus_id linkage. The audit is append-only;
 * superseding a prior override does not delete the row.
 */

export interface ReviewOverrideRow {
  overrideId: number;
  runId: string;
  consensusId: number | null;
  actorReviewerId: string;
  decision: "approved" | "changes_requested" | "rejected";
  reason: string;
  createdAt: string;
  sourceSha256: string | null;
}

export class OverrideReasonRequiredError extends Error {
  constructor() {
    super("review override reason is required (non-empty)");
    this.name = "OverrideReasonRequiredError";
  }
}

export class UnauthorizedOverrideError extends Error {
  constructor(
    public readonly actorReviewerId: string,
    public readonly allowedReviewers: string[],
  ) {
    super(
      `reviewer "${actorReviewerId}" is not authorised to override ` +
        `(allowed: ${
          allowedReviewers.length === 0
            ? "(none — overrides disabled in this rule)"
            : allowedReviewers.join(", ")
        })`,
    );
    this.name = "UnauthorizedOverrideError";
  }
}

export class ReviewOverridesRepository {
  constructor(private readonly db: Database.Database) {}

  insert(input: {
    runId: string;
    consensusId?: number;
    actorReviewerId: string;
    decision: "approved" | "changes_requested" | "rejected";
    reason: string;
    sourceSha256?: string;
    now?: Date;
  }): ReviewOverrideRow {
    if (input.reason.trim() === "") {
      throw new OverrideReasonRequiredError();
    }
    const now = (input.now ?? new Date()).toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO review_overrides
           (run_id, consensus_id, actor_reviewer_id, decision, reason,
            created_at, source_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.consensusId ?? null,
        input.actorReviewerId,
        input.decision,
        input.reason,
        now,
        input.sourceSha256 ?? null,
      );
    return {
      overrideId: Number(info.lastInsertRowid),
      runId: input.runId,
      consensusId: input.consensusId ?? null,
      actorReviewerId: input.actorReviewerId,
      decision: input.decision,
      reason: input.reason,
      createdAt: now,
      sourceSha256: input.sourceSha256 ?? null,
    };
  }

  listForRun(runId: string): ReviewOverrideRow[] {
    const rows = this.db
      .prepare(
        `SELECT override_id, run_id, consensus_id, actor_reviewer_id,
                decision, reason, created_at, source_sha256
           FROM review_overrides
          WHERE run_id = ?
          ORDER BY created_at ASC, override_id ASC`,
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map(toRow);
  }

  findLatest(runId: string): ReviewOverrideRow | null {
    const row = this.db
      .prepare(
        `SELECT override_id, run_id, consensus_id, actor_reviewer_id,
                decision, reason, created_at, source_sha256
           FROM review_overrides
          WHERE run_id = ?
          ORDER BY created_at DESC, override_id DESC
          LIMIT 1`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toRow(row);
  }
}

function toRow(r: Record<string, unknown>): ReviewOverrideRow {
  return {
    overrideId: r.override_id as number,
    runId: r.run_id as string,
    consensusId: (r.consensus_id as number | null) ?? null,
    actorReviewerId: r.actor_reviewer_id as string,
    decision: r.decision as "approved" | "changes_requested" | "rejected",
    reason: r.reason as string,
    createdAt: r.created_at as string,
    sourceSha256: (r.source_sha256 as string | null) ?? null,
  };
}
