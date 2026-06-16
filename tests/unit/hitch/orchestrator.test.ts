import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { HitchOrchestrator } from "../../../src/hitch/orchestrator.js";
import type { OrchestratorRunners } from "../../../src/hitch/orchestrator-types.js";
import type { HitchDecisionPacket } from "../../../src/hitch/jury/types.js";
import { RunFinalizedError } from "../../../src/core/workflow-runner.js";
import {
  DomainLockBusyError,
  LeaseGuardFailedError,
} from "../../../src/workspace/db-domain-lock.js";

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
    closeCheck: async () => {
      calls.push("closeCheck");
      return { runId: "r1", checked: 1, passed: 1, failed: 0 };
    },
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

  it("aborts the drive fail-closed (no runner call, propagates the lease cause) when the signal is already aborted (#132)", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      // Fresh session with no attempt → would route to a coder step.
      new HitchRepository(db).createSession({
        hitchId: "g-abort",
        title: "Abort",
        projectId: "demo",
        closeConditions: [],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const calls: string[] = [];
    const controller = new AbortController();
    const leaseLost = new LeaseGuardFailedError("course:abort");
    controller.abort(leaseLost);

    const run = new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-abort",
      runners: fakeRunners(calls),
      maxSteps: 10,
      createdBy: "worker",
      signal: controller.signal,
    });
    // Propagates the abort cause (a transient lease error) — NOT escalate/close.
    await expect(run).rejects.toBe(leaseLost);
    // No step ran: the coder was never invoked.
    expect(calls).toEqual([]);
  });

  it("propagates the abort cause instead of escalating when the signal aborts during a step (#132)", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-abort-mid",
        title: "Abort mid",
        projectId: "demo",
        closeConditions: [],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const controller = new AbortController();
    const leaseLost = new LeaseGuardFailedError("course:abort-mid");
    // The coder step aborts the signal mid-flight, then throws (as a killed
    // codex run would surface). The orchestrator must propagate the abort, not
    // turn it into an `escalated` outcome.
    const runners: OrchestratorRunners = {
      ...fakeRunners([]),
      coder: async () => {
        controller.abort(leaseLost);
        throw new Error("codex killed");
      },
    };
    const run = new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-abort-mid",
      runners,
      maxSteps: 10,
      createdBy: "worker",
      signal: controller.signal,
    });
    await expect(run).rejects.toBe(leaseLost);
    // The hitch must NOT have been flipped to escalated by the abort.
    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      expect(new HitchRepository(db2).requireSession("g-abort-mid").status).not.toBe(
        "escalated",
      );
    } finally {
      close2();
    }
  });

  it("propagates the abort via the loop-top guard when a killed coder returns failed-codex normally (#132 dominant path)", async () => {
    // The real production path on lease loss: codex is SIGKILLed → the coder run
    // finalizes `failed-codex` and the coder runner RETURNS NORMALLY (no throw);
    // the next loop-top guard is what propagates the abort.
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-abort-looptop",
        title: "Abort looptop",
        projectId: "demo",
        closeConditions: [],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const controller = new AbortController();
    const leaseLost = new LeaseGuardFailedError("course:abort-looptop");
    let coderCalls = 0;
    const runners: OrchestratorRunners = {
      ...fakeRunners([]),
      coder: async () => {
        coderCalls += 1;
        // emulate: lease lost mid-codex → codex SIGKILLed → failed-codex,
        // returned normally (NOT thrown).
        controller.abort(leaseLost);
        return { runId: "r-killed", runStatus: "failed-codex" };
      },
    };
    const run = new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-abort-looptop",
      runners,
      maxSteps: 10,
      createdBy: "worker",
      signal: controller.signal,
    });
    await expect(run).rejects.toBe(leaseLost);
    // exactly one coder step ran; the next loop-top guard stopped the drive.
    expect(coderCalls).toBe(1);
    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      expect(new HitchRepository(db2).requireSession("g-abort-looptop").status).not.toBe(
        "escalated",
      );
    } finally {
      close2();
    }
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
      repo.upsertFinding({
        hitchId: "g-div",
        source: "review",
        sourceCycleId: cycle.cycleId,
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary: "harness-origin churn",
      });
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

  it("runs closeCheck instead of re-reviewing when command evidence is pending", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-command-check",
        title: "Command check",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.createAttempt({
        hitchId: "g-command-check",
        attemptType: "implement",
        status: "succeeded",
        runId: "r1",
        createdAt: "2026-05-25T00:00:00.000Z",
      });
      const cycle = repo.startReviewCycle({
        hitchId: "g-command-check",
        reviewMode: "initial",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      repo.completeReviewCycle({ cycleId: cycle.cycleId, completedAt: "2026-05-25T00:01:30.000Z" });
    } finally {
      close();
    }
    const calls: string[] = [];
    const runners: OrchestratorRunners = {
      ...fakeRunners(calls),
      closeCheck: async (hitchId) => {
        calls.push("closeCheck");
        const { db: db2, close: close2 } = openManagedDb({ dbPath });
        try {
          new HitchRepository(db2).recordCloseCheck({
            hitchId,
            conditionId: "typecheck",
            status: "passed",
            checkedBy: "test",
            checkedAt: "2026-05-25T00:02:00.000Z",
          });
        } finally {
          close2();
        }
        return { runId: "r1", checked: 1, passed: 1, failed: 0 };
      },
    };

    const result = await new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-command-check",
      runners,
      maxSteps: 5,
      createdBy: "worker",
    });

    expect(calls).toContain("closeCheck");
    expect(calls).not.toContain("review");
    expect(result.outcome).toBe("pr_created");
  });

  it("waits without escalating when only manual close-check evidence is pending", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-manual-wait",
        title: "Manual wait",
        projectId: "demo",
        closeConditions: [
          { id: "manual-signoff", kind: "manual", required: true },
        ],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.createAttempt({
        hitchId: "g-manual-wait",
        attemptType: "implement",
        status: "succeeded",
        runId: "r1",
        createdAt: "2026-05-25T00:00:00.000Z",
      });
      const cycle = repo.startReviewCycle({
        hitchId: "g-manual-wait",
        reviewMode: "initial",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        completedAt: "2026-05-25T00:01:30.000Z",
      });
    } finally {
      close();
    }
    const calls: string[] = [];

    const result = await new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-manual-wait",
      runners: fakeRunners(calls),
      maxSteps: 3,
      createdBy: "worker",
    });

    expect(result.outcome).toBe("waiting");
    expect(result.steps).toMatchObject([
      { action: "wait", decision: "continue" },
    ]);
    expect(calls).toEqual([]);
    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      expect(new HitchRepository(db2).requireSession("g-manual-wait").status).toBe(
        "open",
      );
    } finally {
      close2();
    }
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
      closeCheck: async () => ({ runId: "r1", checked: 1, passed: 1, failed: 0 }),
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

  it("rethrows transient domain lock conflicts without escalating the hitch", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-lock-busy",
        title: "Lock busy",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.upsertFinding({
        hitchId: "g-lock-busy",
        source: "review",
        severity: "P1",
        category: "bug",
        scopeStatus: "in_scope",
        summary: "fix",
      });
    } finally {
      close();
    }
    const busy = new DomainLockBusyError("demo::apps/web", {
      runId: "holder",
      pid: 123,
      hostname: "host",
      expiresAt: "2026-06-12T00:00:10.000Z",
    });
    const runners: OrchestratorRunners = {
      ...fakeRunners([]),
      coder: async () => {
        throw busy;
      },
    };

    await expect(
      new HitchOrchestrator({ dbPath }).run({
        hitchId: "g-lock-busy",
        runners,
        maxSteps: 10,
        createdBy: "worker",
      }),
    ).rejects.toBe(busy);

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      expect(new HitchRepository(db2).requireSession("g-lock-busy").status).toBe(
        "open",
      );
    } finally {
      close2();
    }
  });

  it("unwraps nested transient lease causes without escalating the hitch", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-nested-lease",
        title: "Nested lease",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.upsertFinding({
        hitchId: "g-nested-lease",
        source: "review",
        severity: "P1",
        category: "bug",
        scopeStatus: "in_scope",
        summary: "fix",
      });
    } finally {
      close();
    }
    const leaseLost = new LeaseGuardFailedError("run-stale");
    const wrapped = new RunFinalizedError(
      "run-stale",
      "failed-internal-error",
      new Error("middle", { cause: leaseLost }),
    );
    const runners: OrchestratorRunners = {
      ...fakeRunners([]),
      coder: async () => {
        throw wrapped;
      },
    };

    await expect(
      new HitchOrchestrator({ dbPath }).run({
        hitchId: "g-nested-lease",
        runners,
        maxSteps: 10,
        createdBy: "worker",
      }),
    ).rejects.toBe(leaseLost);

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      expect(new HitchRepository(db2).requireSession("g-nested-lease").status).toBe(
        "open",
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
      // → run_close_check/close_check instead of continue/defer_followups).
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

  it("persists the decision packet before a classify escalate (WI-9b #230)", async () => {
    const dbPath = freshDbPath();
    let findingId = "";
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-classify-escalate",
        title: "Classify escalate",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.createAttempt({
        hitchId: "g-classify-escalate",
        attemptType: "implement",
      });
      // The implement run was reviewed — record the cycle so convergence routes
      // to needs_classification (the unknown-scope finding below) rather than a
      // pending review (#104).
      const cycle = repo.startReviewCycle({
        hitchId: "g-classify-escalate",
        cycleNumber: 1,
        reviewMode: "initial",
      });
      repo.completeReviewCycle({ cycleId: cycle.cycleId, findingsNew: 1 });
      // An OPEN, unknown-scope finding → convergence returns needs_classification
      // → orchestrator dispatches the classify action.
      findingId = repo.upsertFinding({
        hitchId: "g-classify-escalate",
        source: "review",
        sourceCycleId: cycle.cycleId,
        severity: "P2",
        category: "correctness",
        scopeStatus: "unknown",
        summary: "unknown-scope finding",
      }).finding.findingId;
      // Fresh close-check LAST so its evidence is not stale relative to the
      // finding mutation.
      repo.recordCloseCheck({
        hitchId: "g-classify-escalate",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
    } finally {
      close();
    }

    // A consultant-grade escalate packet carried on the runner's
    // recommendedNextAction; the orchestrator must persist it BEFORE returning.
    const decisionPacket: HitchDecisionPacket = {
      packetVersion: 2,
      decisionKinds: ["classify_scope"],
      findings: [
        {
          findingId,
          summary: "unknown-scope finding",
          deliberationId: "delib-classify-escalate",
          origin: "harness",
        },
      ],
      recommendation: {
        action: "classify_manually",
        rationale: "jury split — operator must classify",
      },
      evaluationAxes: [],
      deliberation: {
        critiqueRan: false,
        refuter: null,
        gateTrace: {
          scopeUnanimous: false,
          lensDistinct: true,
          noInconclusive: true,
          allHaveVerifiedEvidence: true,
          proximityOk: true,
          refuterUpheld: null,
        },
      },
      rejectedProposals: [],
      minorityView: null,
      riskFlags: [],
      unvalidatedAssumptions: [],
      nextActions: [
        {
          owner: "operator",
          action: "classify the unknown-scope finding",
          verificationMethod: "review jury reasoning in the packet",
        },
      ],
    };
    const runners: OrchestratorRunners = {
      ...fakeRunners([]),
      classify: async () => ({
        resolved: false,
        decision: "escalate",
        escalateReason: "jury split — manual classification required",
        recommendedNextAction: {
          kind: "classify_findings",
          findingIds: [findingId],
          message: "Classify the unknown-scope finding manually.",
          decisionPacket,
        },
      }),
    };

    const result = await new HitchOrchestrator({ dbPath }).run({
      hitchId: "g-classify-escalate",
      runners,
      maxSteps: 5,
      createdBy: "worker",
    });

    expect(result.outcome).toBe("escalated");
    expect(result.escalateReason).toBe(
      "jury split — manual classification required",
    );

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db2);
      // Status synced to escalated (recordConvergenceDecisionWithStatus default
      // updateStatus:true).
      expect(repo.requireSession("g-classify-escalate").status).toBe(
        "escalated",
      );
      // The escalate decision row was persisted and its recommended_next_action
      // JSON round-trips to include the full decisionPacket.
      const escalateRows = repo
        .listDecisions("g-classify-escalate")
        .filter((d) => d.decision === "escalate");
      expect(escalateRows.length).toBeGreaterThanOrEqual(1);
      const persisted = escalateRows[escalateRows.length - 1];
      const action = persisted.recommendedNextAction;
      expect(action).not.toBeNull();
      // kind/message/findingIds populated for back-compat.
      expect(action?.kind).toBe("classify_findings");
      expect(action?.message).toBe(
        "Classify the unknown-scope finding manually.",
      );
      expect(action?.findingIds).toEqual([findingId]);
      // Packet round-trips through the JSON column.
      expect(action?.decisionPacket).toEqual(decisionPacket);
    } finally {
      close2();
    }
  });
});
