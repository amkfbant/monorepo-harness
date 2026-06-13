import process from "node:process";
import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import { withManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { runFullImport } from "../db/import-files.js";
import { parseDuration } from "../core/maintenance.js";
import {
  metricsSummary,
  tokenUsageSummary,
  inboxSummary,
  knowledgeDigest,
  backlogList,
  type AggregateFilter,
  type DbMetricsSummary,
  type DbTokenUsageSummary,
} from "../db/repositories/aggregates.js";
import {
  hitchMetricsSummary,
  mcpConfirmationSummary,
  type DbHitchMetricsSummary,
  type DbMcpConfirmationSummary,
} from "../db/repositories/convergence-aggregates.js";
import {
  buildMetricsDelta,
  recordAndPruneMetricsSnapshot,
  type MetricsDeltaResult,
  type MetricsDeltaValue,
  type MetricsSnapshotRow,
} from "../db/repositories/metrics-snapshots.js";

/**
 * Project-scoped CLI paths (Phase 6-6).
 *
 * `metrics` / `inbox` / `knowledge digest` / `backlog list` gain
 * `--project` / `--repo-id` / `--domain`. When any is given the command
 * answers from the DB read model (refreshed from files first), closing
 * the Phase 5 follow-up. With no scope flag the existing file-based path
 * is unchanged.
 */

/**
 * True when a project/repo scope is requested. `--domain` alone is NOT a
 * trigger — some commands (`knowledge digest`) already own a file-based
 * `--domain`; it only refines a project/repo-scoped DB query.
 */
export function hasScopeFilter(raw: Record<string, unknown>): boolean {
  return raw.project !== undefined || raw.repoId !== undefined;
}

function scopeFilter(raw: Record<string, unknown>): AggregateFilter {
  // `--today` (inbox) and `--since <dur>` (metrics / knowledge digest) both
  // resolve to an ISO lower bound on the table's date column.
  let since: string | undefined;
  if (raw.today === true) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    since = d.toISOString();
  } else if (raw.since !== undefined) {
    try {
      since = new Date(
        Date.now() - parseDuration(String(raw.since)),
      ).toISOString();
    } catch (e) {
      process.stderr.write(`harness error: ${(e as Error).message}\n`);
      process.exit(1);
    }
  }
  return {
    ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
    ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
    ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
    ...(raw.status !== undefined ? { status: String(raw.status) } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

function snapshotScopeFilter(raw: Record<string, unknown>): AggregateFilter {
  return {
    ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
    ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
    ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
  };
}

/**
 * Open the DB, fully rebuild it from files, run `fn`, always close.
 *
 * `reset: true` makes the read model a faithful snapshot of the current
 * files — a run/backlog/knowledge source that was deleted since the last
 * import does not linger, so a scoped query is never stale.
 */
function withRefreshedDb<T>(
  harnessRoot: string,
  fn: (db: Database.Database) => T,
): T {
  const { dbPath } = harnessPaths(harnessRoot);
  // Phase 9 post-close P0 fix: hold the shared maintenance lock for the
  // lifetime of the import + scoped query.
  return withManagedDb({ dbPath }, (db) => {
    runMigrations(db);
    runFullImport(db, { harnessRoot, reset: true });
    return fn(db);
  });
}

/** Warn (once) when a flag the scoped DB path does not honor is present. */
function warnIgnored(
  raw: Record<string, unknown>,
  command: string,
  flags: { key: string; flag: string }[],
): void {
  const ignored = flags
    .filter((f) => raw[f.key] !== undefined && raw[f.key] !== false)
    .map((f) => f.flag);
  if (ignored.length > 0) {
    process.stderr.write(
      `warning: ${command} --project/--repo-id ignores ${ignored.join(", ")} ` +
        `(DB-scoped path)\n`,
    );
  }
}

function emit(raw: Record<string, unknown>, value: unknown, text: string): void {
  process.stdout.write(
    raw.json === true ? `${JSON.stringify(value, null, 2)}\n` : text,
  );
}

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(0)}%`;
}

function pct1(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function fixed(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function parseRetentionDays(raw: unknown): number {
  const value = raw === undefined ? 90 : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    process.stderr.write(
      `harness error: --retention-days must be a non-negative integer ` +
        `(got ${JSON.stringify(String(raw))})\n`,
    );
    process.exit(1);
  }
  return value;
}

function statusLines(values: Record<string, number>): string {
  return Object.keys(values)
    .sort()
    .map((s) => `  ${s}: ${values[s]}`)
    .join("\n");
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function deltaLine(label: string, value: MetricsDeltaValue): string {
  const delta = value.delta === null ? "n/a" : signed(value.delta);
  return `  ${label}: ${value.baseline ?? "n/a"} -> ${value.current ?? "n/a"} (${delta})`;
}

function deltaRateLine(label: string, value: MetricsDeltaValue): string {
  const delta =
    value.delta === null ? "n/a" : `${signed(Number((value.delta * 100).toFixed(1)))}pp`;
  return `  ${label}: ${pct1(value.baseline)} -> ${pct1(value.current)} (${delta})`;
}

function metricsDeltaText(result: MetricsDeltaResult): string {
  if (result.status === "missing-baseline") {
    return (
      `no metrics snapshot found at or before ${result.baselineAt} ` +
      `for ${scopeLabel(result.filter)}\n`
    );
  }
  return [
    `metrics delta ${scopeLabel(result.filter)}`,
    `baseline: ${result.baseline.snapshotId} (${result.baseline.createdAt})`,
    `current: ${result.currentAt}`,
    deltaLine("total runs", result.metrics.totalRuns),
    deltaLine("approved", result.metrics.approved),
    deltaRateLine("approved rate", result.metrics.approvedRate),
    deltaRateLine("one-shot approval rate", result.metrics.oneShotApprovalRate),
    deltaRateLine("policy violation rate", result.metrics.policyViolationRate),
    deltaRateLine("secret suspect rate", result.metrics.secretSuspectRate),
    deltaLine("lock contention count", result.metrics.lockContentionCount),
    deltaLine("hitch total sessions", result.hitch.totalSessions),
    deltaRateLine(
      "finding resolution rate",
      result.hitch.findingResolutionRate,
    ),
    deltaLine("total tokens", result.usage.totalTokens),
    ...(result.mcpConfirmations === undefined
      ? []
      : [
          deltaLine("mcp confirmations", result.mcpConfirmations.total),
          deltaRateLine(
            "mcp confirmation rate",
            result.mcpConfirmations.confirmationRate,
          ),
          deltaRateLine("mcp expired rate", result.mcpConfirmations.expiredRate),
        ]),
    "",
  ].join("\n");
}

function baselineAtFromSince(raw: Record<string, unknown>): string {
  const since = raw.since === undefined ? "7d" : String(raw.since);
  try {
    return new Date(Date.now() - parseDuration(since)).toISOString();
  } catch (e) {
    process.stderr.write(`harness error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

function warnSkippedSnapshots(result: MetricsDeltaResult): void {
  for (const skipped of result.skippedSnapshots) {
    process.stderr.write(
      `warning: skipped metrics snapshot ${skipped.snapshotId} ` +
        `(${skipped.createdAt}): ${skipped.reason}\n`,
    );
  }
}

interface ScopedMetricsOutput extends DbMetricsSummary {
  usage: DbTokenUsageSummary;
  hitch: DbHitchMetricsSummary;
  mcpConfirmations: DbMcpConfirmationSummary;
}

export function runScopedMetrics(
  harnessRoot: string,
  raw: Record<string, unknown>,
): void {
  const filter = scopeFilter(raw);
  const m = withRefreshedDb(harnessRoot, (db): ScopedMetricsOutput => {
    const runMetrics = metricsSummary(db, filter);
    return {
      ...runMetrics,
      usage: tokenUsageSummary(db, filter),
      hitch: hitchMetricsSummary(db, filter),
      mcpConfirmations: mcpConfirmationSummary(db, {
        ...(filter.since !== undefined ? { since: filter.since } : {}),
      }),
    };
  });
  const byStatus = statusLines(m.byStatus);
  const hitchByStatus = statusLines(m.hitch.byStatus);
  const confirmationByStatus = statusLines(m.mcpConfirmations.byStatus);
  emit(
    raw,
    m,
    `metrics ${scopeLabel(filter)}\n` +
      `total runs: ${m.totalRuns}  approved: ${m.approved}  ` +
      `needs_review: ${m.needsReview}  failed: ${m.failed}  ` +
      `approved rate: ${pct(m.approvedRate)}\n` +
      `one-shot approval rate: ${pct(m.oneShotApprovalRate)}\n` +
      `policy violation rate: ${pct(m.policyViolationRate)}\n` +
      `secret suspect rate: ${pct(m.secretSuspectRate)}\n` +
      `lock contention count: ${m.lockContentionCount}\n` +
      `${byStatus}\n` +
      `usage:\n` +
      `  runs with usage: ${m.usage.runsWithUsage}\n` +
      `  input tokens: ${m.usage.totalInputTokens}\n` +
      `  output tokens: ${m.usage.totalOutputTokens}\n` +
      `  total tokens: ${m.usage.totalTokens}\n` +
      `${statusLines(m.usage.bySource)}\n` +
      `hitch metrics:\n` +
      `  total sessions: ${m.hitch.totalSessions}\n` +
      `  avg review cycles: ${fixed(m.hitch.avgReviewCycles)}\n` +
      `  avg rerun attempts: ${fixed(m.hitch.avgRerunAttempts)}\n` +
      `  finding resolution rate: ${pct(m.hitch.findingResolutionRate)}\n` +
      `  reopen rate: ${pct(m.hitch.reopenRate)}\n` +
      `${hitchByStatus}\n` +
      `mcp confirmations:\n` +
      `  total: ${m.mcpConfirmations.total}\n` +
      `  confirmation rate: ${pct(m.mcpConfirmations.confirmationRate)}\n` +
      `  expired rate: ${pct(m.mcpConfirmations.expiredRate)}\n` +
      `${confirmationByStatus}\n`,
  );
}

interface MetricsSnapshotCliOutput {
  snapshot: MetricsSnapshotRow;
  pruned: number;
}

export function runMetricsSnapshot(
  harnessRoot: string,
  raw: Record<string, unknown>,
): void {
  const filter = scopeFilter(raw);
  const retentionDays = parseRetentionDays(raw.retentionDays);
  const now = new Date().toISOString();
  const result = withRefreshedDb(harnessRoot, (db): MetricsSnapshotCliOutput => {
    const { snapshot, prunedCount } = recordAndPruneMetricsSnapshot(db, {
      filter,
      retentionDays,
      now,
    });
    return { snapshot, pruned: prunedCount };
  });
  emit(
    raw,
    result,
    `snapshot=${result.snapshot.snapshotId} pruned=${result.pruned}\n`,
  );
}

export function runMetricsDelta(
  harnessRoot: string,
  raw: Record<string, unknown>,
): void {
  const filter = snapshotScopeFilter(raw);
  const baselineAt = baselineAtFromSince(raw);
  const result = withRefreshedDb(harnessRoot, (db): MetricsDeltaResult =>
    buildMetricsDelta(db, { filter, baselineAt }),
  );
  warnSkippedSnapshots(result);
  emit(raw, result, metricsDeltaText(result));
}

export function runScopedInbox(
  harnessRoot: string,
  raw: Record<string, unknown>,
): void {
  // --today is honored (→ since); the section-selector flags are not (the
  // scoped inbox always reports every section).
  warnIgnored(raw, "inbox", [
    { key: "needsAction", flag: "--needs-action" },
    { key: "failed", flag: "--failed" },
    { key: "cleanup", flag: "--cleanup" },
  ]);
  const filter = scopeFilter(raw);
  const inbox = withRefreshedDb(harnessRoot, (db) =>
    inboxSummary(db, filter),
  );
  emit(
    raw,
    inbox,
    `inbox ${scopeLabel(filter)}\n` +
      `needs_review: ${inbox.needsReview.length}  ` +
      `changes_requested: ${inbox.changesRequested.length}  ` +
      `failed: ${inbox.failed.length}  ` +
      `knowledge-candidate runs: ${inbox.knowledgeCandidateRuns}\n` +
      `operational-knowledge: ${inbox.operationalKnowledge.total}` +
      (inbox.operationalKnowledge.recent.length > 0
        ? ` (recent: ${inbox.operationalKnowledge.recent
            .map((e) => e.entryId)
            .join(", ")})`
        : "") +
      "\n",
  );
}

export function runScopedKnowledgeDigest(
  harnessRoot: string,
  raw: Record<string, unknown>,
): void {
  const filter = scopeFilter(raw);
  const d = withRefreshedDb(harnessRoot, (db) =>
    knowledgeDigest(db, filter),
  );
  const kinds = Object.keys(d.byKind)
    .sort()
    .map((k) => `  ${k}: ${d.byKind[k]}`)
    .join("\n");
  emit(
    raw,
    d,
    `knowledge digest ${scopeLabel(filter)}\n` +
      `candidates: ${d.candidateTotal}  entries: ${d.entryTotal}\n` +
      `${kinds}\n`,
  );
}

export function runScopedBacklog(
  harnessRoot: string,
  raw: Record<string, unknown>,
): void {
  const filter = scopeFilter(raw);
  const b = withRefreshedDb(harnessRoot, (db) => backlogList(db, filter));
  const lines = b.items
    .map(
      (i) => `${i.itemId}  [${i.status}] ${i.priority}  ${i.domain}  ${i.title}`,
    )
    .join("\n");
  emit(
    raw,
    b,
    `backlog ${scopeLabel(filter)}\n` +
      (b.items.length === 0 ? "(no items)\n" : `${lines}\n`),
  );
}

function scopeLabel(filter: AggregateFilter): string {
  const parts: string[] = [];
  if (filter.projectId !== undefined) parts.push(`project=${filter.projectId}`);
  if (filter.repoId !== undefined) parts.push(`repo=${filter.repoId}`);
  if (filter.domain !== undefined) parts.push(`domain=${filter.domain}`);
  if (filter.status !== undefined) parts.push(`status=${filter.status}`);
  if (filter.since !== undefined) parts.push(`since=${filter.since}`);
  return `(${parts.join(" ")})`;
}
