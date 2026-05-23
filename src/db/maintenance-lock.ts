import {
  openSync,
  closeSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
// @ts-expect-error fs-ext has no bundled types
import { flockSync, constants as flockConstants } from "fs-ext";
import { DB_FILE_MODE } from "./connection.js";

/**
 * DB-wide reader/writer maintenance lock (Phase 9-2).
 *
 * `.harness/db.lock` is held via POSIX flock:
 *  - SHARED — normal write commands (`runDomainCoding` / `review process` /
 *    cleanup / etc.) so multiple writers can proceed under SQLite's own
 *    WAL serialization, AND heavy reads (`db backup` / `db stats`).
 *  - EXCLUSIVE — destructive maintenance + schema ops (`db init` /
 *    `db migrate` / `db restore` / `db vacuum` /
 *    `db checkpoint --truncate` / `db migrate-artifacts` /
 *    `db migrate-legacy`) — anything that requires a quiescent DB.
 *
 * The lock is **file-level** (flock on the lockfile), not SQLite-level —
 * SQLite's busy_timeout handles concurrent statements on a healthy file,
 * but it cannot protect against a `db restore` that swaps the file out
 * from under open connections. flock on a separate sidecar gives us that.
 *
 * POSIX-only (`fs-ext`). Windows is not supported (the harness is POSIX).
 */

// fs-ext exposes LOCK_SH/LOCK_EX/LOCK_NB/LOCK_UN either as `constants`
// or as top-level fields depending on version. Read both for safety.
type FlockConsts = {
  LOCK_SH?: number;
  LOCK_EX?: number;
  LOCK_NB?: number;
  LOCK_UN?: number;
};
const flockExt = ((flockConstants as FlockConsts | undefined) ?? {}) as
  FlockConsts;
const LOCK_SH = flockExt.LOCK_SH ?? 1;
const LOCK_EX = flockExt.LOCK_EX ?? 2;
const LOCK_NB = flockExt.LOCK_NB ?? 4;

/** 100ms retry tick while waiting for a busy lock. */
const RETRY_TICK_MS = 100;

/** Default acquire timeout when none is specified. */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export type LockMode = "shared" | "exclusive";

export class MaintenanceLockBusyError extends Error {
  constructor(public readonly lockPath: string, public readonly mode: LockMode) {
    super(
      `maintenance lock busy at ${lockPath} (mode=${mode}) — another harness ` +
        `process is using the DB. Wait for it to finish, or pass --wait.`,
    );
    this.name = "MaintenanceLockBusyError";
  }
}

export interface LockHandle {
  readonly path: string;
  readonly mode: LockMode;
  /** Release the lock and close the underlying fd. Safe to call twice. */
  release(): void;
}

/** Ensure the lock file exists with permission 0600. */
function ensureLockFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    // open with O_CREAT | O_EXCL ... actually a simple O_CREAT is fine —
    // two processes racing to create the lock file end up with one file,
    // and flock on it serializes them.
    closeSync(openSync(path, "a"));
  }
  try {
    chmodSync(path, DB_FILE_MODE);
  } catch {
    // chmod is best-effort on filesystems without POSIX modes.
  }
}

/** Sleep synchronously for `ms` without burning CPU. */
function syncSleep(ms: number): void {
  // Atomics.wait on a SharedArrayBuffer is the standard sync-sleep idiom
  // — supported on the main thread in modern Node.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Acquire `path` with the requested mode, blocking up to `timeoutMs`.
 *
 * Implementation uses non-blocking flock + a sync retry loop so the
 * caller gets a real timeout (a plain blocking flock would hang
 * indefinitely on an exclusive contender).
 */
export function acquire(opts: {
  path: string;
  mode: LockMode;
  timeoutMs?: number;
}): LockHandle {
  ensureLockFile(opts.path);
  const fd = openSync(opts.path, "r+");
  const flockMode = opts.mode === "exclusive" ? LOCK_EX : LOCK_SH;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  for (;;) {
    try {
      flockSync(fd, flockMode | LOCK_NB);
      let released = false;
      return {
        path: opts.path,
        mode: opts.mode,
        release(): void {
          if (released) return;
          released = true;
          try {
            // closing the fd implicitly releases the flock, but
            // unlock-then-close is the explicit / portable form.
            flockSync(fd, flockExt.LOCK_UN ?? 8);
          } catch {
            // ignore — closing below will release in any case
          }
          try {
            closeSync(fd);
          } catch {
            // already closed
          }
        },
      };
    } catch (e) {
      if (Date.now() >= deadline) {
        closeSync(fd);
        throw new MaintenanceLockBusyError(opts.path, opts.mode);
      }
      syncSleep(RETRY_TICK_MS);
    }
  }
}

/** Acquire a shared lock — convenience for normal write commands. */
export function acquireShared(
  path: string,
  opts: { timeoutMs?: number } = {},
): LockHandle {
  return acquire({ path, mode: "shared", ...opts });
}

/** Acquire an exclusive lock — convenience for destructive maintenance. */
export function acquireExclusive(
  path: string,
  opts: { timeoutMs?: number } = {},
): LockHandle {
  return acquire({ path, mode: "exclusive", ...opts });
}

/**
 * Run `fn` with the maintenance lock held in the given mode, releasing
 * even on throw. CLI actions wrap their DB work in this so the lock
 * lifetime is tied to the command — open the DB, do the work, close —
 * not to any intermediate failure path.
 */
export function withMaintenanceLock<T>(
  opts: { path: string; mode: LockMode; timeoutMs?: number },
  fn: () => T,
): T {
  const lock = acquire(opts);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** Async variant of `withMaintenanceLock` for callers returning a Promise. */
export async function withMaintenanceLockAsync<T>(
  opts: { path: string; mode: LockMode; timeoutMs?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const lock = acquire(opts);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
