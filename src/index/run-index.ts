import {
  rmSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { RunStatus, SafetyStatus } from "../logging/run-log.js";
import type {
  ReviewListEntry,
  InvalidRunEntry,
  ListResult,
} from "../core/review-lister.js";

/**
 * SQLite run index (Phase 3-5).
 *
 * The source of truth is ALWAYS the `runs/` files. This index is a
 * derived, disposable cache for fast listing — if it is missing or
 * corrupt, `harness index rebuild` regenerates it from `runs/`.
 */

/**
 * Index schema version. Bump whenever the `runs` columns change so a
 * stale index built by an older harness is detected and rebuilt rather
 * than read with missing columns.
 */
const INDEX_SCHEMA_VERSION = 2;

/** Each DDL statement is run individually (no multi-statement exec). */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    status TEXT NOT NULL,
    safety_status TEXT,
    reviewer TEXT,
    reviewed_at TEXT,
    parent_run_id TEXT,
    root_run_id TEXT,
    rerun_attempt INTEGER,
    command_ok INTEGER,
    command_total INTEGER,
    changed_files_count INTEGER,
    secret_suspect_count INTEGER,
    ignored_untracked_count INTEGER,
    started_at TEXT,
    finished_at TEXT
  )`,
  `CREATE TABLE invalid_runs (
    run_id TEXT PRIMARY KEY,
    error TEXT NOT NULL
  )`,
  `CREATE TABLE index_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

interface RunRow {
  run_id: string;
  domain: string;
  status: string;
  safety_status: string | null;
  reviewer: string | null;
  reviewed_at: string | null;
  parent_run_id: string | null;
  root_run_id: string | null;
  rerun_attempt: number | null;
  command_ok: number | null;
  command_total: number | null;
  changed_files_count: number | null;
  secret_suspect_count: number | null;
  ignored_untracked_count: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface IndexStats {
  dbPath: string;
  runCount: number;
  invalidCount: number;
  rebuiltAt: string;
}

/**
 * (Re)build the index from a full run scan. The new index is built into a
 * sibling temp file and atomically renamed over the live one — so the
 * existing index survives until a complete, valid one is ready, and a
 * crash mid-build never leaves a half-populated index.sqlite.
 */
export function rebuildIndex(
  dbPath: string,
  scan: ListResult,
  now: Date = new Date(),
): IndexStats {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmpPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tmpPath, { force: true });
  const rebuiltAt = now.toISOString();
  const db = new Database(tmpPath);
  try {
    for (const ddl of SCHEMA_STATEMENTS) db.prepare(ddl).run();
    const insertRun = db.prepare(
      `INSERT INTO runs (run_id, domain, status, safety_status, reviewer,
        reviewed_at, parent_run_id, root_run_id, rerun_attempt, command_ok,
        command_total, changed_files_count, secret_suspect_count,
        ignored_untracked_count, started_at, finished_at)
       VALUES (@run_id, @domain, @status, @safety_status, @reviewer,
        @reviewed_at, @parent_run_id, @root_run_id, @rerun_attempt, @command_ok,
        @command_total, @changed_files_count, @secret_suspect_count,
        @ignored_untracked_count, @started_at, @finished_at)`,
    );
    const insertInvalid = db.prepare(
      `INSERT INTO invalid_runs (run_id, error) VALUES (?, ?)`,
    );
    const insertMeta = db.prepare(
      `INSERT INTO index_meta (key, value) VALUES (?, ?)`,
    );
    const tx = db.transaction(() => {
      for (const e of scan.valid) insertRun.run(toRow(e));
      for (const e of scan.invalid) insertInvalid.run(e.runId, e.error);
      insertMeta.run("rebuilt_at", rebuiltAt);
      insertMeta.run("schema_version", String(INDEX_SCHEMA_VERSION));
    });
    tx();
  } catch (e) {
    db.close();
    rmSync(tmpPath, { force: true });
    throw e;
  }
  db.close();
  // the temp index is complete and valid → atomically replace the live one.
  renameSync(tmpPath, dbPath);
  return {
    dbPath,
    runCount: scan.valid.length,
    invalidCount: scan.invalid.length,
    rebuiltAt,
  };
}

/**
 * Throw if the index was built by an incompatible schema version — an
 * older index is missing columns and must be rebuilt, not read silently.
 */
function assertSchemaCurrent(db: Database.Database): void {
  const row = db
    .prepare(`SELECT value FROM index_meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  const version = row ? Number(row.value) : 1;
  if (version !== INDEX_SCHEMA_VERSION) {
    throw new Error(
      `index schema is v${version}, expected v${INDEX_SCHEMA_VERSION}; ` +
        `run 'harness index rebuild'`,
    );
  }
}

/** Read the entire index back as a ListResult (no filtering applied). */
export function loadFromIndex(dbPath: string): ListResult {
  if (!existsSync(dbPath)) {
    throw new Error(
      `index not found at ${dbPath}; run 'harness index rebuild' first`,
    );
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    assertSchemaCurrent(db);
    const runRows = db.prepare(`SELECT * FROM runs`).all() as RunRow[];
    const invalidRows = db
      .prepare(`SELECT run_id, error FROM invalid_runs`)
      .all() as Array<{ run_id: string; error: string }>;
    return {
      valid: runRows.map(fromRow),
      invalid: invalidRows.map((r) => ({ runId: r.run_id, error: r.error })),
    };
  } finally {
    db.close();
  }
}

export interface IndexStatus {
  exists: boolean;
  dbPath: string;
  /** true when the file exists but cannot be read as a valid index */
  corrupt?: boolean;
  error?: string;
  runCount?: number;
  invalidCount?: number;
  rebuiltAt?: string;
  sizeBytes?: number;
}

export function indexStatus(dbPath: string): IndexStatus {
  if (!existsSync(dbPath)) return { exists: false, dbPath };
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    // an outdated schema is reported like a corrupt index — it must be
    // rebuilt, not read with missing columns.
    assertSchemaCurrent(db);
    const runCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM runs`).get() as { c: number }
    ).c;
    const invalidCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM invalid_runs`).get() as {
        c: number;
      }
    ).c;
    const rebuiltRow = db
      .prepare(`SELECT value FROM index_meta WHERE key = 'rebuilt_at'`)
      .get() as { value: string } | undefined;
    return {
      exists: true,
      dbPath,
      runCount,
      invalidCount,
      ...(rebuiltRow ? { rebuiltAt: rebuiltRow.value } : {}),
      sizeBytes: statSync(dbPath).size,
    };
  } catch (e) {
    // corrupt / incompatible / partial DB — report it as a state rather
    // than throwing, so `index status` can still guide a rebuild.
    return {
      exists: true,
      dbPath,
      corrupt: true,
      error: (e as Error).message,
    };
  } finally {
    if (db) db.close();
  }
}

/** A run looked up in the index: valid, invalid, or absent. */
export type IndexLookup =
  | { kind: "valid"; entry: ReviewListEntry }
  | { kind: "invalid"; runId: string; error: string }
  | null;

/** Look up a single run in the index — checks runs AND invalid_runs. */
export function showRunFromIndex(
  dbPath: string,
  runId: string,
): IndexLookup {
  if (!existsSync(dbPath)) {
    throw new Error(
      `index not found at ${dbPath}; run 'harness index rebuild' first`,
    );
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    assertSchemaCurrent(db);
    const row = db
      .prepare(`SELECT * FROM runs WHERE run_id = ?`)
      .get(runId) as RunRow | undefined;
    if (row) return { kind: "valid", entry: fromRow(row) };
    const invalid = db
      .prepare(`SELECT error FROM invalid_runs WHERE run_id = ?`)
      .get(runId) as { error: string } | undefined;
    if (invalid) return { kind: "invalid", runId, error: invalid.error };
    return null;
  } finally {
    db.close();
  }
}

function toRow(e: ReviewListEntry): RunRow {
  return {
    run_id: e.runId,
    domain: e.domain,
    status: e.status,
    safety_status: e.safetyStatus,
    reviewer: e.reviewer,
    reviewed_at: e.reviewedAt,
    parent_run_id: e.parentRunId,
    root_run_id: e.rootRunId,
    rerun_attempt: e.rerunAttempt,
    command_ok: e.commandSummary ? e.commandSummary.ok : null,
    command_total: e.commandSummary ? e.commandSummary.total : null,
    changed_files_count: e.changedFilesCount,
    secret_suspect_count: e.secretSuspectCount,
    ignored_untracked_count: e.ignoredUntrackedCount,
    started_at: e.startedAt,
    finished_at: e.finishedAt,
  };
}

function fromRow(r: RunRow): ReviewListEntry {
  return {
    runId: r.run_id,
    domain: r.domain,
    status: r.status as RunStatus,
    safetyStatus: r.safety_status as SafetyStatus | null,
    reviewer: r.reviewer,
    reviewedAt: r.reviewed_at,
    parentRunId: r.parent_run_id,
    rootRunId: r.root_run_id,
    rerunAttempt: r.rerun_attempt,
    commandSummary:
      r.command_total === null
        ? null
        : { ok: r.command_ok ?? 0, total: r.command_total },
    changedFilesCount: r.changed_files_count,
    secretSuspectCount: r.secret_suspect_count,
    ignoredUntrackedCount: r.ignored_untracked_count,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export type { ReviewListEntry, InvalidRunEntry };
