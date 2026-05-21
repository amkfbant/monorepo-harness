import { mkdirSync } from "node:fs";
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
