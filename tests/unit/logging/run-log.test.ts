import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunLog, type RunMeta } from "../../../src/logging/run-log.js";

const META: RunMeta = {
  runId: "run-20260520-apps-user-abc",
  repoId: "sample-monorepo",
  repoPath: "/tmp/repo",
  domain: "apps/user",
  workflow: "domain-coding",
  baseBranch: "main",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  runBranch: "harness/run-20260520-apps-user-abc/apps-user",
  status: "running",
  startedAt: "2026-05-20T00:00:00.000Z",
};

describe("createRunLog", () => {
  it("creates the run dir atomically and writes meta.json + events", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: META.runId,
      meta: META,
    });
    expect(existsSync(log.runDir)).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(log.runDir, "meta.json"), "utf8"),
    );
    expect(meta.baseSha).toBe(META.baseSha);

    await log.emit({ type: "run_started", runId: META.runId });
    const events = readFileSync(join(log.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0]).toEqual({ type: "run_started", runId: META.runId });
  });

  it("fails with EEXIST when the run directory already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    mkdirSync(join(root, META.runId));
    await expect(
      createRunLog({ runsDir: root, runId: META.runId, meta: META }),
    ).rejects.toThrow(/EEXIST/);
  });

  it("setStatus updates only the status field", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: META.runId,
      meta: META,
    });
    await log.setStatus("generated");
    const meta = JSON.parse(
      readFileSync(join(log.runDir, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("generated");
    expect(meta.runId).toBe(META.runId);
  });

  it("finalize updates status + safetyStatus + finishedAt", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: META.runId,
      meta: META,
    });
    await log.finalize({
      status: "needs_review",
      safetyStatus: "allowed",
      ignoredUntrackedCount: 3,
      secretSuspectCount: 2,
      finishedAt: "2026-05-20T01:00:00.000Z",
    });
    const meta = JSON.parse(
      readFileSync(join(log.runDir, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("needs_review");
    expect(meta.safetyStatus).toBe("allowed");
    expect(meta.ignoredUntrackedCount).toBe(3);
    expect(meta.secretSuspectCount).toBe(2);
    expect(meta.finishedAt).toBe("2026-05-20T01:00:00.000Z");
  });

  it("setSafetyStatus updates only safetyStatus", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: META.runId,
      meta: META,
    });
    await log.setSafetyStatus("skipped");
    const meta = JSON.parse(
      readFileSync(join(log.runDir, "meta.json"), "utf8"),
    );
    expect(meta.safetyStatus).toBe("skipped");
    expect(meta.status).toBe("running");
  });

  it("setReviewerInfo updates reviewer + reviewedAt", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: META.runId,
      meta: META,
    });
    await log.setReviewerInfo({
      reviewer: "alice",
      reviewedAt: "2026-05-20T12:00:00Z",
    });
    const meta = JSON.parse(
      readFileSync(join(log.runDir, "meta.json"), "utf8"),
    );
    expect(meta.reviewer).toBe("alice");
    expect(meta.reviewedAt).toBe("2026-05-20T12:00:00Z");
  });
});
