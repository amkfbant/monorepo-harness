import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { openDb, openDbReadonly } from "./connection.js";
import {
  acquireExclusive,
  acquireShared,
  type LockHandle,
  type LockMode,
} from "./maintenance-lock.js";

/**
 * Derive the DB-wide maintenance lock path from the DB path. The lock
 * sits next to `harness.sqlite` as `db.lock` (see
 * `harnessPaths().dbLockPath`). Callers that pass a custom lockPath can
 * still override.
 */
export function deriveDbLockPath(dbPath: string): string {
  return join(dirname(dbPath), "db.lock");
}

/**
 * Runtime DB handle that holds the DB-wide maintenance lock for the
 * lifetime of the connection (Phase 9 post-close fix).
 *
 * Phase 9-2 introduced a reader/writer maintenance lock and Phase 9-3
 * wrapped every `harness db` subcommand with it, but the runtime writers
 * (`runDomainCoding`, `review process`, `cleanup`, `pr create`, backlog,
 * knowledge, reviewer-agent DB persist) were still opening the DB
 * directly. The external review (codex P0) flagged that `db restore`
 * could then atomically swap `harness.sqlite` out from under a live
 * runtime handle. This helper closes that gap: shared mode for normal
 * runtime work, exclusive for destructive maintenance. The lock is
 * released only after the DB handle is closed, so the inode the runtime
 * has open is guaranteed to be the same inode `db restore` sees as busy.
 */
export interface ManagedDb {
  readonly db: Database.Database;
  readonly lock: LockHandle;
  /** Close the DB handle, then release the maintenance lock. */
  close(): void;
}

export interface OpenManagedDbOptions {
  dbPath: string;
  /**
   * `.harness/db.lock` sidecar flock target. Defaults to
   * `deriveDbLockPath(dbPath)` so most callers can pass just `dbPath`.
   */
  lockPath?: string;
  /** Default `"shared"`. Runtime callers should not pass `"exclusive"`. */
  mode?: LockMode;
  /** Default `false`. `true` skips the writeable open + chmod path. */
  readonly?: boolean;
  /** Override the default acquire timeout (`maintenance-lock.ts`). */
  timeoutMs?: number;
}

function resolveLockPath(opts: OpenManagedDbOptions): string {
  return opts.lockPath ?? deriveDbLockPath(opts.dbPath);
}

function acquireFor(opts: OpenManagedDbOptions): LockHandle {
  const lockPath = resolveLockPath(opts);
  const mode: LockMode = opts.mode ?? "shared";
  return mode === "exclusive"
    ? acquireExclusive(lockPath, opts.timeoutMs !== undefined
        ? { timeoutMs: opts.timeoutMs } : {})
    : acquireShared(lockPath, opts.timeoutMs !== undefined
        ? { timeoutMs: opts.timeoutMs } : {});
}

export function openManagedDb(opts: OpenManagedDbOptions): ManagedDb {
  const lock = acquireFor(opts);
  let db: Database.Database;
  try {
    db = opts.readonly === true
      ? openDbReadonly(opts.dbPath)
      : openDb(opts.dbPath);
  } catch (e) {
    lock.release();
    throw e;
  }
  let closed = false;
  return {
    db,
    lock,
    close(): void {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        lock.release();
      }
    },
  };
}

export function withManagedDb<T>(
  opts: OpenManagedDbOptions,
  fn: (db: Database.Database) => T,
): T {
  const handle = openManagedDb(opts);
  try {
    return fn(handle.db);
  } finally {
    handle.close();
  }
}

export async function withManagedDbAsync<T>(
  opts: OpenManagedDbOptions,
  fn: (db: Database.Database) => Promise<T>,
): Promise<T> {
  const handle = openManagedDb(opts);
  try {
    return await fn(handle.db);
  } finally {
    handle.close();
  }
}
