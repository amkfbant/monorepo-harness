import { lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_TMP_PREFIXES = [
  "harness-",
  "onb-",
  "ws-repo-",
  "legacy-lock-warn-",
] as const;

const STALE_TMP_DIR_AGE_MS = 60 * 60 * 1000;

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

export default async function globalTmpSweep(): Promise<void> {
  sweepStaleTmpDirs(tmpdir(), STALE_TMP_PREFIXES);
}
