import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  metricsSummary,
  tokenUsageSummary,
  type AggregateFilter,
  type DbMetricsSummary,
  type DbTokenUsageSummary,
} from "./aggregates.js";
import {
  hitchMetricsSummary,
  mcpConfirmationSummary,
  type DbHitchMetricsSummary,
  type DbMcpConfirmationSummary,
} from "./convergence-aggregates.js";

const PAYLOAD_SCHEMA = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MetricsSnapshotPayloadV1 {
  schema: 1;
  capturedAt: string;
  filter: AggregateFilter;
  metricsSummary: DbMetricsSummary;
  hitchMetricsSummary: DbHitchMetricsSummary;
  tokenUsageSummary: DbTokenUsageSummary;
  mcpConfirmationSummary: DbMcpConfirmationSummary;
}

export interface MetricsSnapshotRow {
  snapshotId: string;
  createdAt: string;
  projectId: string | null;
  repoId: string | null;
  domain: string | null;
  payloadJson: string;
  payloadSchema: number;
}

export interface RecordMetricsSnapshotInput {
  filter: AggregateFilter;
  now?: string | Date;
}

export interface PruneMetricsSnapshotsInput {
  retentionDays: number;
  now?: string | Date;
}

export interface ListMetricsSnapshotsInput {
  filter: AggregateFilter;
  since?: string;
  limit?: number;
}

function isoNow(now: string | Date | undefined): string {
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid metrics snapshot timestamp: ${String(now)}`);
  }
  return date.toISOString();
}

function normalizeFilter(filter: AggregateFilter): AggregateFilter {
  return {
    ...(filter.projectId !== undefined ? { projectId: filter.projectId } : {}),
    ...(filter.repoId !== undefined ? { repoId: filter.repoId } : {}),
    ...(filter.domain !== undefined ? { domain: filter.domain } : {}),
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
  };
}

function confirmationDateFilter(
  filter: AggregateFilter,
): Pick<AggregateFilter, "since" | "until"> {
  return {
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    ...(filter.until !== undefined ? { until: filter.until } : {}),
  };
}

function rowFromDb(row: {
  snapshot_id: string;
  created_at: string;
  project_id: string | null;
  repo_id: string | null;
  domain: string | null;
  payload_json: string;
  payload_schema: number;
}): MetricsSnapshotRow {
  return {
    snapshotId: row.snapshot_id,
    createdAt: row.created_at,
    projectId: row.project_id,
    repoId: row.repo_id,
    domain: row.domain,
    payloadJson: row.payload_json,
    payloadSchema: row.payload_schema,
  };
}

export function recordMetricsSnapshot(
  db: Database.Database,
  input: RecordMetricsSnapshotInput,
): MetricsSnapshotRow {
  const capturedAt = isoNow(input.now);
  const filter = normalizeFilter(input.filter);
  const payload: MetricsSnapshotPayloadV1 = {
    schema: PAYLOAD_SCHEMA,
    capturedAt,
    filter,
    metricsSummary: metricsSummary(db, filter),
    hitchMetricsSummary: hitchMetricsSummary(db, filter),
    tokenUsageSummary: tokenUsageSummary(db, filter),
    mcpConfirmationSummary: mcpConfirmationSummary(
      db,
      confirmationDateFilter(filter),
      capturedAt,
    ),
  };
  const snapshotId = `msnap-${randomUUID()}`;
  db.prepare(
    `INSERT INTO metrics_snapshots
       (snapshot_id, created_at, project_id, repo_id, domain, payload_json,
        payload_schema)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshotId,
    capturedAt,
    filter.projectId ?? null,
    filter.repoId ?? null,
    filter.domain ?? null,
    JSON.stringify(payload),
    PAYLOAD_SCHEMA,
  );
  const row = db
    .prepare(
      `SELECT snapshot_id, created_at, project_id, repo_id, domain,
              payload_json, payload_schema
         FROM metrics_snapshots
        WHERE snapshot_id = ?`,
    )
    .get(snapshotId) as Parameters<typeof rowFromDb>[0] | undefined;
  if (row === undefined) {
    throw new Error(`metrics snapshot insert was not readable: ${snapshotId}`);
  }
  return rowFromDb(row);
}

export function pruneMetricsSnapshots(
  db: Database.Database,
  input: PruneMetricsSnapshotsInput,
): number {
  if (
    !Number.isFinite(input.retentionDays) ||
    !Number.isInteger(input.retentionDays) ||
    input.retentionDays < 0
  ) {
    throw new Error(
      `retentionDays must be a non-negative integer: ${String(input.retentionDays)}`,
    );
  }
  const nowMs = new Date(isoNow(input.now)).getTime();
  const cutoff = new Date(nowMs - input.retentionDays * DAY_MS).toISOString();
  const result = db
    .prepare("DELETE FROM metrics_snapshots WHERE created_at < ?")
    .run(cutoff);
  return result.changes;
}

export function listMetricsSnapshots(
  db: Database.Database,
  input: ListMetricsSnapshotsInput,
): MetricsSnapshotRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const filter = normalizeFilter(input.filter);
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
  if (input.since !== undefined) {
    where.push("created_at >= ?");
    params.push(input.since);
  }
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const limitSql = input.limit === undefined ? "" : " LIMIT ?";
  if (input.limit !== undefined) {
    if (
      !Number.isFinite(input.limit) ||
      !Number.isInteger(input.limit) ||
      input.limit < 0
    ) {
      throw new Error(`limit must be a non-negative integer: ${String(input.limit)}`);
    }
    params.push(input.limit);
  }
  const rows = db
    .prepare(
      `SELECT snapshot_id, created_at, project_id, repo_id, domain,
              payload_json, payload_schema
         FROM metrics_snapshots
        ${whereSql}
        ORDER BY created_at DESC, snapshot_id DESC${limitSql}`,
    )
    .all(...params) as Parameters<typeof rowFromDb>[0][];
  return rows.map(rowFromDb);
}
