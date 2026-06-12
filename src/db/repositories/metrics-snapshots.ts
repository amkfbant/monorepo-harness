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
  mcpConfirmationSummary?: DbMcpConfirmationSummary;
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

export interface MetricsDeltaValue {
  baseline: number | null;
  current: number | null;
  delta: number | null;
}

export interface SkippedMetricsSnapshot {
  snapshotId: string;
  createdAt: string;
  reason: string;
}

export interface MetricsDeltaOk {
  status: "ok";
  baselineAt: string;
  currentAt: string;
  filter: AggregateFilter;
  baseline: Pick<MetricsSnapshotRow, "snapshotId" | "createdAt">;
  skippedSnapshots: SkippedMetricsSnapshot[];
  metrics: {
    totalRuns: MetricsDeltaValue;
    approved: MetricsDeltaValue;
    approvedRate: MetricsDeltaValue;
    oneShotApprovalRate: MetricsDeltaValue;
    policyViolationRate: MetricsDeltaValue;
    secretSuspectRate: MetricsDeltaValue;
  };
  hitch: {
    totalSessions: MetricsDeltaValue;
    findingResolutionRate: MetricsDeltaValue;
  };
  usage: {
    totalTokens: MetricsDeltaValue;
  };
  mcpConfirmations?: {
    total: MetricsDeltaValue;
    confirmationRate: MetricsDeltaValue;
    expiredRate: MetricsDeltaValue;
  };
}

export interface MetricsDeltaMissingBaseline {
  status: "missing-baseline";
  baselineAt: string;
  currentAt: string;
  filter: AggregateFilter;
  skippedSnapshots: SkippedMetricsSnapshot[];
}

export type MetricsDeltaResult = MetricsDeltaOk | MetricsDeltaMissingBaseline;

export interface BuildMetricsDeltaInput {
  filter: AggregateFilter;
  baselineAt: string;
  now?: string | Date;
}

export interface MetricsTrendPoint {
  createdAt: string;
  totalRuns: number;
  approvedRate: number | null;
  totalTokens: number;
}

export interface ListMetricsTrendInput {
  filter: AggregateFilter;
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

function exactSnapshotScope(filter: AggregateFilter): {
  clauses: string[];
  params: unknown[];
} {
  const normalized = normalizeFilter(filter);
  return {
    clauses: [
      normalized.projectId === undefined
        ? "project_id IS NULL"
        : "project_id = ?",
      normalized.repoId === undefined ? "repo_id IS NULL" : "repo_id = ?",
      normalized.domain === undefined ? "domain IS NULL" : "domain = ?",
    ],
    params: [
      ...(normalized.projectId === undefined ? [] : [normalized.projectId]),
      ...(normalized.repoId === undefined ? [] : [normalized.repoId]),
      ...(normalized.domain === undefined ? [] : [normalized.domain]),
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every((v) => typeof v === "number")
  );
}

function isMetricsSummary(value: unknown): value is DbMetricsSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.totalRuns === "number" &&
    isNumberRecord(value.byStatus) &&
    typeof value.approved === "number" &&
    typeof value.needsReview === "number" &&
    typeof value.failed === "number" &&
    isNumberOrNull(value.approvedRate) &&
    isNumberOrNull(value.oneShotApprovalRate) &&
    isNumberOrNull(value.policyViolationRate) &&
    isNumberOrNull(value.secretSuspectRate)
  );
}

function isHitchMetricsSummary(value: unknown): value is DbHitchMetricsSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.totalSessions === "number" &&
    isNumberRecord(value.byStatus) &&
    isNumberOrNull(value.avgReviewCycles) &&
    isNumberOrNull(value.avgRerunAttempts) &&
    isNumberRecord(value.findingsBySeverity) &&
    isNumberOrNull(value.findingResolutionRate) &&
    isNumberOrNull(value.reopenRate)
  );
}

function isTokenUsageSummary(value: unknown): value is DbTokenUsageSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.runsWithUsage === "number" &&
    typeof value.totalInputTokens === "number" &&
    typeof value.totalOutputTokens === "number" &&
    typeof value.totalTokens === "number" &&
    isNumberRecord(value.bySource)
  );
}

function isMcpConfirmationSummary(
  value: unknown,
): value is DbMcpConfirmationSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.total === "number" &&
    isNumberRecord(value.byStatus) &&
    isNumberOrNull(value.confirmationRate) &&
    isNumberOrNull(value.expiredRate)
  );
}

function parseSnapshotPayload(
  row: MetricsSnapshotRow,
): { payload: MetricsSnapshotPayloadV1 } | { reason: string } {
  if (row.payloadSchema !== PAYLOAD_SCHEMA) {
    return { reason: `unsupported payload_schema ${row.payloadSchema}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson) as unknown;
  } catch {
    return { reason: "invalid payload_json" };
  }
  if (!isRecord(parsed) || parsed.schema !== PAYLOAD_SCHEMA) {
    return { reason: "unsupported payload schema" };
  }
  if (
    typeof parsed.capturedAt !== "string" ||
    !isRecord(parsed.filter) ||
    !isMetricsSummary(parsed.metricsSummary) ||
    !isHitchMetricsSummary(parsed.hitchMetricsSummary) ||
    !isTokenUsageSummary(parsed.tokenUsageSummary)
  ) {
    return { reason: "invalid payload shape" };
  }
  if (
    parsed.mcpConfirmationSummary !== undefined &&
    !isMcpConfirmationSummary(parsed.mcpConfirmationSummary)
  ) {
    return { reason: "invalid mcp confirmation payload shape" };
  }
  return {
    payload: {
      schema: PAYLOAD_SCHEMA,
      capturedAt: parsed.capturedAt,
      filter: normalizeFilter(parsed.filter),
      metricsSummary: parsed.metricsSummary,
      hitchMetricsSummary: parsed.hitchMetricsSummary,
      tokenUsageSummary: parsed.tokenUsageSummary,
      ...(parsed.mcpConfirmationSummary !== undefined
        ? { mcpConfirmationSummary: parsed.mcpConfirmationSummary }
        : {}),
    },
  };
}

function deltaValue(
  baseline: number | null,
  current: number | null,
): MetricsDeltaValue {
  return {
    baseline,
    current,
    delta: baseline === null || current === null ? null : current - baseline,
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
  const scope = exactSnapshotScope(input.filter);
  const sinceClauses = input.since === undefined ? [] : ["created_at >= ?"];
  const whereSql = `WHERE ${[...scope.clauses, ...sinceClauses].join(" AND ")}`;
  const limitSql = input.limit === undefined ? "" : " LIMIT ?";
  const params = [
    ...scope.params,
    ...(input.since === undefined ? [] : [input.since]),
    ...(input.limit === undefined ? [] : [input.limit]),
  ];
  if (input.limit !== undefined) {
    if (
      !Number.isFinite(input.limit) ||
      !Number.isInteger(input.limit) ||
      input.limit < 0
    ) {
      throw new Error(`limit must be a non-negative integer: ${String(input.limit)}`);
    }
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

function listBaselineCandidates(
  db: Database.Database,
  filter: AggregateFilter,
  baselineAt: string,
): MetricsSnapshotRow[] {
  const scope = exactSnapshotScope(filter);
  const where = ["created_at <= ?", ...scope.clauses];
  const params = [baselineAt, ...scope.params];
  const rows = db
    .prepare(
      `SELECT snapshot_id, created_at, project_id, repo_id, domain,
              payload_json, payload_schema
         FROM metrics_snapshots
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, snapshot_id DESC`,
    )
    .all(...params) as Parameters<typeof rowFromDb>[0][];
  return rows.map(rowFromDb);
}

export function buildMetricsDelta(
  db: Database.Database,
  input: BuildMetricsDeltaInput,
): MetricsDeltaResult {
  const currentAt = isoNow(input.now);
  const filter = normalizeFilter(input.filter);
  const skippedSnapshots: SkippedMetricsSnapshot[] = [];
  for (const row of listBaselineCandidates(db, filter, input.baselineAt)) {
    const parsed = parseSnapshotPayload(row);
    if ("reason" in parsed) {
      skippedSnapshots.push({
        snapshotId: row.snapshotId,
        createdAt: row.createdAt,
        reason: parsed.reason,
      });
      continue;
    }
    const baseline = parsed.payload;
    const currentMetrics = metricsSummary(db, filter);
    const currentHitch = hitchMetricsSummary(db, filter);
    const currentUsage = tokenUsageSummary(db, filter);
    const currentMcp = mcpConfirmationSummary(
      db,
      confirmationDateFilter(filter),
      currentAt,
    );
    return {
      status: "ok",
      baselineAt: input.baselineAt,
      currentAt,
      filter,
      baseline: { snapshotId: row.snapshotId, createdAt: row.createdAt },
      skippedSnapshots,
      metrics: {
        totalRuns: deltaValue(
          baseline.metricsSummary.totalRuns,
          currentMetrics.totalRuns,
        ),
        approved: deltaValue(
          baseline.metricsSummary.approved,
          currentMetrics.approved,
        ),
        approvedRate: deltaValue(
          baseline.metricsSummary.approvedRate,
          currentMetrics.approvedRate,
        ),
        oneShotApprovalRate: deltaValue(
          baseline.metricsSummary.oneShotApprovalRate,
          currentMetrics.oneShotApprovalRate,
        ),
        policyViolationRate: deltaValue(
          baseline.metricsSummary.policyViolationRate,
          currentMetrics.policyViolationRate,
        ),
        secretSuspectRate: deltaValue(
          baseline.metricsSummary.secretSuspectRate,
          currentMetrics.secretSuspectRate,
        ),
      },
      hitch: {
        totalSessions: deltaValue(
          baseline.hitchMetricsSummary.totalSessions,
          currentHitch.totalSessions,
        ),
        findingResolutionRate: deltaValue(
          baseline.hitchMetricsSummary.findingResolutionRate,
          currentHitch.findingResolutionRate,
        ),
      },
      usage: {
        totalTokens: deltaValue(
          baseline.tokenUsageSummary.totalTokens,
          currentUsage.totalTokens,
        ),
      },
      ...(baseline.mcpConfirmationSummary !== undefined
        ? {
            mcpConfirmations: {
              total: deltaValue(
                baseline.mcpConfirmationSummary.total,
                currentMcp.total,
              ),
              confirmationRate: deltaValue(
                baseline.mcpConfirmationSummary.confirmationRate,
                currentMcp.confirmationRate,
              ),
              expiredRate: deltaValue(
                baseline.mcpConfirmationSummary.expiredRate,
                currentMcp.expiredRate,
              ),
            },
          }
        : {}),
    };
  }
  return {
    status: "missing-baseline",
    baselineAt: input.baselineAt,
    currentAt,
    filter,
    skippedSnapshots,
  };
}

export function listMetricsTrend(
  db: Database.Database,
  input: ListMetricsTrendInput,
): MetricsTrendPoint[] {
  const limit = input.limit ?? 30;
  const rows = listMetricsSnapshots(db, {
    filter: input.filter,
    limit,
  });
  return rows
    .map((row): MetricsTrendPoint | null => {
      const parsed = parseSnapshotPayload(row);
      if ("reason" in parsed) return null;
      return {
        createdAt: row.createdAt,
        totalRuns: parsed.payload.metricsSummary.totalRuns,
        approvedRate: parsed.payload.metricsSummary.approvedRate,
        totalTokens: parsed.payload.tokenUsageSummary.totalTokens,
      };
    })
    .filter((point): point is MetricsTrendPoint => point !== null)
    .reverse();
}
