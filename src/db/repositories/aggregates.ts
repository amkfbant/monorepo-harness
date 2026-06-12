import type Database from "better-sqlite3";
import {
  RunRepository,
  type DashboardRunSummary,
} from "./runs.js";
import { knowledgeEntriesHasCategory } from "./knowledge-entry-revisions.js";

/**
 * Project-aware aggregates over the DB read model (Phase 6-6).
 *
 * Closes the Phase 5 follow-up: `metrics` / `inbox` / `knowledge digest` /
 * `backlog` can now be scoped by project / repo / domain. The dashboard
 * snapshot (6-7) consumes these directly.
 */

export interface AggregateFilter {
  projectId?: string;
  repoId?: string;
  domain?: string;
  /** ISO lower bound on the table's date column (inclusive) */
  since?: string;
  /** ISO upper bound on the table's date column (inclusive) */
  until?: string;
  /** exact status match (backlog) */
  status?: string;
}

/**
 * WHERE over `project_id` / `repo_id` / `domain` plus optional date-range
 * and status filters. `dateColumn` / `statusColumn` name the table's
 * columns (they differ per table — `started_at` vs `created_at`).
 */
function whereScope(
  filter: AggregateFilter,
  opts: { dateColumn?: string; statusColumn?: string } = {},
): { sql: string; params: unknown[] } {
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
  if (opts.dateColumn !== undefined && filter.since !== undefined) {
    where.push(`${opts.dateColumn} >= ?`);
    params.push(filter.since);
  }
  if (opts.dateColumn !== undefined && filter.until !== undefined) {
    where.push(`${opts.dateColumn} <= ?`);
    params.push(filter.until);
  }
  if (opts.statusColumn !== undefined && filter.status !== undefined) {
    where.push(`${opts.statusColumn} = ?`);
    params.push(filter.status);
  }
  return {
    sql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export interface DbMetricsSummary {
  totalRuns: number;
  byStatus: Record<string, number>;
  approved: number;
  needsReview: number;
  failed: number;
  /** approved / (approved + changes_requested + rejected), or null if none */
  approvedRate: number | null;
  /** root approved / root decided, or null if no root run is decided */
  oneShotApprovalRate: number | null;
  /** runs with at least one policy violation / totalRuns, or null if no runs */
  policyViolationRate: number | null;
  /** runs with secret_suspect_count > 0 / totalRuns, or null if no runs */
  secretSuspectRate: number | null;
}

export function metricsSummary(
  db: Database.Database,
  filter: AggregateFilter = {},
): DbMetricsSummary {
  const { sql, params } = whereScope(filter, { dateColumn: "started_at" });
  const rows = db
    .prepare(`SELECT status, count(*) AS n FROM runs ${sql} GROUP BY status`)
    .all(...params) as { status: string; n: number }[];
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = r.n;
    total += r.n;
  }
  const approved = byStatus.approved ?? 0;
  const changesRequested = byStatus.changes_requested ?? 0;
  const rejected = byStatus.rejected ?? 0;
  const decided = approved + changesRequested + rejected;
  const failed = Object.entries(byStatus)
    .filter(([s]) => s.startsWith("failed"))
    .reduce((sum, [, n]) => sum + n, 0);
  const rootSql =
    sql === ""
      ? "WHERE parent_run_id IS NULL"
      : `${sql} AND parent_run_id IS NULL`;
  const secretSql =
    sql === ""
      ? "WHERE secret_suspect_count > 0"
      : `${sql} AND secret_suspect_count > 0`;
  const rootDecision = db
    .prepare(
      `SELECT
         sum(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
         sum(CASE WHEN status IN ('approved', 'changes_requested', 'rejected')
           THEN 1 ELSE 0 END) AS decided
       FROM runs ${rootSql}`,
    )
    .get(...params) as { approved: number | null; decided: number | null };
  const rootApproved = rootDecision.approved ?? 0;
  const rootDecided = rootDecision.decided ?? 0;
  const policyViolationRuns = (
    db
      .prepare(
        `SELECT count(DISTINCT v.run_id) AS n
         FROM policy_violations v
         JOIN (SELECT run_id FROM runs ${sql}) scoped
           ON scoped.run_id = v.run_id`,
      )
      .get(...params) as { n: number }
  ).n;
  const secretSuspectRuns = (
    db
      .prepare(
        `SELECT count(*) AS n FROM runs ${secretSql}`,
      )
      .get(...params) as { n: number }
  ).n;
  return {
    totalRuns: total,
    byStatus,
    approved,
    needsReview: byStatus.needs_review ?? 0,
    failed,
    approvedRate: decided === 0 ? null : approved / decided,
    oneShotApprovalRate:
      rootDecided === 0 ? null : rootApproved / rootDecided,
    policyViolationRate: total === 0 ? null : policyViolationRuns / total,
    secretSuspectRate: total === 0 ? null : secretSuspectRuns / total,
  };
}

export interface DbInboxSummary {
  needsReview: DashboardRunSummary[];
  changesRequested: DashboardRunSummary[];
  failed: DashboardRunSummary[];
  /**
   * runs that produced knowledge candidates. The DB cannot tell which
   * candidates were later promoted/rejected — those decisions live in
   * separate sidecars, not in `knowledge-candidates.yaml` — so this
   * counts every run with candidates.
   */
  knowledgeCandidateRuns: number;
  /**
   * Operational knowledge (issue #57) the operator can recall: a total of
   * non-deprecated entries plus the most-recent few, scoped like the other
   * buckets (project/repo-scoped reads also see portable, project-less
   * entries). This is reference material, not an action queue.
   */
  operationalKnowledge: DbOperationalKnowledgeInbox;
}

export interface DbOperationalKnowledgeRef {
  entryId: string;
  title: string;
  kind: string;
  projectId: string | null;
  domain: string | null;
  updatedAt: string;
}

export interface DbOperationalKnowledgeInbox {
  total: number;
  recent: DbOperationalKnowledgeRef[];
}

/** A high cap so inbox buckets are not silently truncated. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/** How many recent operational entries the inbox surfaces. */
const OPERATIONAL_INBOX_RECENT = 5;

/**
 * Operational-knowledge inbox slice: total non-deprecated entries + the most
 * recent few. Scoped inclusively of portable (project/repo-less) entries, like
 * `listOperationalKnowledge`. Deprecation is read from the current revision's
 * frontmatter (`deprecated: true`), matching the CLI/MCP read path.
 */
function operationalKnowledgeInbox(
  db: Database.Database,
  filter: AggregateFilter,
): DbOperationalKnowledgeInbox {
  // Fail soft on a pre-v19 schema (no category column) — inbox reads can run on
  // a readonly DB opened before migration.
  if (!knowledgeEntriesHasCategory(db)) return { total: 0, recent: [] };
  const where = [
    "e.category = 'operational'",
    "json_extract(r.frontmatter_json, '$.deprecated') IS NOT 1",
  ];
  const params: unknown[] = [];
  if (filter.projectId !== undefined) {
    where.push("(e.project_id = ? OR e.project_id IS NULL)");
    params.push(filter.projectId);
  }
  if (filter.repoId !== undefined) {
    where.push("(e.repo_id = ? OR e.repo_id IS NULL)");
    params.push(filter.repoId);
  }
  if (filter.domain !== undefined) {
    where.push("e.domain = ?");
    params.push(filter.domain);
  }
  const from = `FROM knowledge_entries e
       JOIN knowledge_entry_revisions r ON r.revision_id = e.current_revision_id
      WHERE ${where.join(" AND ")}`;
  const total = (
    db.prepare(`SELECT count(*) AS n ${from}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT e.entry_id, e.kind, e.project_id, e.domain, r.title, r.created_at
       ${from} ORDER BY r.created_at DESC, e.entry_id LIMIT ?`,
    )
    .all(...params, OPERATIONAL_INBOX_RECENT) as Record<string, unknown>[];
  const recent = rows.map((r) => ({
    entryId: r.entry_id as string,
    title: (r.title as string | null) ?? (r.entry_id as string),
    kind: r.kind as string,
    projectId: (r.project_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    updatedAt: r.created_at as string,
  }));
  return { total, recent };
}

export function inboxSummary(
  db: Database.Database,
  filter: AggregateFilter = {},
): DbInboxSummary {
  const repo = new RunRepository(db);
  const failed = repo
    .listRuns({ ...filter, limit: UNBOUNDED })
    .filter((r) => r.status.startsWith("failed"));
  const { sql, params } = whereScope(filter);
  const candRuns = (
    db
      .prepare(
        `SELECT count(DISTINCT run_id) AS n FROM knowledge_candidates ${sql}`,
      )
      .get(...params) as { n: number }
  ).n;
  return {
    needsReview: repo.listRuns({
      ...filter,
      statuses: ["needs_review"],
      limit: UNBOUNDED,
    }),
    changesRequested: repo.listRuns({
      ...filter,
      statuses: ["changes_requested"],
      limit: UNBOUNDED,
    }),
    failed,
    knowledgeCandidateRuns: candRuns,
    operationalKnowledge: operationalKnowledgeInbox(db, filter),
  };
}

export interface DbKnowledgeDigest {
  candidateTotal: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  entryTotal: number;
}

export function knowledgeDigest(
  db: Database.Database,
  filter: AggregateFilter = {},
): DbKnowledgeDigest {
  const { sql, params } = whereScope(filter, { dateColumn: "created_at" });
  const cands = db
    .prepare(
      `SELECT kind, status, count(*) AS n FROM knowledge_candidates
       ${sql} GROUP BY kind, status`,
    )
    .all(...params) as { kind: string; status: string; n: number }[];
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const c of cands) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + c.n;
    byStatus[c.status] = (byStatus[c.status] ?? 0) + c.n;
    total += c.n;
  }
  // entries are scoped the same way candidates are. Promoted entries
  // carry project_id / repo_id only when their frontmatter has them
  // (promoted-knowledge namespacing is a Phase 5 follow-up), so a
  // project-scoped digest may legitimately count zero entries. Operational
  // knowledge (category='operational', issue #57) is a separate category and
  // is excluded from this codebase digest count. On a pre-v19 schema all rows
  // are codebase (no column) → keep the base scope without the category filter.
  const categoryClause = knowledgeEntriesHasCategory(db)
    ? "category = 'codebase'"
    : "";
  const entrySql = categoryClause
    ? sql
      ? `${sql} AND ${categoryClause}`
      : `WHERE ${categoryClause}`
    : sql;
  const entryTotal = (
    db
      .prepare(`SELECT count(*) AS n FROM knowledge_entries ${entrySql}`)
      .get(...params) as { n: number }
  ).n;
  return { candidateTotal: total, byKind, byStatus, entryTotal };
}

export interface DbBacklogItem {
  itemId: string;
  projectId: string | null;
  repoId: string | null;
  domain: string;
  title: string;
  status: string;
  priority: string;
}

export interface DbBacklogSummary {
  items: DbBacklogItem[];
  byStatus: Record<string, number>;
}

export function backlogList(
  db: Database.Database,
  filter: AggregateFilter = {},
): DbBacklogSummary {
  const { sql, params } = whereScope(filter, { statusColumn: "status" });
  const rows = db
    .prepare(
      `SELECT item_id, project_id, repo_id, domain, title, status, priority
       FROM backlog_items ${sql} ORDER BY item_id DESC`,
    )
    .all(...params) as {
    item_id: string;
    project_id: string | null;
    repo_id: string | null;
    domain: string;
    title: string;
    status: string;
    priority: string;
  }[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    items: rows.map((r) => ({
      itemId: r.item_id,
      projectId: r.project_id,
      repoId: r.repo_id,
      domain: r.domain,
      title: r.title,
      status: r.status,
      priority: r.priority,
    })),
    byStatus,
  };
}
