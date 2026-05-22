import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
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
import { readSchemaVersion } from "./migrations.js";
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

/**
 * Replace the live DB with a backup.
 *
 * The backup is validated as a real harness DB (schema version > 0)
 * BEFORE the live DB is touched, so a wrong `--from` never destroys data.
 * The live DB's WAL/SHM sidecars are removed so no stale journal is
 * replayed on top of the restored file.
 */
export function restoreDb(opts: {
  dbPath: string;
  fromPath: string;
}): RestoreResult {
  if (!existsSync(opts.fromPath)) {
    throw new DbError(`backup file not found: ${opts.fromPath}`);
  }
  let schemaVersion: number;
  try {
    schemaVersion = probeSchemaVersion(opts.fromPath);
  } catch (e) {
    throw new DbError(
      `${opts.fromPath} is not a readable SQLite DB: ${(e as Error).message}`,
    );
  }
  if (schemaVersion === 0) {
    throw new DbError(
      `${opts.fromPath} is not a harness DB backup (no schema)`,
    );
  }
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  // drop the live DB and its sidecars — copying only the .sqlite while a
  // stale -wal survives would replay the old journal over the restore.
  for (const suffix of ["", WAL_SUFFIX, SHM_SUFFIX]) {
    rmSync(`${opts.dbPath}${suffix}`, { force: true });
  }
  copyFileSync(opts.fromPath, opts.dbPath);
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
  try {
    // TRUNCATE: checkpoint, then shrink the WAL file to zero length.
    const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    if (rows[0]) checkpointedFrames = rows[0].checkpointed;
  } finally {
    db.close();
  }
  return {
    walBytesBefore,
    walBytesAfter: walBytes(dbPath),
    checkpointedFrames,
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
    `  size: ${humanBytes(r.bytes)} (${r.bytes} bytes)\n`
  );
}

export function formatCheckpoint(r: CheckpointResult): string {
  return (
    `db checkpoint: ${r.checkpointedFrames} frame(s) checkpointed\n` +
    `  WAL: ${humanBytes(r.walBytesBefore)} → ${humanBytes(r.walBytesAfter)}\n`
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
