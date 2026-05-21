import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllRuns } from "../../src/core/run-source.js";
import { scanAllRuns } from "../../src/core/review-lister.js";
import { rebuildIndex } from "../../src/index/run-index.js";

let seq = 0;

function setup(): { runsDir: string; indexDbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-rs-"));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  return { runsDir, indexDbPath: join(root, ".harness", "index.sqlite") };
}

function writeRun(runsDir: string, status = "needs_review"): string {
  const runId = `run-20260521-apps-user-rs${String(seq++).padStart(2, "0")}`;
  mkdirSync(join(runsDir, runId), { recursive: true });
  writeFileSync(
    join(runsDir, runId, "meta.json"),
    JSON.stringify({
      runId,
      domain: "apps/user",
      status,
      safetyStatus: "allowed",
      startedAt: "2026-05-21T00:00:00Z",
    }),
  );
  return runId;
}

describe("loadAllRuns", () => {
  it("uses the index when it covers exactly the run dirs on disk", async () => {
    const { runsDir, indexDbPath } = setup();
    writeRun(runsDir);
    writeRun(runsDir);
    rebuildIndex(indexDbPath, await scanAllRuns(runsDir));
    const { result, source } = await loadAllRuns(runsDir, indexDbPath);
    expect(source).toBe("index");
    expect(result.valid).toHaveLength(2);
  });

  it("P1: falls back to file scan when a run was added after rebuild", async () => {
    const { runsDir, indexDbPath } = setup();
    writeRun(runsDir);
    rebuildIndex(indexDbPath, await scanAllRuns(runsDir));
    // a new run appears AFTER the index was built — index is now stale
    writeRun(runsDir, "failed-policy-violation");
    const { result, source } = await loadAllRuns(runsDir, indexDbPath);
    // must NOT trust the stale index and miss the new failed run
    expect(source).toBe("file-scan");
    expect(result.valid).toHaveLength(2);
  });

  it("falls back to file scan when there is no index", async () => {
    const { runsDir, indexDbPath } = setup();
    writeRun(runsDir);
    const { source } = await loadAllRuns(runsDir, indexDbPath);
    expect(source).toBe("file-scan");
  });
});
