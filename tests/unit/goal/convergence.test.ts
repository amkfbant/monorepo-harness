import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/goal/convergence.js";
import { GoalRepository } from "../../../src/goal/repository.js";
import { DEFAULT_GOAL_POLICY, type GoalPolicy } from "../../../src/goal/types.js";

function fresh(): {
  db: ReturnType<typeof openDb>;
  repo: GoalRepository;
  service: ConvergenceService;
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-conv-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  const repo = new GoalRepository(db);
  return { db, repo, service: new ConvergenceService(repo) };
}

function createGoal(
  repo: GoalRepository,
  overrides: {
    goalId?: string;
    maxIterations?: number;
    maxReviewCycles?: number;
    maxReruns?: number;
    maxTotalNewFindings?: number;
    policy?: GoalPolicy;
    closeConditions?: Parameters<GoalRepository["createSession"]>[0]["closeConditions"];
  } = {},
) {
  return repo.createSession({
    goalId: overrides.goalId ?? "goal-test",
    title: "Goal",
    closeConditions:
      overrides.closeConditions ?? [
        { id: "typecheck", kind: "command", required: true },
      ],
    policy: overrides.policy ?? DEFAULT_GOAL_POLICY,
    maxIterations: overrides.maxIterations,
    maxReviewCycles: overrides.maxReviewCycles,
    maxReruns: overrides.maxReruns,
    maxTotalNewFindings: overrides.maxTotalNewFindings,
    createdBy: "test",
    createdSource: "cli",
  });
}

function passClose(repo: GoalRepository, goalId = "goal-test") {
  repo.recordCloseCheck({
    goalId,
    conditionId: "typecheck",
    status: "passed",
    checkedBy: "test",
  });
}

function addFinding(
  repo: GoalRepository,
  overrides: Partial<Parameters<GoalRepository["upsertFinding"]>[0]>,
) {
  return repo.upsertFinding({
    goalId: "goal-test",
    source: "review",
    severity: "P1",
    category: "correctness",
    summary: `finding-${Math.random()}`,
    ...overrides,
  }).finding;
}

function addCycle(repo: GoalRepository, cycleNumber: number, findingsNew: number) {
  const cycle = repo.startReviewCycle({
    goalId: "goal-test",
    cycleNumber,
    reviewMode: cycleNumber === 1 ? "initial" : "delta",
  });
  repo.completeReviewCycle({ cycleId: cycle.cycleId, findingsNew });
}

describe("ConvergenceService", () => {
  it("returns close_ready when checks pass and no blockers remain", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      expect(service.evaluate("goal-test").decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("returns needs_fix for open in-scope P1", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("needs_fix");
      expect(result.recommendedNextAction.kind).toBe("fix_findings");
    } finally {
      db.close();
    }
  });

  it("returns escalate for open in-scope P0", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      addFinding(repo, { scopeStatus: "in_scope", severity: "P0" });
      expect(service.evaluate("goal-test").decision).toBe("escalate");
    } finally {
      db.close();
    }
  });

  it("escalates in-scope P0 before unknown-scope classification", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      addFinding(repo, { scopeStatus: "unknown", severity: "P2" });
      addFinding(repo, { scopeStatus: "in_scope", severity: "P0" });
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("escalate");
      expect(result.recommendedNextAction.findingIds).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("returns needs_classification for unknown scope when policy stops on unknown", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      addFinding(repo, { scopeStatus: "unknown", severity: "P2" });
      expect(service.evaluate("goal-test").decision).toBe(
        "needs_classification",
      );
    } finally {
      db.close();
    }
  });

  it("allows close_ready with unknown scope when policy permits it", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, {
        policy: {
          ...DEFAULT_GOAL_POLICY,
          stopOnUnknownScope: false,
          closeRequires: {
            ...DEFAULT_GOAL_POLICY.closeRequires,
            noUnknownScope: false,
          },
        },
      });
      passClose(repo);
      addFinding(repo, { scopeStatus: "unknown", severity: "P2" });
      expect(service.evaluate("goal-test").decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("returns budget_exhausted when iterations exceed the goal budget", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxIterations: 1 });
      repo.createAttempt({ goalId: "goal-test", attemptType: "implement" });
      repo.createAttempt({ goalId: "goal-test", attemptType: "validate" });
      expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
    } finally {
      db.close();
    }
  });

  it("returns budget_exhausted instead of recommending fixes at the iteration limit", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxIterations: 1 });
      passClose(repo);
      repo.createAttempt({ goalId: "goal-test", attemptType: "implement" });
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });
      expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
    } finally {
      db.close();
    }
  });

  it("does not count multiple attempts in the same iteration as extra iterations", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxIterations: 1 });
      passClose(repo);
      repo.createAttempt({
        goalId: "goal-test",
        iteration: 1,
        attemptType: "implement",
      });
      repo.createAttempt({
        goalId: "goal-test",
        iteration: 1,
        attemptType: "validate",
      });
      expect(service.evaluate("goal-test").decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("returns budget_exhausted instead of recommending reruns at the rerun limit", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReruns: 1 });
      passClose(repo);
      repo.createAttempt({
        goalId: "goal-test",
        iteration: 1,
        attemptType: "rerun",
      });
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });
      expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
    } finally {
      db.close();
    }
  });

  it("returns budget_exhausted when reruns exceed the goal budget", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReruns: 0 });
      passClose(repo);
      repo.createAttempt({
        goalId: "goal-test",
        iteration: 1,
        attemptType: "rerun",
      });
      expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
    } finally {
      db.close();
    }
  });

  it("returns budget_exhausted instead of recommending work at the review-cycle limit", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReviewCycles: 1 });
      passClose(repo);
      addCycle(repo, 1, 0);
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });
      expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
    } finally {
      db.close();
    }
  });

  it("returns budget_exhausted when review cycles exceed the goal budget", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReviewCycles: 1 });
      addCycle(repo, 1, 0);
      addCycle(repo, 2, 0);
      expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
    } finally {
      db.close();
    }
  });

  it("returns diverging when total new findings exceed budget", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxTotalNewFindings: 2 });
      passClose(repo);
      addCycle(repo, 1, 3);
      expect(service.evaluate("goal-test").decision).toBe("diverging");
    } finally {
      db.close();
    }
  });

  it("returns diverging when new findings do not decrease", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      addCycle(repo, 1, 2);
      addCycle(repo, 2, 2);
      expect(service.evaluate("goal-test").decision).toBe("diverging");
    } finally {
      db.close();
    }
  });

  it("returns diverging before recommending another P1 fix pass", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });
      addCycle(repo, 1, 2);
      addCycle(repo, 2, 2);
      expect(service.evaluate("goal-test").decision).toBe("diverging");
    } finally {
      db.close();
    }
  });

  it("requires defer_followups when out-of-scope findings remain", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      const finding = addFinding(repo, { scopeStatus: "out_of_scope", severity: "P1" });
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.reason).toBe("out-of-scope findings require deferral");
      expect(result.recommendedNextAction).toMatchObject({
        kind: "defer_followups",
        findingIds: [finding.findingId],
      });
    } finally {
      db.close();
    }
  });

  it("allows close_ready with out-of-scope findings when deferral is not required", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, {
        policy: {
          ...DEFAULT_GOAL_POLICY,
          deferOutOfScope: false,
        },
      });
      passClose(repo);
      addFinding(repo, { scopeStatus: "out_of_scope", severity: "P1" });
      expect(service.evaluate("goal-test").decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("blocks close_ready when policy requires no open in-scope P2", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, {
        policy: {
          ...DEFAULT_GOAL_POLICY,
          closeRequires: {
            ...DEFAULT_GOAL_POLICY.closeRequires,
            maxOpenInScopeP2: 0,
          },
        },
      });
      passClose(repo);
      addFinding(repo, { scopeStatus: "in_scope", severity: "P2" });
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("needs_fix");
      expect(result.recommendedNextAction.kind).toBe("fix_findings");
    } finally {
      db.close();
    }
  });

  it("returns needs_fix for failed close checks", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      repo.recordCloseCheck({
        goalId: "goal-test",
        conditionId: "typecheck",
        status: "failed",
        checkedBy: "test",
      });
      expect(service.evaluate("goal-test").decision).toBe("needs_fix");
    } finally {
      db.close();
    }
  });

  it("returns diverging when a finding reopens too many times", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      const finding = addFinding(repo, {
        scopeStatus: "out_of_scope",
        severity: "P2",
        summary: "flaky",
      });
      for (let i = 0; i < 3; i += 1) {
        repo.markFindingFixed({ findingId: finding.findingId });
        repo.upsertFinding({
          goalId: "goal-test",
          source: "review",
          severity: "P2",
          category: "correctness",
          scopeStatus: "out_of_scope",
          summary: "flaky",
        });
      }
      expect(service.evaluate("goal-test").decision).toBe("diverging");
    } finally {
      db.close();
    }
  });
});
