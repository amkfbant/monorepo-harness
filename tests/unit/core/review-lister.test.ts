import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listReviews,
  formatTable,
} from "../../../src/core/review-lister.js";

function writeRun(
  runsDir: string,
  runId: string,
  meta: Record<string, unknown>,
): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

describe("listReviews", () => {
  it("returns empty when runsDir does not exist", async () => {
    const r = await listReviews({ runsDir: "/tmp/nope/nowhere/here" });
    expect(r).toEqual([]);
  });

  it("returns empty when runsDir has no runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-list-"));
    const r = await listReviews({ runsDir: root });
    expect(r).toEqual([]);
  });

  it("by default returns only needs_review entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-list-"));
    writeRun(root, "run-20260520-apps-catalog-a1", {
      runId: "run-20260520-apps-catalog-a1",
      domain: "apps/catalog",
      status: "needs_review",
      safetyStatus: "allowed",
      changedFilesCount: 2,
      secretSuspectCount: 0,
      ignoredUntrackedCount: 0,
      startedAt: "2026-05-20T10:00:00Z",
    });
    writeRun(root, "run-20260520-apps-orders-b2", {
      runId: "run-20260520-apps-orders-b2",
      domain: "apps/orders",
      status: "approved",
      safetyStatus: "allowed",
      changedFilesCount: 3,
      secretSuspectCount: 0,
      ignoredUntrackedCount: 0,
      startedAt: "2026-05-20T11:00:00Z",
    });
    const r = await listReviews({ runsDir: root });
    expect(r.map((e) => e.runId)).toEqual(["run-20260520-apps-catalog-a1"]);
  });

  it("--all returns every run regardless of status", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-list-"));
    writeRun(root, "run-20260520-x-a", {
      runId: "run-20260520-x-a",
      domain: "x",
      status: "needs_review",
      startedAt: "2026-05-20T10:00:00Z",
    });
    writeRun(root, "run-20260520-x-b", {
      runId: "run-20260520-x-b",
      domain: "x",
      status: "cleaned",
      startedAt: "2026-05-20T11:00:00Z",
    });
    const r = await listReviews({ runsDir: root, all: true });
    expect(r).toHaveLength(2);
  });

  it("sorts newest first by startedAt", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-list-"));
    writeRun(root, "run-20260520-x-a", {
      runId: "run-20260520-x-a",
      domain: "x",
      status: "needs_review",
      startedAt: "2026-05-20T10:00:00Z",
    });
    writeRun(root, "run-20260520-x-c", {
      runId: "run-20260520-x-c",
      domain: "x",
      status: "needs_review",
      startedAt: "2026-05-20T15:00:00Z",
    });
    writeRun(root, "run-20260520-x-b", {
      runId: "run-20260520-x-b",
      domain: "x",
      status: "needs_review",
      startedAt: "2026-05-20T12:00:00Z",
    });
    const r = await listReviews({ runsDir: root });
    expect(r.map((e) => e.runId)).toEqual([
      "run-20260520-x-c",
      "run-20260520-x-b",
      "run-20260520-x-a",
    ]);
  });

  it("surfaces unreadable meta.json with an error field (always included)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-list-"));
    mkdirSync(join(root, "run-20260520-broken-1"), { recursive: true });
    writeFileSync(
      join(root, "run-20260520-broken-1", "meta.json"),
      "{ this is not json",
    );
    const r = await listReviews({ runsDir: root });
    expect(r).toHaveLength(1);
    expect(r[0]?.error).toMatch(/Unexpected|JSON/);
  });

  it("ignores directories that don't match the run-id shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-list-"));
    mkdirSync(join(root, "not-a-run"), { recursive: true });
    mkdirSync(join(root, ".cache"), { recursive: true });
    writeRun(root, "run-20260520-x-a", {
      runId: "run-20260520-x-a",
      domain: "x",
      status: "needs_review",
      startedAt: "2026-05-20T10:00:00Z",
    });
    const r = await listReviews({ runsDir: root, all: true });
    expect(r.map((e) => e.runId)).toEqual(["run-20260520-x-a"]);
  });

  it("treats missing counts as '?' rather than crashing", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-list-"));
    writeRun(root, "run-20260520-old-x", {
      runId: "run-20260520-old-x",
      domain: "x",
      status: "needs_review",
      startedAt: "2026-05-20T09:00:00Z",
      // no changedFilesCount, secretSuspectCount, ignoredUntrackedCount
    });
    const r = await listReviews({ runsDir: root });
    expect(r[0]?.changedFilesCount).toBe("?");
    expect(r[0]?.secretSuspectCount).toBe("?");
    expect(r[0]?.ignoredUntrackedCount).toBe("?");
  });
});

describe("formatTable", () => {
  it("returns 'no runs' for empty input", () => {
    expect(formatTable([])).toBe("no runs\n");
  });

  it("renders a header + row with padded columns", () => {
    const out = formatTable([
      {
        runId: "run-X",
        domain: "apps/user",
        status: "needs_review",
        safetyStatus: "allowed",
        changedFilesCount: 2,
        secretSuspectCount: 0,
        ignoredUntrackedCount: 0,
        startedAt: "2026-05-20T10:00:00Z",
      },
    ]);
    expect(out).toMatch(/runId/);
    expect(out).toMatch(/run-X/);
    expect(out).toMatch(/needs_review/);
    expect(out).toMatch(/apps\/user/);
  });

  it("renders error rows clearly", () => {
    const out = formatTable([
      {
        runId: "run-broken",
        domain: "?",
        status: "?",
        safetyStatus: "?",
        changedFilesCount: "?",
        secretSuspectCount: "?",
        ignoredUntrackedCount: "?",
        startedAt: "?",
        error: "bad json",
      },
    ]);
    expect(out).toMatch(/unreadable: bad json/);
  });
});
