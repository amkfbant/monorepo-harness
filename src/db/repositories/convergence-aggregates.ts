import type Database from "better-sqlite3";
import type { AggregateFilter } from "./aggregates.js";

export interface DbHitchMetricsSummary {
  totalSessions: number;
  byStatus: Record<string, number>;
  avgReviewCycles: number | null;
  avgRerunAttempts: number | null;
  /** in-scope findings only, counted per severity */
  findingsBySeverity: Record<string, number>;
  /**
   * fixed / (fixed + open + reopened + escalated) over in-scope findings.
   * deferred / duplicate / accepted_risk are outside both numerator and
   * denominator — they were never resolved by fixing.
   */
  findingResolutionRate: number | null;
  /**
   * in-scope findings with reopen_count > 0 / ALL in-scope findings.
   * Unlike findingResolutionRate this deliberately keeps deferred /
   * accepted_risk in the denominator: a finding that churned before
   * being deferred still counts as review churn.
   */
  reopenRate: number | null;
}

export interface DbMcpConfirmationSummary {
  total: number;
  byStatus: Record<string, number>;
  confirmationRate: number | null;
  expiredRate: number | null;
}

type GroupCountRow = { key: string; n: number };

function groupCounts(rows: readonly GroupCountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.key, r.n]));
}

function hitchScope(
  filter: AggregateFilter,
): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.repoId !== undefined) {
    where.push("repo_id = ?");
    params.push(filter.repoId);
  }
  if (filter.domain !== undefined) {
    where.push("domain = ?");
    params.push(filter.domain);
  }
  if (filter.since !== undefined) {
    where.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push("created_at <= ?");
    params.push(filter.until);
  }
  return {
    whereSql: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    params,
  };
}

function dateScope(
  filter: Pick<AggregateFilter, "since" | "until">,
): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.since !== undefined) {
    where.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push("created_at <= ?");
    params.push(filter.until);
  }
  return {
    whereSql: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`,
    params,
  };
}

function scopedHitchCte(whereSql: string): string {
  return `WITH scoped_sessions AS (
    SELECT hitch_id, status FROM hitch_sessions ${whereSql}
  )`;
}

export function hitchMetricsSummary(
  db: Database.Database,
  filter: AggregateFilter = {},
): DbHitchMetricsSummary {
  const { whereSql, params } = hitchScope(filter);
  const scoped = scopedHitchCte(whereSql);
  const statusRows = db
    .prepare(
      `${scoped}
       SELECT status AS key, count(*) AS n
         FROM scoped_sessions
        GROUP BY status`,
    )
    .all(...params) as GroupCountRow[];
  const byStatus = groupCounts(statusRows);
  const totalSessions = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  const childCounts = db
    .prepare(
      `${scoped}
       SELECT
         (SELECT count(*)
            FROM hitch_review_cycles c
            JOIN scoped_sessions s ON s.hitch_id = c.hitch_id) AS reviewCycles,
         (SELECT count(*)
            FROM hitch_attempts a
            JOIN scoped_sessions s ON s.hitch_id = a.hitch_id
           WHERE a.attempt_type = 'rerun') AS rerunAttempts`,
    )
    .get(...params) as { reviewCycles: number; rerunAttempts: number };
  const findingsBySeverity = groupCounts(
    db
      .prepare(
        `${scoped}
         SELECT f.severity AS key, count(*) AS n
           FROM hitch_findings f
           JOIN scoped_sessions s ON s.hitch_id = f.hitch_id
          WHERE f.scope_status = 'in_scope'
          GROUP BY f.severity`,
      )
      .all(...params) as GroupCountRow[],
  );
  const resolution = db
    .prepare(
      `${scoped}
       SELECT
         sum(CASE WHEN f.lifecycle_status = 'fixed' THEN 1 ELSE 0 END) AS fixed,
         sum(CASE WHEN f.lifecycle_status IN (
           'fixed', 'open', 'reopened', 'escalated'
         ) THEN 1 ELSE 0 END) AS denominator
        FROM hitch_findings f
        JOIN scoped_sessions s ON s.hitch_id = f.hitch_id
       WHERE f.scope_status = 'in_scope'`,
    )
    .get(...params) as { fixed: number | null; denominator: number | null };
  const reopen = db
    .prepare(
      `${scoped}
       SELECT
         sum(CASE WHEN f.reopen_count > 0 THEN 1 ELSE 0 END) AS reopened,
         count(*) AS total
        FROM hitch_findings f
        JOIN scoped_sessions s ON s.hitch_id = f.hitch_id
       WHERE f.scope_status = 'in_scope'`,
    )
    .get(...params) as { reopened: number | null; total: number };
  const resolutionFixed = resolution.fixed ?? 0;
  const resolutionDenominator = resolution.denominator ?? 0;
  const reopenedFindings = reopen.reopened ?? 0;

  return {
    totalSessions,
    byStatus,
    avgReviewCycles:
      totalSessions === 0 ? null : childCounts.reviewCycles / totalSessions,
    avgRerunAttempts:
      totalSessions === 0 ? null : childCounts.rerunAttempts / totalSessions,
    findingsBySeverity,
    findingResolutionRate:
      resolutionDenominator === 0
        ? null
        : resolutionFixed / resolutionDenominator,
    reopenRate: reopen.total === 0 ? null : reopenedFindings / reopen.total,
  };
}

export function mcpConfirmationSummary(
  db: Database.Database,
  filter: Pick<AggregateFilter, "since" | "until"> = {},
): DbMcpConfirmationSummary {
  const { whereSql, params } = dateScope(filter);
  const statusRows = db
    .prepare(
      `SELECT status AS key, count(*) AS n
         FROM mcp_confirmation_requests ${whereSql}
        GROUP BY status`,
    )
    .all(...params) as GroupCountRow[];
  const byStatus = groupCounts(statusRows);
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  const confirmed = byStatus.confirmed ?? 0;
  const consumed = byStatus.consumed ?? 0;
  const rejected = byStatus.rejected ?? 0;
  const expired = byStatus.expired ?? 0;
  const denominator = confirmed + consumed + rejected + expired;

  return {
    total,
    byStatus,
    confirmationRate:
      denominator === 0 ? null : (confirmed + consumed) / denominator,
    expiredRate: denominator === 0 ? null : expired / denominator,
  };
}
