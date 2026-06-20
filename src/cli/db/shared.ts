import process from "node:process";
import { harnessPaths } from "../../config/paths.js";
import { DbError } from "../../db/connection.js";
import {
  withMaintenanceLock,
  withMaintenanceLockAsync,
  MaintenanceLockBusyError,
  type LockMode,
} from "../../db/maintenance-lock.js";

/**
 * `harness db` 系で共有する DB CLI ヘルパー（#125 A15: cli/db.ts から behaviour-zero
 * で分割）。getHarnessRoot は呼出時に env/cwd を読む遅延解決。lock 系は maintenance
 * lock を取得して action を包む（lockTimeoutMs / lockPathFor は内部実装）。
 */
export function getHarnessRoot(): string {
  return process.env.HARNESS_ROOT ?? process.cwd();
}

export function dbError(e: unknown): never {
  if (e instanceof DbError) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  if (e instanceof MaintenanceLockBusyError) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

/**
 * Resolve the maintenance lock timeout from `--wait` / `--timeout <ms>`.
 * `--wait` (no value) waits up to one hour; `--timeout <ms>` overrides.
 * Without either, the default in `acquire()` (30s) is used.
 */
function lockTimeoutMs(raw: Record<string, unknown>): number | undefined {
  if (raw.timeout !== undefined) {
    const n = Number(raw.timeout);
    if (!Number.isFinite(n) || n < 0) {
      process.stderr.write(
        `harness error: --timeout must be a non-negative number of milliseconds\n`,
      );
      process.exit(1);
    }
    return n;
  }
  if (raw.wait === true) return 60 * 60 * 1000; // 1 hour — effectively wait
  return undefined;
}

function lockPathFor(root: string): string {
  return harnessPaths(root).dbLockPath;
}

/** Wrap a synchronous db CLI action with the maintenance lock. */
export function withLock(
  mode: LockMode,
  raw: Record<string, unknown>,
  fn: () => void,
): void {
  const root = getHarnessRoot();
  withMaintenanceLock(
    { path: lockPathFor(root), mode, ...(lockTimeoutMs(raw) !== undefined
      ? { timeoutMs: lockTimeoutMs(raw) as number } : {}) },
    fn,
  );
}

/** Async variant for actions that await. */
export function withLockAsync(
  mode: LockMode,
  raw: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const root = getHarnessRoot();
  return withMaintenanceLockAsync(
    { path: lockPathFor(root), mode, ...(lockTimeoutMs(raw) !== undefined
      ? { timeoutMs: lockTimeoutMs(raw) as number } : {}) },
    fn,
  );
}
