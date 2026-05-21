import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { scanAllRuns, type ListResult } from "./review-lister.js";
import { loadFromIndex } from "../index/run-index.js";

const RUN_DIR_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

/**
 * Load every run (valid + invalid) for the personal-operations CLIs
 * (inbox / metrics / session).
 *
 * The SQLite index is a cache and goes stale until `index rebuild`. For
 * "what should I do now" views, a stale index that hides a new
 * failed / needs_review run is worse than a slightly slower scan — so
 * the index is used ONLY when it still covers exactly the run dirs
 * present on disk. Any add/remove since the last rebuild → file scan.
 */
export async function loadAllRuns(
  runsDir: string,
  indexDbPath: string,
): Promise<{ result: ListResult; source: "index" | "file-scan" }> {
  if (existsSync(indexDbPath)) {
    try {
      const indexed = loadFromIndex(indexDbPath);
      const onDisk = await countRunDirs(runsDir);
      if (onDisk === indexed.valid.length + indexed.invalid.length) {
        return { result: indexed, source: "index" };
      }
      // count mismatch → a run was added/removed since the last rebuild
    } catch {
      // outdated / corrupt index — fall through to the file scan
    }
  }
  return { result: await scanAllRuns(runsDir), source: "file-scan" };
}

/** Number of `run-*` dirs in runs/ (matches what scanAllRuns enumerates). */
async function countRunDirs(runsDir: string): Promise<number> {
  try {
    return (await readdir(runsDir)).filter((e) => RUN_DIR_RE.test(e)).length;
  } catch {
    return 0;
  }
}
