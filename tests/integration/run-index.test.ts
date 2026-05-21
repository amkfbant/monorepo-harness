import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rebuildIndex,
  loadFromIndex,
  indexStatus,
  showRunFromIndex,
} from "../../src/index/run-index.js";
import {
  scanAllRuns,
  listReviews,
  applyListFilters,
  formatTable,
} from "../../src/core/review-lister.js";

let seq = 0;

function writeRun(
  runsDir: string,
  over: Record<string, unknown> = {},
): string {
  const runId =
    (over.runId as string) ??
    `run-20260521-apps-user-idx${String(seq++).padStart(2, "0")}`;
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      repoId: "t",
      domain: "apps/user",
      workflow: "domain-coding",
      baseBranch: "main",
      status: "needs_review",
      safetyStatus: "allowed",
      startedAt: "2026-05-21T00:00:00Z",
      ...over,
    }),
  );
  return runId;
}

function setup(): { root: string; runsDir: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-idx-"));
  return {
    root,
    runsDir: join(root, "runs"),
    dbPath: join(root, ".harness", "index.sqlite"),
  };
}

describe("run index", () => {
  it("rebuilds the index from a runs/ scan", async () => {
    const { runsDir, dbPath } = setup();
    writeRun(runsDir);
    writeRun(runsDir, { runId: "run-20260521-apps-user-idxA" });
    const scan = await scanAllRuns(runsDir);
    const stats = rebuildIndex(dbPath, scan);
    expect(stats.runCount).toBe(2);
    expect(existsSync(dbPath)).toBe(true);
    const st = indexStatus(dbPath);
    expect(st.exists).toBe(true);
    expect(st.runCount).toBe(2);
  });

  it("E3-5-2: --use-index path equals the file-scan path", async () => {
    const { runsDir, dbPath } = setup();
    writeRun(runsDir, { runId: "run-20260521-apps-user-idxF1" });
    writeRun(runsDir, {
      runId: "run-20260521-apps-user-idxF2",
      status: "approved",
      startedAt: "2026-05-21T01:00:00Z",
    });
    writeRun(runsDir, {
      runId: "run-20260521-apps-orders-idxF3",
      domain: "apps/orders",
      status: "changes_requested",
    });
    rebuildIndex(dbPath, await scanAllRuns(runsDir));

    // default queue (needs_review + changes_requested)
    const fromFiles = await listReviews({ runsDir });
    const idx = loadFromIndex(dbPath);
    const fromIndex = applyListFilters(idx.valid, idx.invalid, {});
    expect(formatTable(fromIndex)).toBe(formatTable(fromFiles));

    // with a domain filter + --all
    const filesAll = await listReviews({ runsDir, all: true, domain: "apps/orders" });
    const indexAll = applyListFilters(idx.valid, idx.invalid, {
      all: true,
      domain: "apps/orders",
    });
    expect(formatTable(indexAll)).toBe(formatTable(filesAll));
  });

  it("captures invalid run dirs in the index too", async () => {
    const { runsDir, dbPath } = setup();
    writeRun(runsDir, { runId: "run-20260521-apps-user-idxOK" });
    // a broken run dir: meta.json is not JSON
    const bad = join(runsDir, "run-20260521-apps-user-idxBAD");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "meta.json"), "{not json");
    rebuildIndex(dbPath, await scanAllRuns(runsDir));
    const idx = loadFromIndex(dbPath);
    expect(idx.valid).toHaveLength(1);
    expect(idx.invalid).toHaveLength(1);
    expect(idx.invalid[0]?.runId).toBe("run-20260521-apps-user-idxBAD");
  });

  it("E3-5-3: a corrupt index recovers via rebuild", async () => {
    const { runsDir, dbPath } = setup();
    writeRun(runsDir, { runId: "run-20260521-apps-user-idxC1" });
    rebuildIndex(dbPath, await scanAllRuns(runsDir));
    // corrupt the db file
    writeFileSync(dbPath, "this is not a sqlite database");
    // rebuild deletes + recreates → recovers
    const stats = rebuildIndex(dbPath, await scanAllRuns(runsDir));
    expect(stats.runCount).toBe(1);
    expect(loadFromIndex(dbPath).valid).toHaveLength(1);
  });

  it("preserves command summary and counts through the index", async () => {
    const { runsDir, dbPath } = setup();
    writeRun(runsDir, {
      runId: "run-20260521-apps-user-idxCS",
      commandResults: [
        { command: "a", exitCode: 0, durationMs: 1, timedOut: false },
        { command: "b", exitCode: 1, durationMs: 1, timedOut: false },
      ],
      secretSuspectCount: 3,
      ignoredUntrackedCount: 1,
    });
    rebuildIndex(dbPath, await scanAllRuns(runsDir));
    const found = showRunFromIndex(dbPath, "run-20260521-apps-user-idxCS");
    expect(found?.kind).toBe("valid");
    if (found?.kind !== "valid") throw new Error("expected valid");
    expect(found.entry.commandSummary).toEqual({ ok: 1, total: 2 });
    expect(found.entry.secretSuspectCount).toBe(3);
    expect(found.entry.ignoredUntrackedCount).toBe(1);
  });

  it("showRunFromIndex finds an invalid run too", async () => {
    const { runsDir, dbPath } = setup();
    const bad = join(runsDir, "run-20260521-apps-user-idxINV");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "meta.json"), "{broken");
    rebuildIndex(dbPath, await scanAllRuns(runsDir));
    const found = showRunFromIndex(dbPath, "run-20260521-apps-user-idxINV");
    expect(found?.kind).toBe("invalid");
  });

  it("indexStatus reports corrupt rather than throwing", async () => {
    const { runsDir, dbPath } = setup();
    writeRun(runsDir, { runId: "run-20260521-apps-user-idxCR" });
    rebuildIndex(dbPath, await scanAllRuns(runsDir));
    writeFileSync(dbPath, "not a sqlite file");
    const st = indexStatus(dbPath);
    expect(st.exists).toBe(true);
    expect(st.corrupt).toBe(true);
  });

  it("a failed rebuild leaves the previous index intact (atomic)", async () => {
    const { runsDir, dbPath } = setup();
    writeRun(runsDir, { runId: "run-20260521-apps-user-idxAT" });
    rebuildIndex(dbPath, await scanAllRuns(runsDir));
    // a scan with a duplicate run_id makes the INSERT transaction fail
    const dup = {
      runId: "run-20260521-apps-user-idxAT",
      domain: "apps/user",
      status: "needs_review" as const,
      safetyStatus: null,
      reviewer: null,
      reviewedAt: null,
      parentRunId: null,
      commandSummary: null,
      changedFilesCount: null,
      secretSuspectCount: null,
      ignoredUntrackedCount: null,
      startedAt: null,
      finishedAt: null,
    };
    expect(() =>
      rebuildIndex(dbPath, { valid: [dup, dup], invalid: [] }),
    ).toThrow();
    // the original index is still there and readable
    expect(loadFromIndex(dbPath).valid).toHaveLength(1);
  });

  it("loadFromIndex throws a clear error when the index is absent", () => {
    const { dbPath } = setup();
    expect(() => loadFromIndex(dbPath)).toThrow(/index not found/);
  });

  it("indexStatus reports not-built before the first rebuild", () => {
    const { dbPath } = setup();
    expect(indexStatus(dbPath).exists).toBe(false);
  });
});
