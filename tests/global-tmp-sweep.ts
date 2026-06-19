import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_TMP_PREFIXES = [
  "harness-",
  "onb-",
  "ws-repo-",
  "legacy-lock-warn-",
] as const;

const STALE_TMP_DIR_AGE_MS = 60 * 60 * 1000;

/**
 * Prefix for the per-run PRIVATE temp subroot this module creates under the
 * real OS tmpdir. The whole subroot is deleted wholesale at teardown.
 */
export const RUN_TMP_PREFIX = "harness-vitest-run-";

function hasStaleTmpPrefix(
  basename: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some((prefix) => basename.startsWith(prefix));
}

function isStaleRealDirectory(path: string, nowMs: number): boolean {
  try {
    const stats = lstatSync(path);
    return (
      stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      nowMs - stats.mtimeMs > STALE_TMP_DIR_AGE_MS
    );
  } catch {
    return false;
  }
}

/**
 * Reclaim >1h-old prefix-matching real directories left under `root` by PRIOR
 * runs. Age-gated (>1h via mtime): a concurrent run's freshly-created dirs are
 * protected; only dirs idle for over an hour are reclaimed (a long-lived active
 * dir whose mtime is older than the threshold is the one theoretical exception).
 * Symlinks are skipped via lstat and never followed. Per-entry errors swallowed.
 */
export function sweepStaleTmpDirs(
  root: string,
  prefixes: readonly string[],
): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  const nowMs = Date.now();
  for (const entry of entries) {
    if (!hasStaleTmpPrefix(entry.name, prefixes)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

    const path = join(root, entry.name);
    if (!isStaleRealDirectory(path, nowMs)) continue;

    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort only: one undeletable stale dir must not block the run.
    }
  }
}

/**
 * Remove a single run-private subroot, swallowing errors so a teardown failure
 * never fails the suite. Only ever called with this run's OWN private root.
 */
export function removeRunTmpRoot(
  runRoot: string,
  remove: typeof rmSync = rmSync,
): void {
  try {
    remove(runRoot, { recursive: true, force: true });
  } catch {
    // Best effort only: an undeletable private root must not fail the run.
  }
}

/**
 * vitest globalSetup. The default export's return value is treated as a
 * teardown callback (vitest 2.x contract).
 *
 * Design: per-run PRIVATE TMPDIR subroot.
 *
 * setup:
 *   1. Reclaim >1h stale prefix dirs left under the real OS tmpdir by prior
 *      runs (age-gated `sweepStaleTmpDirs` — safe for concurrent runs since it
 *      cannot touch fresh/active dirs).
 *   2. Create a private subroot `harness-vitest-run-XXXX` under the real OS
 *      tmpdir and point `process.env.TMPDIR` at it. Forked test workers inherit
 *      this env at fork time, so `os.tmpdir()` resolves to the private subroot
 *      in every worker — even for the ~66 integration files that call
 *      `mkdtempSync(join(tmpdir(), ...))` at module top level. All their temp
 *      roots therefore land UNDER our private subroot. (Empirically verified
 *      against pool:forks/maxForks=4; see docs/specs/workflow.md.)
 *
 * teardown:
 *   Delete EXCLUSIVELY our own private subroot (`rmSync` recursive). There is
 *   no prefix/snapshot/age scan of the shared tmpdir, so a concurrent external
 *   or production harness run on the same machine — which creates same-prefix
 *   dirs like `harness-reviewer-input-` directly under the OS tmpdir — is never
 *   at risk: we only ever remove the directory we created.
 */
export default async function globalTmpSweep(): Promise<() => void> {
  const osTmp = tmpdir();
  sweepStaleTmpDirs(osTmp, STALE_TMP_PREFIXES);

  const priorTmpdir = process.env.TMPDIR;
  const runRoot = mkdtempSync(join(osTmp, RUN_TMP_PREFIX));
  // Redirect the process (and inherited fork) temp dir to the private subroot.
  process.env.TMPDIR = runRoot;

  return () => {
    // Restore the prior TMPDIR before deleting the subroot so the main process
    // never points at a removed path (matters for --watch reruns).
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    removeRunTmpRoot(runRoot);
  };
}
