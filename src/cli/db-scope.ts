import process from "node:process";
import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import { openDb } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { runFullImport } from "../db/import-files.js";
import { parseDuration } from "../core/maintenance.js";
import {
  metricsSummary,
  inboxSummary,
  knowledgeDigest,
  backlogList,
  type AggregateFilter,
} from "../db/repositories/aggregates.js";

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
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    runFullImport(db, { harnessRoot, reset: true });
    return fn(db);
  } finally {
    db.close();
  }
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

export function runScopedMetrics(
  harnessRoot: string,
  raw: Record<string, unknown>,
): void {
  const filter = scopeFilter(raw);
  const m = withRefreshedDb(harnessRoot, (db) => metricsSummary(db, filter));
  const rate =
    m.approvedRate === null ? "n/a" : `${(m.approvedRate * 100).toFixed(0)}%`;
  const byStatus = Object.keys(m.byStatus)
    .sort()
    .map((s) => `  ${s}: ${m.byStatus[s]}`)
    .join("\n");
  emit(
    raw,
    m,
    `metrics ${scopeLabel(filter)}\n` +
      `total runs: ${m.totalRuns}  approved: ${m.approved}  ` +
      `needs_review: ${m.needsReview}  failed: ${m.failed}  ` +
      `approved rate: ${rate}\n${byStatus}\n`,
  );
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
      `knowledge-candidate runs: ${inbox.knowledgeCandidateRuns}\n`,
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
