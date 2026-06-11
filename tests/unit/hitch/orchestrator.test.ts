import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { HitchOrchestrator } from "../../../src/hitch/orchestrator.js";
import type { OrchestratorRunners } from "../../../src/hitch/orchestrator-types.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "harness-orch-")), "harness.sqlite");
}

function seedCloseReady(dbPath: string): void {
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    repo.createSession({
      hitchId: "g-close",
      title: "Close ready",
      projectId: "demo",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      createdBy: "test",
      createdSource: "worker",
    });
    repo.recordCloseCheck({
      hitchId: "g-close",
      conditionId: "typecheck",
      status: "passed",
      checkedBy: "test",
    });
  } finally {
    close();
  }
}

function fakeRunners(calls: string[]): OrchestratorRunners {
  return {
    coder: async () => { calls.push("coder"); return { runId: "r1", runStatus: "needs_review" }; },
    review: async () => { calls.push("review"); return { runId: "r1", decision: "approved" }; },
    classify: async () => { calls.push("classify"); return { resolved: true }; },
    defer: async () => { calls.push("defer"); return { deferred: 1 }; },
    closeAndPr: async () => { calls.push("closeAndPr"); return { prUrl: "https://example/pr/1", draft: true }; },
  };
}

describe("HitchOrchestrator", () => {
  it("closes a close_ready goal and creates a PR", async () => {
    const dbPath = freshDbPath();
    seedCloseReady(dbPath);
    const calls: string[] = [];
    const result = await new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-close",
      runners: fakeRunners(calls),
      maxSteps: 10,
      createdBy: "worker",
    });
    expect(result.outcome).toBe("pr_created");
    expect(result.draft).toBe(true);
    expect(result.prUrl).toBe("https://example/pr/1");
    expect(calls).toContain("closeAndPr");
  });

  it("escalates a diverging goal without calling runners", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-div",
        title: "Diverging",
        projectId: "demo",
        maxTotalNewFindings: 0,
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      const cycle = repo.startReviewCycle({ hitchId: "g-div", reviewMode: "initial" });
      repo.completeReviewCycle({ cycleId: cycle.cycleId, findingsNew: 1 });
    } finally {
      close();
    }
    const calls: string[] = [];
    const result = await new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-div",
      runners: fakeRunners(calls),
      maxSteps: 10,
      createdBy: "worker",
    });
    expect(result.outcome).toBe("escalated");
    expect(result.escalateReason).toBe("diverging");
    expect(calls).toEqual([]);
  });

  it("stops with max_steps_exhausted when the loop never reaches a terminal", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-loop",
        title: "Loop",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const result = await new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-loop",
      runners: fakeRunners([]),
      maxSteps: 3,
      createdBy: "worker",
    });
    expect(result.outcome).toBe("max_steps_exhausted");
    expect(result.steps.length).toBe(3);
  });

  it("escalates (and flips the goal status) when a runner throws", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      // a goal that has already had a coding pass (pending command close
      // condition) dispatches to `review`; a review runner that throws must
      // escalate cleanly.
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-throw",
        title: "Throws",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.createAttempt({ hitchId: "g-throw", attemptType: "implement" });
    } finally {
      close();
    }
    const throwingRunners: OrchestratorRunners = {
      coder: async () => ({ runId: "r1", runStatus: "needs_review" }),
      review: async () => {
        throw new Error("review boom");
      },
      classify: async () => ({ resolved: true }),
      defer: async () => ({ deferred: 0 }),
      closeAndPr: async () => ({ prUrl: "https://example/pr/1", draft: true }),
    };
    const result = await new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-throw",
      runners: throwingRunners,
      maxSteps: 10,
      createdBy: "worker",
    });
    expect(result.outcome).toBe("escalated");
    expect(result.escalateReason).toBe("review boom");
    expect(
      result.steps.some(
        (s) => s.action === "escalate" && s.detail === "review boom",
      ),
    ).toBe(true);

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      expect(new HitchRepository(db2).requireSession("g-throw").status).toBe(
        "escalated",
      );
    } finally {
      close2();
    }
  });

  it("dispatches defer for continue/defer_followups", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-defer-loop",
        title: "Defer loop",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.createAttempt({ hitchId: "g-defer-loop", attemptType: "implement" });
      // The implement run was reviewed (the finding below came from that review)
      // — record the cycle so convergence does not route to a pending review
      // (#104) instead of the defer path under test.
      const dc = repo.startReviewCycle({
        hitchId: "g-defer-loop",
        cycleNumber: 1,
        reviewMode: "initial",
      });
      repo.completeReviewCycle({ cycleId: dc.cycleId, findingsNew: 1 });
      const f = repo.upsertFinding({
        hitchId: "g-defer-loop",
        source: "review",
        severity: "P2",
        category: "future",
        summary: "oos",
      }).finding;
      repo.classifyFinding({
        findingId: f.findingId,
        scopeStatus: "out_of_scope",
        reason: "test",
      });
      // Record the close-check LAST so its evidence is fresh relative to the
      // finding mutation (otherwise convergence treats it as stale → pending
      // → run_close_check/review instead of continue/defer_followups).
      repo.recordCloseCheck({
        hitchId: "g-defer-loop",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
    } finally {
      close();
    }
    const calls: string[] = [];
    const result = await new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-defer-loop",
      runners: fakeRunners(calls),
      maxSteps: 3,
      createdBy: "worker",
    });
    expect(calls).toContain("defer");
    expect(result.steps.some((s) => s.action === "defer")).toBe(true);
  });
});
