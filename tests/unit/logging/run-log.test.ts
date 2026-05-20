import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunLog } from "../../../src/logging/run-log.js";

describe("createRunLog", () => {
  it("creates run dir and writes meta.json + first event", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: "run-20260520-001",
      meta: {
        runId: "run-20260520-001",
        repoId: "sample-monorepo",
        repoPath: "/tmp/repo",
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        runBranch: "harness/run-20260520-001/apps-user",
        status: "running",
        startedAt: "2026-05-20T00:00:00.000Z",
      },
    });
    expect(existsSync(log.runDir)).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(log.runDir, "meta.json"), "utf8"),
    );
    expect(meta.runId).toBe("run-20260520-001");

    await log.emit({ type: "run_started", runId: "run-20260520-001" });
    const events = readFileSync(join(log.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0]).toEqual({
      type: "run_started",
      runId: "run-20260520-001",
    });
  });

  it("updates meta.status on finalize", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: "run-20260520-002",
      meta: {
        runId: "run-20260520-002",
        repoId: "x",
        repoPath: "/tmp",
        domain: "d",
        workflow: "domain-coding",
        baseBranch: "main",
        runBranch: "b",
        status: "running",
        startedAt: "2026-05-20T00:00:00.000Z",
      },
    });
    await log.finalize({
      status: "success",
      finishedAt: "2026-05-20T01:00:00.000Z",
    });
    const meta = JSON.parse(
      readFileSync(join(log.runDir, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("success");
    expect(meta.finishedAt).toBe("2026-05-20T01:00:00.000Z");
  });
});
