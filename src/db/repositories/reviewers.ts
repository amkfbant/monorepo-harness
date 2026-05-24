import type Database from "better-sqlite3";

/**
 * `reviewers` repository (Phase 11-2).
 *
 * Reviewer identity registry — Phase 9 / 10 stored only a free-form
 * `review_proposals.reviewer` string. Phase 11 normalises this into
 * `reviewer_id` (FK to this table). The Phase 11-1 migration seeds four
 * defaults via `INSERT OR IGNORE` (human / codex / codex-security /
 * system); this repository is read/write API on top.
 */

export type ReviewerType = "human" | "codex" | "external" | "system";
export type TrustLevel = "advisory" | "normal" | "required" | "policy";

export interface ReviewerRow {
  reviewerId: string;
  reviewerType: ReviewerType;
  displayName: string;
  groupId: string | null;
  trustLevel: TrustLevel;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export class UnknownReviewerError extends Error {
  constructor(public readonly reviewerId: string) {
    super(
      `unknown reviewer "${reviewerId}". Use \`harness review reviewers list\` ` +
        `to see registered reviewers, or \`harness review reviewers add\` ` +
        `to register a new one.`,
    );
    this.name = "UnknownReviewerError";
  }
}

export class DuplicateReviewerError extends Error {
  constructor(public readonly reviewerId: string) {
    super(`reviewer "${reviewerId}" already exists`);
    this.name = "DuplicateReviewerError";
  }
}

export class ReviewerRepository {
  constructor(private readonly db: Database.Database) {}

  list(): ReviewerRow[] {
    const rows = this.db
      .prepare(
        `SELECT reviewer_id, reviewer_type, display_name, group_id,
                trust_level, metadata_json, created_at, updated_at
           FROM reviewers
          ORDER BY group_id, reviewer_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(toRow);
  }

  findById(reviewerId: string): ReviewerRow | null {
    const row = this.db
      .prepare(
        `SELECT reviewer_id, reviewer_type, display_name, group_id,
                trust_level, metadata_json, created_at, updated_at
           FROM reviewers
          WHERE reviewer_id = ?`,
      )
      .get(reviewerId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toRow(row);
  }

  /**
   * Resolve `reviewerId` → row, throwing `UnknownReviewerError` if not
   * registered. Used by `review auto` / `review process` to refuse
   * unknown reviewer ids.
   */
  resolveOrThrow(reviewerId: string): ReviewerRow {
    const row = this.findById(reviewerId);
    if (row === null) throw new UnknownReviewerError(reviewerId);
    return row;
  }

  add(input: {
    reviewerId: string;
    reviewerType: ReviewerType;
    displayName: string;
    groupId?: string;
    trustLevel?: TrustLevel;
    metadata?: Record<string, unknown>;
    now?: Date;
  }): ReviewerRow {
    if (this.findById(input.reviewerId) !== null) {
      throw new DuplicateReviewerError(input.reviewerId);
    }
    const now = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `INSERT INTO reviewers
           (reviewer_id, reviewer_type, display_name, group_id,
            trust_level, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.reviewerId,
        input.reviewerType,
        input.displayName,
        input.groupId ?? null,
        input.trustLevel ?? "normal",
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      );
    return this.resolveOrThrow(input.reviewerId);
  }
}

function toRow(r: Record<string, unknown>): ReviewerRow {
  return {
    reviewerId: r.reviewer_id as string,
    reviewerType: r.reviewer_type as ReviewerType,
    displayName: r.display_name as string,
    groupId: (r.group_id as string | null) ?? null,
    trustLevel: r.trust_level as TrustLevel,
    metadataJson: r.metadata_json as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
