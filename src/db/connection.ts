import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * DB connection helpers (Phase 6).
 *
 * `better-sqlite3` is synchronous; every caller opens, uses, and closes a
 * connection. WAL mode lets the read-only dashboard read while a CLI
 * command writes.
 */

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}

/**
 * 0600 — owner read/write only. Phase 8 makes the DB the canonical store
 * for artifact bodies (codex logs / diffs), so `harness.sqlite` and any
 * backup of it may hold secrets and must not be group/world readable.
 */
export const DB_FILE_MODE = 0o600;

/**
 * Restrict the DB file and its WAL/SHM sidecars to `DB_FILE_MODE`.
 * Best-effort: a filesystem without POSIX modes must not fail a DB open
 * over permissions, so chmod errors are swallowed.
 */
export function hardenDbPermissions(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(p)) chmodSync(p, DB_FILE_MODE);
    } catch {
      // best-effort — see the doc comment above.
    }
  }
}

function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

/**
 * Open (creating if needed) the harness DB read-write. The parent
 * directory is created so a fresh `.harness/` works on first run.
 */
export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    // a non-SQLite file opens lazily but fails on the first pragma — run
    // the pragmas here so a corrupt DB surfaces as a DbError, not later.
    applyPragmas(db);
    // the file (and the WAL/SHM the pragma above just created) may hold
    // secrets — restrict it on every open so a fresh DB is never world-readable.
    hardenDbPermissions(dbPath);
    return db;
  } catch (e) {
    // close a handle opened before the pragma failed, so a corrupt file
    // does not leak a connection.
    db?.close();
    throw new DbError(
      `failed to open DB at ${dbPath}: ${(e as Error).message}`,
    );
  }
}

/**
 * Open the harness DB read-only. The file must already exist — callers
 * that may run before `db init` should check first and surface a clear
 * "DB not initialized" message.
 */
export function openDbReadonly(dbPath: string): Database.Database {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    return db;
  } catch (e) {
    db?.close();
    throw new DbError(
      `failed to open DB (read-only) at ${dbPath}: ${(e as Error).message}`,
    );
  }
}
