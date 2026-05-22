import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionPlan,
  formatSessionPlan,
  formatSessionSummary,
} from "../../src/core/session.js";
import { addItem } from "../../src/core/backlog.js";

let seq = 0;

interface Root {
  runsDir: string;
  workspacesDir: string;
  backlogDir: string;
  knowledgeDir: string;
}

function harnessRoot(): Root {
  const root = mkdtempSync(join(tmpdir(), "harness-ses-"));
  const r = {
    runsDir: join(root, "runs"),
    workspacesDir: join(root, "workspaces"),
    backlogDir: join(root, "backlog"),
    knowledgeDir: join(root, "docs", "knowledge"),
  };
  mkdirSync(r.runsDir, { recursive: true });
  mkdirSync(r.workspacesDir, { recursive: true });
  return r;
}

function writeRun(
  r: Root,
  status: string,
  opts: { worktree?: boolean } = {},
): string {
  const runId = `run-20260521-apps-user-se${String(seq++).padStart(2, "0")}`;
  mkdirSync(join(r.runsDir, runId), { recursive: true });
  writeFileSync(
    join(r.runsDir, runId, "meta.json"),
    JSON.stringify({
      runId,
      domain: "apps/user",
      status,
      safetyStatus: "allowed",
      startedAt: "2026-05-21T00:00:00Z",
    }),
  );
  writeFileSync(join(r.runsDir, runId, "knowledge-candidates.yaml"), "candidates: []\n");
  if (opts.worktree) {
    mkdirSync(join(r.workspacesDir, runId, "repo"), { recursive: true });
  }
  return runId;
}

describe("buildSessionPlan", () => {
  it("E4-7: orders items failed → needs_review → cr → cleanup → backlog", async () => {
    const r = harnessRoot();
    writeRun(r, "needs_review");
    writeRun(r, "failed-policy-violation");
    writeRun(r, "changes_requested");
    writeRun(r, "approved", { worktree: true }); // cleanup candidate
    await addItem(r.backlogDir, {
      title: "a backlog task",
      domain: "apps/x",
      goal: "g",
    });

    const plan = await buildSessionPlan(r);
    const categories = plan.items.map((i) => i.category);
    // the rule order: failed first, backlog last
    expect(categories[0]).toBe("failed");
    expect(categories).toEqual([
      "failed",
      "needs_review",
      "changes_requested",
      "cleanup",
      "backlog",
    ]);
    expect(plan.items[0]?.order).toBe(1);
    expect(plan.counts.failed).toBe(1);
    expect(plan.counts.backlog).toBe(1);
  });

  it("high-priority backlog items come before lower priority", async () => {
    const r = harnessRoot();
    await addItem(r.backlogDir, {
      title: "low one",
      domain: "apps/x",
      goal: "g",
      priority: "low",
    });
    await addItem(r.backlogDir, {
      title: "high one",
      domain: "apps/x",
      goal: "g",
      priority: "high",
    });
    const plan = await buildSessionPlan(r);
    const backlog = plan.items.filter((i) => i.category === "backlog");
    expect(backlog[0]?.detail).toMatch(/high one/);
  });

  it("E4-7: each item carries an action command but nothing is run", async () => {
    const r = harnessRoot();
    writeRun(r, "needs_review");
    const plan = await buildSessionPlan(r);
    expect(plan.items[0]?.action).toMatch(/^harness review auto --run-id/);
  });

  it("formatSessionPlan caps to the limit", async () => {
    const r = harnessRoot();
    writeRun(r, "failed-codex");
    writeRun(r, "needs_review");
    writeRun(r, "changes_requested");
    const plan = await buildSessionPlan(r);
    const text = formatSessionPlan(plan, 1);
    expect(text).toMatch(/1\. \[failed\]/);
    expect(text).not.toMatch(/2\. /);
    expect(text).toMatch(/2 more/);
  });

  it("reports an empty plan", async () => {
    const r = harnessRoot();
    const plan = await buildSessionPlan(r);
    expect(plan.items).toHaveLength(0);
    expect(formatSessionPlan(plan)).toMatch(/No session-plan items/);
  });

  it("E4-7: formatSessionSummary renders a snapshot", async () => {
    const r = harnessRoot();
    writeRun(r, "failed-codex");
    writeRun(r, "needs_review");
    const summary = formatSessionSummary(await buildSessionPlan(r));
    expect(summary).toMatch(/failed:\s+1/);
    expect(summary).toMatch(/needs_review:\s+1/);
    expect(summary).toMatch(/2 item\(s\) in the session plan/);
  });
});
