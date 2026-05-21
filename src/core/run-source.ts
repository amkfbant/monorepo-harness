import { existsSync } from "node:fs";
import { scanAllRuns, type ListResult } from "./review-lister.js";
import { loadFromIndex } from "../index/run-index.js";

/**
 * Load every run (valid + invalid) for the personal-operations CLIs
 * (inbox / metrics / session). Uses the SQLite index when it is present
 * and current; otherwise — or if the index is stale/corrupt — falls back
 * to a full `runs/` file scan. The index is only ever a cache.
 */
export async function loadAllRuns(
  runsDir: string,
  indexDbPath: string,
): Promise<{ result: ListResult; source: "index" | "file-scan" }> {
  if (existsSync(indexDbPath)) {
    try {
      return { result: loadFromIndex(indexDbPath), source: "index" };
    } catch {
      // outdated / corrupt index — fall through to the file scan
    }
  }
  return { result: await scanAllRuns(runsDir), source: "file-scan" };
}
