import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderRunShow,
  renderRunTimeline,
  renderRunArtifacts,
} from "../../../src/core/run-viewer.js";

function setupRun(
  meta: Record<string, unknown>,
  opts: { events?: string[]; artifacts?: string[] } = {},
): { runsDir: string; runId: string } {
  const runsDir = mkdtempSync(join(tmpdir(), "harness-rv-"));
  const runId = (meta.runId as string) ?? "run-20260521-apps-user-rv1";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "meta.json"), JSON.stringify({ runId, ...meta }));
  for (const a of opts.artifacts ?? ["summary.md", "final-diff.patch"]) {
    writeFileSync(join(runDir, a), "x\n");
  }
  if (opts.events) {
    writeFileSync(join(runDir, "events.jsonl"), opts.events.join("\n") + "\n");
  }
  return { runsDir, runId };
}

describe("renderRunShow", () => {
  it("E4-1-1: shows an approved run's summary", async () => {
    const { runsDir, runId } = setupRun({
      domain: "apps/orders",
      status: "approved",
      safetyStatus: "allowed",
      reviewer: "codex-reviewer",
      reviewedAt: "2026-05-21T00:00:00Z",
      changedFilesCount: 2,
      secretSuspectCount: 0,
      ignoredUntrackedCount: 0,
      commandResults: [
        { command: "test", exitCode: 0, durationMs: 3200, timedOut: false },
      ],
    });
    const out = await renderRunShow(runsDir, runId);
    expect(out).toMatch(/Status: approved/);
    expect(out).toMatch(/Domain: apps\/orders/);
    expect(out).toMatch(/test: ok 3\.2s/);
    expect(out).toMatch(/summary\.md/);
  });

  it("E4-1-3: shows a failed-policy-violation run", async () => {
    const { runsDir, runId } = setupRun({
      domain: "apps/catalog",
      status: "failed-policy-violation",
      safetyStatus: "denied",
    });
    const out = await renderRunShow(runsDir, runId);
    expect(out).toMatch(/Status: failed-policy-violation/);
    expect(out).toMatch(/Safety: denied/);
  });

  it("E4-1-4: shows parent / root / attempt for a rerun", async () => {
    const { runsDir, runId } = setupRun({
      domain: "apps/orders",
      status: "needs_review",
      parentRunId: "run-20260521-apps-orders-parent",
      rootRunId: "run-20260521-apps-orders-root",
      rerunAttempt: 2,
    });
    const out = await renderRunShow(runsDir, runId);
    expect(out).toMatch(/Parent: run-20260521-apps-orders-parent/);
    expect(out).toMatch(/Root: run-20260521-apps-orders-root/);
    expect(out).toMatch(/Attempt: 2/);
  });

  it("shows the PR URL when present", async () => {
    const { runsDir, runId } = setupRun({
      domain: "apps/x",
      status: "approved",
      prUrl: "https://github.com/o/r/pull/3",
    });
    expect(await renderRunShow(runsDir, runId)).toMatch(/pull\/3/);
  });

  it("shows (not reviewed) for a run with no reviewedAt", async () => {
    const { runsDir, runId } = setupRun({
      domain: "apps/x",
      status: "needs_review",
    });
    const out = await renderRunShow(runsDir, runId);
    expect(out).toMatch(/Review:\n {2}\(not reviewed\)/);
    expect(out).not.toMatch(/decision:/);
  });

  it("shows the review decision once reviewedAt is set", async () => {
    const { runsDir, runId } = setupRun({
      domain: "apps/x",
      status: "approved",
      reviewer: "knkn",
      reviewedAt: "2026-05-21T00:00:00Z",
    });
    const out = await renderRunShow(runsDir, runId);
    expect(out).toMatch(/decision: approved/);
    expect(out).toMatch(/reviewer: knkn/);
  });

  it("E4-1-6: does not crash when artifacts are missing", async () => {
    const { runsDir, runId } = setupRun(
      { domain: "apps/x", status: "needs_review" },
      { artifacts: [] },
    );
    const out = await renderRunShow(runsDir, runId);
    expect(out).toMatch(/Artifacts:/);
    expect(out).toMatch(/\(none\)/);
  });

  it("errors on an unknown run", async () => {
    const { runsDir } = setupRun({ domain: "apps/x", status: "needs_review" });
    await expect(
      renderRunShow(runsDir, "run-20260521-missing"),
    ).rejects.toThrow(/not found/);
  });

  it("errors on an invalid runId", async () => {
    await expect(renderRunShow("/tmp", "../escape")).rejects.toThrow(
      /invalid runId/,
    );
  });
});

describe("renderRunTimeline", () => {
  it("E4-1-5: renders events.jsonl in order", async () => {
    const { runsDir, runId } = setupRun(
      { domain: "apps/x", status: "approved" },
      {
        events: [
          JSON.stringify({ type: "run_started" }),
          JSON.stringify({ type: "codex_exec_completed", exitCode: 0 }),
          JSON.stringify({ type: "diff_collected", stage: "post-codex" }),
          JSON.stringify({ type: "run_completed", status: "needs_review" }),
        ],
      },
    );
    const out = await renderRunTimeline(runsDir, runId);
    expect(out).toMatch(/01\. run_started/);
    expect(out).toMatch(/02\. codex_exec_completed exitCode=0/);
    expect(out).toMatch(/03\. diff_collected stage="post-codex"/);
    // ordering preserved
    expect(out.indexOf("run_started")).toBeLessThan(
      out.indexOf("run_completed"),
    );
  });

  it("tolerates a missing events.jsonl", async () => {
    const { runsDir, runId } = setupRun({
      domain: "apps/x",
      status: "running",
    });
    expect(await renderRunTimeline(runsDir, runId)).toMatch(/no events/);
  });

  it("tolerates an unparseable event line without consuming an ordinal", async () => {
    const { runsDir, runId } = setupRun(
      { domain: "apps/x", status: "approved" },
      {
        events: [
          "{not json",
          JSON.stringify({ type: "run_started" }),
          JSON.stringify({ type: "run_completed" }),
        ],
      },
    );
    const out = await renderRunTimeline(runsDir, runId);
    expect(out).toMatch(/skipped 1 unparseable line/);
    // the two valid events keep ordinals 01 and 02 (the bad line is not 01)
    expect(out).toMatch(/01\. run_started/);
    expect(out).toMatch(/02\. run_completed/);
  });
});

describe("renderRunArtifacts", () => {
  it("lists the run dir's files", async () => {
    const { runsDir, runId } = setupRun(
      { domain: "apps/x", status: "approved" },
      { artifacts: ["summary.md", "final-diff.patch"] },
    );
    const out = await renderRunArtifacts(runsDir, runId);
    expect(out).toMatch(/summary\.md/);
    expect(out).toMatch(/final-diff\.patch/);
    expect(out).toMatch(/meta\.json/); // always present
  });

  it("summarises subdirectories with an entry count", async () => {
    const { runsDir, runId } = setupRun(
      { domain: "apps/x", status: "approved" },
      { artifacts: ["summary.md"] },
    );
    const cmdDir = join(runsDir, runId, "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "a.log"), "x");
    writeFileSync(join(cmdDir, "b.log"), "x");
    const out = await renderRunArtifacts(runsDir, runId);
    expect(out).toMatch(/commands\/ \(2 entries\)/);
  });
});
