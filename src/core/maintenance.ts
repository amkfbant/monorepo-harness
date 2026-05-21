import { readFile, readdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { scanAllRuns } from "./review-lister.js";

export class MaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceError";
  }
}

export type FindingKind =
  | "stale-lock"
  | "orphan-worktree"
  | "cleaned-with-worktree"
  | "uncleaned-finished"
  | "large-run-dir";

export interface MaintenanceFinding {
  kind: FindingKind;
  /** runId or lock name — the thing the finding is about */
  target: string;
  detail: string;
  /** true when `maintenance cleanup` can safely remove it */
  cleanable: boolean;
  /** absolute path `maintenance cleanup` would delete (cleanable only) */
  cleanupPath?: string;
}

export interface CheckOpts {
  runsDir: string;
  workspacesDir: string;
  locksDir: string;
  now?: Date;
  /** a lock older than this is "stale" (default 2h) */
  staleLockMs?: number;
  /** a run dir larger than this is flagged (default 50 MiB) */
  largeRunDirBytes?: number;
}

const DEFAULT_STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const DEFAULT_LARGE_RUN_DIR_BYTES = 50 * 1024 * 1024;
const RUN_DIR_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

/**
 * Detect operational debris: stale locks, orphan worktrees, worktrees
 * left after cleanup / review, and oversized run dirs. Read-only.
 */
export async function checkMaintenance(
  opts: CheckOpts,
): Promise<MaintenanceFinding[]> {
  const now = opts.now ?? new Date();
  const staleLockMs = opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const largeBytes = opts.largeRunDirBytes ?? DEFAULT_LARGE_RUN_DIR_BYTES;
  const findings: MaintenanceFinding[] = [];

  // 1. stale locks — a lock is only AUTO-cleanable when we can confirm
  //    its owning process is dead. A live long-running run/review/cleanup
  //    must never have its lock removed (that would let a concurrent op
  //    corrupt the worktree / meta).
  for (const f of await readdirSafe(opts.locksDir)) {
    if (!f.endsWith(".lock")) continue;
    const lockPath = join(opts.locksDir, f);
    const lock = await inspectLock(lockPath, now);
    if (lock.ageMs === null || lock.ageMs <= staleLockMs) continue;
    const liveness = lockLiveness(lock);
    if (liveness === "alive") continue; // legitimate long-running lock
    const mins = Math.round(lock.ageMs / 60000);
    findings.push({
      kind: "stale-lock",
      target: f,
      detail:
        liveness === "dead"
          ? `held for ${mins}min, owning process is gone`
          : `held for ${mins}min, owner cannot be verified — inspect before deleting`,
      // only a confirmed-dead lock is auto-cleanable; an unverifiable
      // one (other host / corrupt JSON) is left for manual judgement.
      cleanable: liveness === "dead",
      ...(liveness === "dead" ? { cleanupPath: lockPath } : {}),
    });
  }

  // 2. orphan worktrees: workspaces/<id> with no runs/<id>/meta.json
  for (const id of await readdirSafe(opts.workspacesDir)) {
    if (!RUN_DIR_RE.test(id)) continue;
    if (!existsSync(join(opts.runsDir, id, "meta.json"))) {
      findings.push({
        kind: "orphan-worktree",
        target: id,
        detail: "workspace exists but the run dir is gone",
        cleanable: true,
        cleanupPath: join(opts.workspacesDir, id),
      });
    }
  }

  // 3. status-dependent findings — these need a readable meta.json.
  const { valid } = await scanAllRuns(opts.runsDir);
  for (const run of valid) {
    const hasWorktree = existsSync(
      join(opts.workspacesDir, run.runId, "repo"),
    );
    if (run.status === "cleaned" && hasWorktree) {
      findings.push({
        kind: "cleaned-with-worktree",
        target: run.runId,
        detail: "run is cleaned but its worktree still exists",
        cleanable: true,
        cleanupPath: join(opts.workspacesDir, run.runId),
      });
    } else if (
      (run.status === "approved" || run.status === "rejected") &&
      hasWorktree
    ) {
      findings.push({
        kind: "uncleaned-finished",
        target: run.runId,
        detail: `${run.status} run still has a worktree — run 'harness cleanup --run-id ${run.runId}'`,
        // not auto-cleaned: a finished run's cleanup goes through
        // `harness cleanup`, which also removes the run branch.
        cleanable: false,
      });
    }
  }

  // 4. oversized run dirs — enumerated directly so a run with a corrupt
  //    meta.json (excluded from `valid`) is still flagged for disk debris.
  for (const id of await readdirSafe(opts.runsDir)) {
    if (!RUN_DIR_RE.test(id)) continue;
    const bytes = await dirSize(join(opts.runsDir, id));
    if (bytes > largeBytes) {
      findings.push({
        kind: "large-run-dir",
        target: id,
        detail: `run dir is ${(bytes / 1024 / 1024).toFixed(1)} MiB`,
        cleanable: false,
      });
    }
  }
  return findings;
}

export interface CleanupOpts extends CheckOpts {
  dryRun: boolean;
  force: boolean;
  /** restrict to debris older than this many ms */
  olderThanMs?: number;
}

export interface CleanupResult {
  removed: MaintenanceFinding[];
  /** findings that were skipped (not cleanable, or filtered out) */
  skipped: MaintenanceFinding[];
  dryRun: boolean;
}

/**
 * Remove cleanable debris (stale locks, orphan / cleaned-run worktrees).
 * `dryRun` lists without deleting; a real delete requires `force`.
 */
export async function runMaintenanceCleanup(
  opts: CleanupOpts,
): Promise<CleanupResult> {
  const findings = await checkMaintenance(opts);
  const now = opts.now ?? new Date();
  const cleanable: MaintenanceFinding[] = [];
  const skipped: MaintenanceFinding[] = [];
  for (const f of findings) {
    if (!f.cleanable || f.cleanupPath === undefined) {
      skipped.push(f);
      continue;
    }
    if (opts.olderThanMs !== undefined) {
      const age = await pathAgeMs(f.cleanupPath, now);
      if (age === null || age < opts.olderThanMs) {
        skipped.push(f);
        continue;
      }
    }
    cleanable.push(f);
  }

  if (opts.dryRun) {
    return { removed: cleanable, skipped, dryRun: true };
  }
  if (cleanable.length > 0 && !opts.force) {
    throw new MaintenanceError(
      `maintenance cleanup would delete ${cleanable.length} item(s); ` +
        `re-run with --force to actually remove them`,
    );
  }
  for (const f of cleanable) {
    await rm(f.cleanupPath as string, { recursive: true, force: true });
  }
  return { removed: cleanable, skipped, dryRun: false };
}

/** Parse a `30d` / `12h` style duration into milliseconds. */
export function parseDuration(text: string): number {
  const m = text.match(/^(\d+)([dh])$/);
  if (!m) {
    throw new MaintenanceError(
      `invalid duration ${JSON.stringify(text)} (expected e.g. 30d or 12h)`,
    );
  }
  const n = Number(m[1]);
  return m[2] === "d" ? n * 86400000 : n * 3600000;
}

export function formatFindings(findings: MaintenanceFinding[]): string {
  if (findings.length === 0) return "No maintenance findings — all clean.\n";
  const lines: string[] = [];
  for (const f of findings) {
    const mark = f.cleanable ? "[cleanable]" : "[manual]   ";
    lines.push(`${mark} ${f.kind}: ${f.target}  — ${f.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatCleanupResult(result: CleanupResult): string {
  const lines: string[] = [];
  const verb = result.dryRun ? "would remove" : "removed";
  if (result.removed.length === 0) {
    lines.push(`maintenance cleanup: nothing to remove.`);
  } else {
    lines.push(`maintenance cleanup ${verb} ${result.removed.length} item(s):`);
    for (const f of result.removed) {
      lines.push(`  ${f.kind}: ${f.target}`);
    }
  }
  const manual = result.skipped.filter((f) => !f.cleanable);
  if (manual.length > 0) {
    lines.push(
      `${manual.length} finding(s) need manual action (see 'maintenance check').`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

interface LockInspection {
  ageMs: number | null;
  pid: number | null;
  host: string | null;
  /** false when the lock JSON could not be parsed */
  parseable: boolean;
}

/** Read a lock's age (from acquiredAt / mtime), pid and hostname. */
async function inspectLock(
  lockPath: string,
  now: Date,
): Promise<LockInspection> {
  let ageMs: number | null = null;
  try {
    const info = JSON.parse(await readFile(lockPath, "utf8")) as {
      acquiredAt?: unknown;
      pid?: unknown;
      hostname?: unknown;
    };
    if (typeof info.acquiredAt === "string") {
      const t = new Date(info.acquiredAt).getTime();
      if (!Number.isNaN(t)) ageMs = now.getTime() - t;
    }
    if (ageMs === null) ageMs = await pathAgeMs(lockPath, now);
    return {
      ageMs,
      pid: typeof info.pid === "number" ? info.pid : null,
      host: typeof info.hostname === "string" ? info.hostname : null,
      parseable: true,
    };
  } catch {
    // unparseable lock — age from mtime only
    return {
      ageMs: await pathAgeMs(lockPath, now),
      pid: null,
      host: null,
      parseable: false,
    };
  }
}

/**
 * Decide whether a lock's owning process is alive. "alive" → keep the
 * lock; "dead" → safe to auto-clean; "unknown" → another host / corrupt
 * JSON / no pid, so leave it for manual judgement.
 */
function lockLiveness(lock: LockInspection): "alive" | "dead" | "unknown" {
  if (!lock.parseable || lock.pid === null || lock.host === null) {
    return "unknown";
  }
  if (lock.host !== hostname()) return "unknown"; // can't probe another host
  try {
    process.kill(lock.pid, 0);
    return "alive";
  } catch (e) {
    // EPERM = the process exists but is not ours → still alive
    return (e as NodeJS.ErrnoException).code === "EPERM" ? "alive" : "dead";
  }
}

async function pathAgeMs(path: string, now: Date): Promise<number | null> {
  try {
    return now.getTime() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Recursive total size of a directory (0 on any error). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSize(p);
    } else if (e.isFile()) {
      try {
        total += (await stat(p)).size;
      } catch {
        // skip unreadable file
      }
    }
  }
  return total;
}
