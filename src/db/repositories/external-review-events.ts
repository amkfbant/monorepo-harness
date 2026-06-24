import type Database from "better-sqlite3";

export type ExternalReviewerType = "codex_app" | "copilot" | "human" | "other";
export type ExternalReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending";

export const EXTERNAL_REVIEW_STATES: readonly ExternalReviewState[] = [
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
  "pending",
] as const;

export const EXTERNAL_REVIEWER_TYPES: readonly ExternalReviewerType[] = [
  "codex_app",
  "copilot",
  "human",
  "other",
] as const;

export interface ExternalReviewEventInput {
  eventId: string;
  hitchId?: string | null;
  runId?: string | null;
  repoId?: string | null;
  prNumber: number;
  author: string;
  reviewerType: ExternalReviewerType;
  state: ExternalReviewState;
  githubReviewId?: string | null;
  submittedAt?: string | null;
  summary?: string | null;
  redacted?: boolean;
  createdAt: string;
}

export interface ExternalReviewEventRow {
  eventId: string;
  hitchId: string | null;
  runId: string | null;
  repoId: string | null;
  prNumber: number;
  author: string;
  reviewerType: ExternalReviewerType;
  state: ExternalReviewState;
  githubReviewId: string | null;
  submittedAt: string | null;
  summary: string | null;
  redacted: boolean;
  createdAt: string;
}

export interface ExternalReviewEventInsertResult {
  row: ExternalReviewEventRow;
  inserted: boolean;
}

export interface ExternalReviewEventSummaryFilter {
  hitchId?: string;
  repoId?: string;
  prNumber?: number;
}

export interface ExternalReviewEventSummary {
  total: number;
  byState: Record<ExternalReviewState, number>;
  byReviewer: Record<ExternalReviewerType, number>;
  lastVerdict: ExternalReviewEventRow | null;
}

interface ExternalReviewEventDbRow {
  event_id: string;
  hitch_id: string | null;
  run_id: string | null;
  repo_id: string | null;
  pr_number: number;
  author: string;
  reviewer_type: ExternalReviewerType;
  state: ExternalReviewState;
  github_review_id: string | null;
  submitted_at: string | null;
  summary: string | null;
  redacted: number;
  created_at: string;
}

export class ExternalReviewEventRepository {
  constructor(private readonly db: Database.Database) {}

  append(input: ExternalReviewEventInput): ExternalReviewEventInsertResult {
    assertKnownState(input.state);
    assertKnownReviewerType(input.reviewerType);
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO external_review_events
           (event_id, hitch_id, run_id, repo_id, pr_number, author, reviewer_type,
            state, github_review_id, submitted_at, summary, redacted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.hitchId ?? null,
        input.runId ?? null,
        input.repoId ?? null,
        input.prNumber,
        input.author,
        input.reviewerType,
        input.state,
        input.githubReviewId ?? null,
        input.submittedAt ?? null,
        input.summary ?? null,
        input.redacted === true ? 1 : 0,
        input.createdAt,
      );
    if (info.changes === 1) {
      return { row: this.requireById(input.eventId), inserted: true };
    }
    const existing = this.findIgnoredDuplicate(input);
    if (existing !== null) return { row: existing, inserted: false };
    throw new Error(
      `external_review_events insert ignored but no existing row was found for ${input.eventId}`,
    );
  }

  listForHitch(hitchId: string): ExternalReviewEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT *
           FROM external_review_events
          WHERE hitch_id = ?
          ORDER BY created_at ASC, event_id ASC`,
      )
      .all(hitchId) as ExternalReviewEventDbRow[];
    return rows.map(toRow);
  }

  /**
   * Events for a PR. Pass `repoId` whenever known: PR numbers are only unique
   * within a repo, so an unscoped call can mix repos in a multi-repo harness DB.
   */
  listForPr(prNumber: number, repoId?: string): ExternalReviewEventRow[] {
    const scoped = repoId !== undefined;
    const rows = this.db
      .prepare(
        `SELECT *
           FROM external_review_events
          WHERE pr_number = ?${scoped ? " AND repo_id = ?" : ""}
          ORDER BY created_at ASC, event_id ASC`,
      )
      .all(...(scoped ? [prNumber, repoId] : [prNumber])) as ExternalReviewEventDbRow[];
    return rows.map(toRow);
  }

  summarize(
    filter: ExternalReviewEventSummaryFilter,
  ): ExternalReviewEventSummary {
    const where = scopedWhere(filter);
    const byState = zeroStateCounts();
    for (const row of this.db
      .prepare(
        `SELECT state, COUNT(*) AS n
           FROM external_review_events
          WHERE ${where.sql}
          GROUP BY state`,
      )
      .all(...where.params) as { state: ExternalReviewState; n: number }[]) {
      byState[row.state] = row.n;
    }

    const byReviewer = zeroReviewerCounts();
    for (const row of this.db
      .prepare(
        `SELECT reviewer_type AS reviewerType, COUNT(*) AS n
           FROM external_review_events
          WHERE ${where.sql}
          GROUP BY reviewer_type`,
      )
      .all(...where.params) as { reviewerType: ExternalReviewerType; n: number }[]) {
      byReviewer[row.reviewerType] = row.n;
    }

    const total = Object.values(byState).reduce((sum, n) => sum + n, 0);
    const lastRow = this.db
      .prepare(
        `SELECT *
           FROM external_review_events
          WHERE ${where.sql}
          ORDER BY created_at DESC, event_id DESC
          LIMIT 1`,
      )
      .get(...where.params) as ExternalReviewEventDbRow | undefined;
    return {
      total,
      byState,
      byReviewer,
      lastVerdict: lastRow === undefined ? null : toRow(lastRow),
    };
  }

  private requireById(eventId: string): ExternalReviewEventRow {
    const row = this.db
      .prepare("SELECT * FROM external_review_events WHERE event_id = ?")
      .get(eventId) as ExternalReviewEventDbRow | undefined;
    if (row === undefined) {
      throw new Error(`external_review_events row ${eventId} not found`);
    }
    return toRow(row);
  }

  private findIgnoredDuplicate(
    input: ExternalReviewEventInput,
  ): ExternalReviewEventRow | null {
    const byEventId = this.db
      .prepare("SELECT * FROM external_review_events WHERE event_id = ?")
      .get(input.eventId) as ExternalReviewEventDbRow | undefined;
    if (byEventId !== undefined) return toRow(byEventId);
    if (input.githubReviewId === undefined || input.githubReviewId === null) {
      return null;
    }
    // Dedup matches the (github_review_id, state) unique index: re-polling the
    // same review at the same state collapses, but a state change is a distinct
    // row, so look up by both columns.
    const byReview = this.db
      .prepare(
        "SELECT * FROM external_review_events WHERE github_review_id = ? AND state = ?",
      )
      .get(input.githubReviewId, input.state) as
      | ExternalReviewEventDbRow
      | undefined;
    return byReview === undefined ? null : toRow(byReview);
  }
}

function scopedWhere(filter: ExternalReviewEventSummaryFilter): {
  sql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.hitchId !== undefined) {
    clauses.push("hitch_id = ?");
    params.push(filter.hitchId);
  }
  if (filter.repoId !== undefined) {
    clauses.push("repo_id = ?");
    params.push(filter.repoId);
  }
  if (filter.prNumber !== undefined) {
    clauses.push("pr_number = ?");
    params.push(filter.prNumber);
  }
  return {
    sql: clauses.length === 0 ? "1 = 1" : clauses.join(" AND "),
    params,
  };
}

function zeroStateCounts(): Record<ExternalReviewState, number> {
  return {
    approved: 0,
    changes_requested: 0,
    commented: 0,
    dismissed: 0,
    pending: 0,
  };
}

function zeroReviewerCounts(): Record<ExternalReviewerType, number> {
  return {
    codex_app: 0,
    copilot: 0,
    human: 0,
    other: 0,
  };
}

function assertKnownState(state: ExternalReviewState): void {
  if (!EXTERNAL_REVIEW_STATES.includes(state)) {
    throw new Error(
      `CHECK constraint failed: external_review_events.state (${state})`,
    );
  }
}

function assertKnownReviewerType(reviewerType: ExternalReviewerType): void {
  if (!EXTERNAL_REVIEWER_TYPES.includes(reviewerType)) {
    throw new Error(
      `CHECK constraint failed: external_review_events.reviewer_type (${reviewerType})`,
    );
  }
}

function toRow(row: ExternalReviewEventDbRow): ExternalReviewEventRow {
  return {
    eventId: row.event_id,
    hitchId: row.hitch_id,
    runId: row.run_id,
    repoId: row.repo_id,
    prNumber: row.pr_number,
    author: row.author,
    reviewerType: row.reviewer_type,
    state: row.state,
    githubReviewId: row.github_review_id,
    submittedAt: row.submitted_at,
    summary: row.summary,
    redacted: row.redacted !== 0,
    createdAt: row.created_at,
  };
}
