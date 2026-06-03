import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/goal/convergence.js";
import { GoalRepository } from "../../../src/goal/repository.js";
import type {
  GoalAttemptType,
  GoalConvergenceDecision,
  GoalConvergenceResult,
  GoalFinding,
  GoalFindingSeverity,
  GoalReviewMode,
  GoalStatus,
} from "../../../src/goal/types.js";

type HarnessDb = ReturnType<typeof openDb>;

interface FixtureContext {
  db: HarnessDb;
  repo: GoalRepository;
  service: ConvergenceService;
  goalId: string;
}

class SimulatedGoalLoop {
  readonly decisions: GoalConvergenceResult[] = [];
  readonly statusHistory: GoalStatus[] = [];

  constructor(private readonly ctx: FixtureContext) {}

  evaluate(): GoalConvergenceResult {
    const result = this.ctx.service.evaluate(this.ctx.goalId);
    this.ctx.repo.recordConvergenceDecision({
      goalId: this.ctx.goalId,
      decision: result.decision,
      reason: result.reason,
      metrics: { ...result.metrics },
      recommendedNextAction: result.recommendedNextAction,
      createdBy: "fixture-loop",
    });
    const status = statusForDecision(result.decision);
    if (status !== null) {
      this.ctx.repo.updateStatus(
        this.ctx.goalId,
        status,
        `fixture decision: ${result.decision}`,
      );
    }
    this.decisions.push(result);
    this.statusHistory.push(this.ctx.repo.requireSession(this.ctx.goalId).status);
    return result;
  }

  runUntilStop(input: {
    maxTurns?: number;
    shouldStop?: (result: GoalConvergenceResult) => boolean;
    advance: (result: GoalConvergenceResult) => void;
  }): GoalConvergenceResult[] {
    const maxTurns = input.maxTurns ?? 8;
    const shouldStop = input.shouldStop ?? defaultStop;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const result = this.evaluate();
      if (shouldStop(result)) return this.decisions;
      input.advance(result);
    }
    throw new Error(`simulated goal loop did not stop after ${maxTurns} turns`);
  }
}

function fresh(goalId: string, overrides: {
  maxIterations?: number;
  maxReviewCycles?: number;
  maxReruns?: number;
  maxTotalNewFindings?: number;
} = {}): FixtureContext {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-fixture-matrix-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  const repo = new GoalRepository(db);
  repo.createSession({
    goalId,
    title: `Fixture ${goalId}`,
    projectId: "monorepo-harness",
    domain: "goal",
    scope: {
      targetFiles: ["src/goal/**", "src/mcp/**"],
      allowedFindingCategories: [
        "correctness",
        "follow-up",
        "classification",
        "budget",
      ],
    },
    closeConditions: [
      {
        id: "typecheck",
        kind: "command",
        required: true,
        description: "typecheck passes",
      },
    ],
    maxIterations: overrides.maxIterations,
    maxReviewCycles: overrides.maxReviewCycles,
    maxReruns: overrides.maxReruns,
    maxTotalNewFindings: overrides.maxTotalNewFindings,
    createdBy: "fixture",
    createdSource: "cli",
  });
  return {
    db,
    repo,
    service: new ConvergenceService(repo),
    goalId,
  };
}

function statusForDecision(decision: GoalConvergenceDecision): GoalStatus | null {
  if (decision === "close_ready") return "close_ready";
  if (decision === "diverging") return "diverging";
  if (decision === "budget_exhausted") return "budget_exhausted";
  if (decision === "escalate") return "escalated";
  if (
    decision === "continue" ||
    decision === "needs_fix" ||
    decision === "needs_classification"
  ) {
    return "in_progress";
  }
  return null;
}

function defaultStop(result: GoalConvergenceResult): boolean {
  return (
    result.decision === "close_ready" ||
    result.decision === "diverging" ||
    result.decision === "budget_exhausted" ||
    result.decision === "escalate" ||
    result.decision === "closed" ||
    result.decision === "cancel"
  );
}

function completeAttempt(
  ctx: FixtureContext,
  attemptType: GoalAttemptType,
  iteration?: number,
) {
  const attempt = ctx.repo.createAttempt({
    goalId: ctx.goalId,
    attemptType,
    ...(iteration !== undefined ? { iteration } : {}),
    input: { simulated: true },
  });
  return ctx.repo.completeAttempt({
    attemptId: attempt.attemptId,
    status: "succeeded",
    result: { simulated: true },
  });
}

function startCycle(ctx: FixtureContext, reviewMode?: GoalReviewMode) {
  const nextCycle = ctx.repo.listReviewCycles(ctx.goalId).length + 1;
  return ctx.repo.startReviewCycle({
    goalId: ctx.goalId,
    cycleNumber: nextCycle,
    reviewMode: reviewMode ?? (nextCycle === 1 ? "initial" : "delta"),
  });
}

function completeCycle(
  ctx: FixtureContext,
  cycleId: string,
  counts: {
    findingsSeen?: number;
    findingsNew?: number;
    findingsFixed?: number;
    findingsDeferred?: number;
    findingsInScopeOpen?: number;
  },
) {
  return ctx.repo.completeReviewCycle({
    cycleId,
    findingsSeen: counts.findingsSeen ?? counts.findingsNew ?? 0,
    findingsNew: counts.findingsNew ?? 0,
    findingsFixed: counts.findingsFixed ?? 0,
    findingsDeferred: counts.findingsDeferred ?? 0,
    findingsInScopeOpen: counts.findingsInScopeOpen ?? 0,
  });
}

function addFinding(
  ctx: FixtureContext,
  input: {
    summary: string;
    severity?: GoalFindingSeverity;
    category?: string;
    scopeStatus?: "in_scope" | "out_of_scope" | "unknown";
    cycleId?: string;
  },
): GoalFinding {
  return ctx.repo.upsertFinding({
    goalId: ctx.goalId,
    source: "review",
    sourceCycleId: input.cycleId,
    severity: input.severity ?? "P1",
    category: input.category ?? "correctness",
    scopeStatus: input.scopeStatus ?? "in_scope",
    summary: input.summary,
  }).finding;
}

function passCloseCheck(ctx: FixtureContext) {
  ctx.repo.recordCloseCheck({
    goalId: ctx.goalId,
    conditionId: "typecheck",
    status: "passed",
    checkedBy: "fixture",
    evidence: { command: "npm run typecheck" },
  });
}

function decisionNames(loop: SimulatedGoalLoop): GoalConvergenceDecision[] {
  return loop.decisions.map((d) => d.decision);
}

describe("goal convergence fixture matrix", () => {
  it("converges after a simulated fix and close-check pass", () => {
    const ctx = fresh("goal-fixture-converging");
    try {
      const initialAttempt = completeAttempt(ctx, "implement");
      expect(initialAttempt.iteration).toBe(1);

      const loop = new SimulatedGoalLoop(ctx);
      let blocker: GoalFinding | null = null;

      loop.runUntilStop({
        advance: (result) => {
          if (result.decision === "continue") {
            const cycle = startCycle(ctx, "initial");
            blocker = addFinding(ctx, {
              summary: "operation metadata is not linked to the goal",
              cycleId: cycle.cycleId,
            });
            completeCycle(ctx, cycle.cycleId, {
              findingsSeen: 1,
              findingsNew: 1,
              findingsInScopeOpen: 1,
            });
            return;
          }
          if (result.decision === "needs_fix" && blocker !== null) {
            completeAttempt(ctx, "fix-review");
            ctx.repo.markFindingFixed({
              findingId: blocker.findingId,
              note: "linked operation metadata to goal attempts",
            });
            passCloseCheck(ctx);
            const cycle = startCycle(ctx, "close");
            completeCycle(ctx, cycle.cycleId, {
              findingsSeen: 1,
              findingsNew: 0,
              findingsFixed: 1,
            });
            passCloseCheck(ctx);
          }
        },
      });

      expect(decisionNames(loop)).toEqual([
        "continue",
        "needs_fix",
        "close_ready",
      ]);
      expect(loop.statusHistory).toEqual([
        "in_progress",
        "in_progress",
        "close_ready",
      ]);
      expect(ctx.repo.listAttempts(ctx.goalId)).toHaveLength(2);
      expect(ctx.repo.listDecisions(ctx.goalId)).toHaveLength(3);
    } finally {
      ctx.db.close();
    }
  });

  it("stops a simulated loop when review findings diverge", () => {
    const ctx = fresh("goal-fixture-diverging");
    try {
      passCloseCheck(ctx);
      completeAttempt(ctx, "implement");
      const firstCycle = startCycle(ctx, "initial");
      const blocker = addFinding(ctx, {
        summary: "first review blocker",
        cycleId: firstCycle.cycleId,
      });
      completeCycle(ctx, firstCycle.cycleId, {
        findingsSeen: 2,
        findingsNew: 2,
        findingsInScopeOpen: 1,
      });

      const loop = new SimulatedGoalLoop(ctx);
      loop.runUntilStop({
        maxTurns: 4,
        advance: (result) => {
          if (result.decision !== "needs_fix") return;
          completeAttempt(ctx, "fix-review");
          ctx.repo.markFindingFixed({ findingId: blocker.findingId });
          const secondCycle = startCycle(ctx, "delta");
          addFinding(ctx, {
            summary: "second review blocker",
            cycleId: secondCycle.cycleId,
          });
          completeCycle(ctx, secondCycle.cycleId, {
            findingsSeen: 2,
            findingsNew: 2,
            findingsFixed: 1,
            findingsInScopeOpen: 1,
          });
        },
      });

      expect(decisionNames(loop)).toEqual(["needs_fix", "diverging"]);
      expect(loop.statusHistory).toEqual(["in_progress", "diverging"]);
      expect(ctx.repo.requireSession(ctx.goalId).status).toBe("diverging");
    } finally {
      ctx.db.close();
    }
  });

  it("defers out-of-scope findings before stopping close-ready", () => {
    const ctx = fresh("goal-fixture-defer");
    try {
      const cycle = startCycle(ctx, "initial");
      const followUp = addFinding(ctx, {
        summary: "add dashboard chart follow-up",
        severity: "P2",
        category: "follow-up",
        scopeStatus: "out_of_scope",
        cycleId: cycle.cycleId,
      });
      completeCycle(ctx, cycle.cycleId, {
        findingsSeen: 1,
        findingsNew: 1,
      });
      passCloseCheck(ctx);

      const loop = new SimulatedGoalLoop(ctx);
      loop.runUntilStop({
        maxTurns: 4,
        shouldStop: (result) =>
          result.decision === "close_ready" && result.metrics.openOutOfScope === 0,
        advance: (result) => {
          if (
            result.recommendedNextAction.kind === "defer_followups" &&
            result.metrics.openOutOfScope > 0
          ) {
            ctx.repo.deferFinding({
              findingId: followUp.findingId,
              backlogItemId: "backlog-goal-fixture-defer",
              note: "deferred by fixture loop",
            });
            passCloseCheck(ctx);
          }
        },
      });

      expect(decisionNames(loop)).toEqual(["continue", "close_ready"]);
      expect(loop.decisions.map((d) => d.metrics.openOutOfScope)).toEqual([1, 0]);
      expect(ctx.repo.requireFinding(followUp.findingId)).toMatchObject({
        lifecycleStatus: "deferred",
        deferredBacklogItemId: "backlog-goal-fixture-defer",
      });
    } finally {
      ctx.db.close();
    }
  });

  it("pauses on unknown scope until classification resolves the loop", () => {
    const ctx = fresh("goal-fixture-unknown");
    try {
      passCloseCheck(ctx);
      const unknown = addFinding(ctx, {
        summary: "review finding lacks enough scope context",
        severity: "P2",
        category: "classification",
        scopeStatus: "unknown",
      });

      const loop = new SimulatedGoalLoop(ctx);
      loop.runUntilStop({
        maxTurns: 4,
        advance: (result) => {
          if (result.decision !== "needs_classification") return;
          ctx.repo.classifyFinding({
            findingId: unknown.findingId,
            scopeStatus: "in_scope",
            reason: "manual fixture classification",
          });
          passCloseCheck(ctx);
        },
      });

      expect(decisionNames(loop)).toEqual([
        "needs_classification",
        "close_ready",
      ]);
      expect(loop.decisions[0].recommendedNextAction.kind).toBe(
        "classify_findings",
      );
      expect(ctx.repo.requireFinding(unknown.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
      });
      expect(ctx.repo.listAttempts(ctx.goalId)).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  it("stops immediately when the iteration budget is exhausted", () => {
    const ctx = fresh("goal-fixture-budget", { maxIterations: 1 });
    try {
      passCloseCheck(ctx);
      completeAttempt(ctx, "implement");
      completeAttempt(ctx, "validate");
      const loop = new SimulatedGoalLoop(ctx);

      loop.runUntilStop({
        maxTurns: 2,
        advance: () => {
          throw new Error("budget-exhausted fixture should not advance");
        },
      });

      expect(decisionNames(loop)).toEqual(["budget_exhausted"]);
      expect(loop.statusHistory).toEqual(["budget_exhausted"]);
      expect(ctx.repo.requireSession(ctx.goalId).status).toBe(
        "budget_exhausted",
      );
      expect(ctx.repo.listAttempts(ctx.goalId).map((a) => a.iteration)).toEqual([
        1,
        2,
      ]);
    } finally {
      ctx.db.close();
    }
  });
});
