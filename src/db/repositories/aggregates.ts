import type Database from "better-sqlite3";
import {
  RunRepository,
  type DashboardRunSummary,
} from "./runs.js";

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
}

/** WHERE over the `project_id` / `repo_id` / `domain` columns (shared shape). */
function whereScope(filter: AggregateFilter): {
  sql: string;
  params: unknown[];
} {
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
}

export function metricsSummary(
  db: Database.Database,
  filter: AggregateFilter = {},
): DbMetricsSummary {
  const { sql, params } = whereScope(filter);
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
  return {
    totalRuns: total,
    byStatus,
    approved,
    needsReview: byStatus.needs_review ?? 0,
    failed,
    approvedRate: decided === 0 ? null : approved / decided,
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
}

/** A high cap so inbox buckets are not silently truncated. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

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
  const { sql, params } = whereScope(filter);
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
  // promoted entries (`docs/knowledge/**`) carry no project_id / repo_id in
  // their frontmatter — promoted-knowledge namespacing is a documented
  // Phase 5 follow-up — so entryTotal is always the global count.
  const entryTotal = (
    db
      .prepare("SELECT count(*) AS n FROM knowledge_entries")
      .get() as { n: number }
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
  const { sql, params } = whereScope(filter);
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
