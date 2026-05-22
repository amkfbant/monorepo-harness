import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  realpathSync,
  statSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  openDb,
  openDbReadonly,
  hardenDbPermissions,
  DB_FILE_MODE,
  DbError,
} from "./connection.js";
import { readSchemaVersion, LATEST_SCHEMA_VERSION } from "./migrations.js";
import { ALL_TABLE_NAMES } from "./schema.js";

/**
 * DB operational commands (Phase 8-8).
 *
 * Phase 8 makes `harness.sqlite` the canonical store for runtime state
 * including artifact bodies, so it needs first-class backup / restore /
 * checkpoint / vacuum / stats. Files are now optional — the DB (and its
 * backups) must be independently recoverable.
 */

const WAL_SUFFIX = "-wal";
const SHM_SUFFIX = "-shm";

function assertInitialized(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new DbError(
      `DB not initialized at ${dbPath} — run 'harness db init'`,
    );
  }
}

/** Schema version of a standalone DB file, opened read-only. */
function probeSchemaVersion(path: string): number {
  const db = openDbReadonly(path);
  try {
    return readSchemaVersion(db);
  } finally {
    db.close();
  }
}

export interface BackupResult {
  outPath: string;
  bytes: number;
  schemaVersion: number;
}

/**
 * Write a consistent standalone copy of the DB to `outPath`.
 *
 * Uses better-sqlite3's online backup, which captures a transactionally
 * consistent snapshot (WAL included) without blocking writers — the
 * result is a single `.sqlite` file with no journal sidecar. The target
 * must not already exist so a backup never silently clobbers another.
 */
export async function backupDb(opts: {
  dbPath: string;
  outPath: string;
}): Promise<BackupResult> {
  assertInitialized(opts.dbPath);
  if (existsSync(opts.outPath)) {
    throw new DbError(`backup target already exists: ${opts.outPath}`);
  }
  mkdirSync(dirname(opts.outPath), { recursive: true });
  const db = openDb(opts.dbPath);
  try {
    await db.backup(opts.outPath);
  } finally {
    db.close();
  }
  // the backup is a full copy of a DB that may hold codex logs / diffs —
  // restrict it like the live DB rather than leaving it at the umask.
  try {
    chmodSync(opts.outPath, DB_FILE_MODE);
  } catch {
    // best-effort — see hardenDbPermissions.
  }
  return {
    outPath: opts.outPath,
    bytes: statSync(opts.outPath).size,
    schemaVersion: probeSchemaVersion(opts.outPath),
  };
}

export interface RestoreResult {
  dbPath: string;
  fromPath: string;
  bytes: number;
  schemaVersion: number;
}

/** True when two paths resolve to the same file on disk. */
function samePath(a: string, b: string): boolean {
  try {
    return (
      existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b)
    );
  } catch {
    return false;
  }
}

/**
 * Validate that `path` is a restorable harness DB and return its schema
 * version. Goes well beyond "has a schema_migrations table": runs
 * `integrity_check`, bounds the schema version, and requires the harness
 * core tables — so a foreign SQLite cannot pass and replace the live DB.
 */
function validateHarnessDb(path: string): number {
  const db = openDbReadonly(path);
  try {
    const integ = db.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;
    if (integ[0]?.integrity_check !== "ok") {
      throw new DbError(
        `${path}: integrity check failed ` +
          `(${integ[0]?.integrity_check ?? "unknown"})`,
      );
    }
    const version = readSchemaVersion(db);
    if (version < 1 || version > LATEST_SCHEMA_VERSION) {
      throw new DbError(
        `${path}: schema version ${version} is not a restorable harness DB ` +
          `(expected 1..${LATEST_SCHEMA_VERSION})`,
      );
    }
    // a foreign SQLite could carry a schema_migrations table by coincidence
    // — require the harness core tables before trusting it.
    for (const t of ["db_meta", "runs", "artifacts"]) {
      if (!tableExists(db, t)) {
        throw new DbError(`${path}: missing core table '${t}' — not a harness DB`);
      }
    }
    return version;
  } finally {
    db.close();
  }
}

/**
 * Replace the live DB with a backup.
 *
 * Restore goes through the SQLite online backup API into a temp file in
 * the target directory, so the source's WAL is read (a backup of a live
 * WAL-mode DB never loses committed data) and the temp is always a clean
 * standalone file. The temp is fully validated as a harness DB BEFORE it
 * atomically replaces the live DB via `rename` — any failure up to that
 * point leaves the live DB completely untouched. Restoring the live DB
 * onto itself is rejected.
 */
export async function restoreDb(opts: {
  dbPath: string;
  fromPath: string;
}): Promise<RestoreResult> {
  if (!existsSync(opts.fromPath)) {
    throw new DbError(`backup file not found: ${opts.fromPath}`);
  }
  if (samePath(opts.fromPath, opts.dbPath)) {
    throw new DbError(
      `restore --from is the live DB itself: ${opts.fromPath}`,
    );
  }
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const tmpPath = `${opts.dbPath}.restore-${process.pid}-${Date.now()}`;
  rmSync(tmpPath, { force: true });
  let schemaVersion: number;
  try {
    // online backup of the source: reads the source WAL too, so the temp
    // is a consistent standalone copy regardless of the source's journal.
    const src = openDbReadonly(opts.fromPath);
    try {
      await src.backup(tmpPath);
    } finally {
      src.close();
    }
    schemaVersion = validateHarnessDb(tmpPath);
    hardenDbPermissions(tmpPath);
    // atomic replace — a crash/failure before here leaves the live DB intact.
    renameSync(tmpPath, opts.dbPath);
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e instanceof DbError
      ? e
      : new DbError(`restore failed: ${(e as Error).message}`);
  }
  // the replaced file's old WAL/SHM are stale — drop them so SQLite never
  // applies a journal that belonged to the DB just overwritten.
  for (const suffix of [WAL_SUFFIX, SHM_SUFFIX]) {
    rmSync(`${opts.dbPath}${suffix}`, { force: true });
  }
  hardenDbPermissions(opts.dbPath);
  return {
    dbPath: opts.dbPath,
    fromPath: opts.fromPath,
    bytes: statSync(opts.dbPath).size,
    schemaVersion,
  };
}

export interface CheckpointResult {
  walBytesBefore: number;
  walBytesAfter: number;
  /** frames moved from the WAL into the main DB */
  checkpointedFrames: number;
  /** true when another connection blocked a full (TRUNCATE) checkpoint */
  busy: boolean;
}

function walBytes(dbPath: string): number {
  const wal = `${dbPath}${WAL_SUFFIX}`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

/** Checkpoint the WAL into the main DB and truncate it back to empty. */
export function checkpointDb(dbPath: string): CheckpointResult {
  assertInitialized(dbPath);
  const walBytesBefore = walBytes(dbPath);
  const db = openDb(dbPath);
  let checkpointedFrames = 0;
  let busy = false;
  try {
    // TRUNCATE: checkpoint, then shrink the WAL file to zero length.
    const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const row = rows[0];
    if (row) {
      checkpointedFrames = row.checkpointed;
      // busy=1 means another connection held a lock and the checkpoint
      // could not run to completion — surface it rather than report success.
      busy = row.busy !== 0;
    }
  } finally {
    db.close();
  }
  return {
    walBytesBefore,
    walBytesAfter: walBytes(dbPath),
    checkpointedFrames,
    busy,
  };
}

export interface VacuumResult {
  bytesBefore: number;
  bytesAfter: number;
}

/** Rebuild the DB file, reclaiming space freed by deletes (e.g. blobs). */
export function vacuumDb(dbPath: string): VacuumResult {
  assertInitialized(dbPath);
  const bytesBefore = statSync(dbPath).size;
  const db = openDb(dbPath);
  try {
    db.prepare("VACUUM").run();
  } finally {
    db.close();
  }
  return { bytesBefore, bytesAfter: statSync(dbPath).size };
}

export interface BlobStats {
  count: number;
  /** sum of raw artifact bytes (before compression) */
  rawBytes: number;
  /** sum of stored bytes (after compression) */
  storedBytes: number;
  /** sum of chunk counts across all blobs */
  chunkCount: number;
}

export interface DbStats {
  dbPath: string;
  schemaVersion: number;
  dbBytes: number;
  walBytes: number;
  /** row count per table, only for tables present at this schema version */
  tableRows: Record<string, number>;
  totalRows: number;
  blobs: BlobStats;
}

function tableExists(
  db: ReturnType<typeof openDbReadonly>,
  name: string,
): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

function readBlobStats(db: ReturnType<typeof openDbReadonly>): BlobStats {
  const empty: BlobStats = {
    count: 0,
    rawBytes: 0,
    storedBytes: 0,
    chunkCount: 0,
  };
  if (!tableExists(db, "artifact_blobs")) return empty;
  const row = db
    .prepare(
      `SELECT count(*) AS count,
              COALESCE(sum(bytes), 0) AS rawBytes,
              COALESCE(sum(stored_bytes), 0) AS storedBytes,
              COALESCE(sum(chunk_count), 0) AS chunkCount
       FROM artifact_blobs`,
    )
    .get() as BlobStats;
  return row;
}

/** Collect table row counts, blob totals and on-disk sizes. */
export function dbStats(dbPath: string): DbStats {
  assertInitialized(dbPath);
  const db = openDbReadonly(dbPath);
  try {
    const tableRows: Record<string, number> = {};
    let totalRows = 0;
    for (const t of ALL_TABLE_NAMES) {
      // an older-schema DB may not have every table yet — skip absent ones.
      if (!tableExists(db, t)) continue;
      const n = (
        db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }
      ).n;
      tableRows[t] = n;
      totalRows += n;
    }
    return {
      dbPath,
      schemaVersion: readSchemaVersion(db),
      dbBytes: statSync(dbPath).size,
      walBytes: walBytes(dbPath),
      tableRows,
      totalRows,
      blobs: readBlobStats(db),
    };
  } finally {
    db.close();
  }
}

/** Human-readable byte size, e.g. 1536 → "1.5 KB". */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatBackup(r: BackupResult): string {
  return (
    `db backup: wrote ${r.outPath}\n` +
    `  schema version: ${r.schemaVersion}\n` +
    `  size: ${humanBytes(r.bytes)} (${r.bytes} bytes)\n`
  );
}

export function formatRestore(r: RestoreResult): string {
  return (
    `db restore: replaced ${r.dbPath}\n` +
    `  from: ${r.fromPath}\n` +
    `  schema version: ${r.schemaVersion}\n` +
    `  size: ${humanBytes(r.bytes)} (${r.bytes} bytes)\n` +
    `  note: run restore only when no other harness process is active —\n` +
    `        a process holding the old DB open keeps writing the replaced file.\n`
  );
}

export function formatCheckpoint(r: CheckpointResult): string {
  return (
    `db checkpoint: ${r.checkpointedFrames} frame(s) checkpointed\n` +
    `  WAL: ${humanBytes(r.walBytesBefore)} → ${humanBytes(r.walBytesAfter)}\n` +
    (r.busy
      ? "  note: another connection blocked a full checkpoint — " +
        "the WAL was not truncated; retry when idle\n"
      : "")
  );
}

export function formatVacuum(r: VacuumResult): string {
  const reclaimed = r.bytesBefore - r.bytesAfter;
  return (
    `db vacuum: ${humanBytes(r.bytesBefore)} → ${humanBytes(r.bytesAfter)}\n` +
    `  reclaimed: ${humanBytes(Math.max(0, reclaimed))}\n`
  );
}

export function formatStats(s: DbStats): string {
  const lines: string[] = [
    `db stats: ${s.dbPath}`,
    `  schema version: ${s.schemaVersion}`,
    `  DB size: ${humanBytes(s.dbBytes)} (${s.dbBytes} bytes)`,
    `  WAL size: ${humanBytes(s.walBytes)}`,
    `  total rows: ${s.totalRows}`,
    "  tables:",
  ];
  for (const t of Object.keys(s.tableRows).sort()) {
    if (s.tableRows[t] === 0) continue;
    lines.push(`    ${t}: ${s.tableRows[t]}`);
  }
  lines.push(
    "  artifact blobs:",
    `    count: ${s.blobs.count}`,
    `    raw bytes: ${humanBytes(s.blobs.rawBytes)} (${s.blobs.rawBytes})`,
    `    stored bytes: ${humanBytes(s.blobs.storedBytes)} (${s.blobs.storedBytes})`,
    `    chunks: ${s.blobs.chunkCount}`,
    "",
  );
  return lines.join("\n");
}
