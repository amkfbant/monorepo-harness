import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { evaluateConvergenceAndRecordStatus } from "../../../src/hitch/convergence-status.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import {
  DEFAULT_HITCH_POLICY,
  type HitchFindingSource,
  type HitchPolicy,
  type HitchReviewCycle,
} from "../../../src/hitch/types.js";

function fresh(): {
  db: ReturnType<typeof openDb>;
  repo: HitchRepository;
  service: ConvergenceService;
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-conv-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  const repo = new HitchRepository(db);
  return { db, repo, service: new ConvergenceService(repo) };
}

function createGoal(
  repo: HitchRepository,
  overrides: {
    hitchId?: string;
    maxIterations?: number;
    maxReviewCycles?: number;
    maxReruns?: number;
    maxTotalNewFindings?: number;
    policy?: HitchPolicy;
    closeConditions?: Parameters<HitchRepository["createSession"]>[0]["closeConditions"];
  } = {},
) {
  return repo.createSession({
    hitchId: overrides.hitchId ?? "goal-test",
    title: "Goal",
    closeConditions:
      overrides.closeConditions ?? [
        { id: "typecheck", kind: "command", required: true },
      ],
    policy: overrides.policy ?? DEFAULT_HITCH_POLICY,
    maxIterations: overrides.maxIterations,
    maxReviewCycles: overrides.maxReviewCycles,
    maxReruns: overrides.maxReruns,
    maxTotalNewFindings: overrides.maxTotalNewFindings,
    createdBy: "test",
    createdSource: "cli",
  });
}

function passClose(
  repo: HitchRepository,
  hitchId = "goal-test",
  checkedAt?: string,
) {
  repo.recordCloseCheck({
    hitchId,
    conditionId: "typecheck",
    status: "passed",
    checkedBy: "test",
    ...(checkedAt !== undefined ? { checkedAt } : {}),
  });
}

function addFinding(
  repo: HitchRepository,
  overrides: Partial<Parameters<HitchRepository["upsertFinding"]>[0]>,
) {
  return repo.upsertFinding({
    hitchId: "goal-test",
    source: "review",
    severity: "P1",
    category: "correctness",
    summary: `finding-${Math.random()}`,
    ...overrides,
  }).finding;
}

function addCycle(
  repo: HitchRepository,
  cycleNumber: number,
  findingsNew: number,
): HitchReviewCycle {
  const cycle = repo.startReviewCycle({
    hitchId: "goal-test",
    cycleNumber,
    reviewMode: cycleNumber === 1 ? "initial" : "delta",
  });
  return repo.completeReviewCycle({ cycleId: cycle.cycleId, findingsNew });
}

function addCycleFindings(
  repo: HitchRepository,
  cycleNumber: number,
  sources: HitchFindingSource[],
  overrides: Partial<Parameters<typeof addFinding>[1]> = {},
): HitchReviewCycle {
  const cycle = addCycle(repo, cycleNumber, sources.length);
  sources.forEach((source, index) => {
    addFinding(repo, {
      source,
      sourceCycleId: cycle.cycleId,
      scopeStatus: "out_of_scope",
      severity: "P2",
      summary: `cycle-${cycleNumber}-${source}-${index}`,
      ...overrides,
    });
  });
  return cycle;
}

function insertFixedFindings(
  db: ReturnType<typeof openDb>,
  input: {
    hitchId: string;
    count: number;
    prefix: string;
    firstSeenAt: string;
    lastSeenAt: string;
    fixedAt: string;
    source?: HitchFindingSource;
  },
) {
  const insert = db.prepare(
    `INSERT INTO hitch_findings (
       finding_id, hitch_id, stable_key, source, severity, category,
       scope_status, lifecycle_status, summary, first_seen_at, last_seen_at,
       fixed_at, reopen_count
     )
     VALUES (?, ?, ?, ?, 'P2', 'correctness', 'in_scope', 'fixed',
       ?, ?, ?, ?, 0)`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < input.count; i += 1) {
      const id = `${input.prefix}-${i}`;
      insert.run(
        id,
        input.hitchId,
        id,
        input.source ?? "review",
        `${input.prefix} finding ${i}`,
        input.firstSeenAt,
        input.lastSeenAt,
        input.fixedAt,
      );
    }
  });
  tx();
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

  it("a fresh goal with no coding attempts needs its first run", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("needs_fix");
      expect(result.recommendedNextAction.kind).toBe("fix_findings");
      expect(result.reason).toBe("no implementation attempt yet");
    } finally {
      db.close();
    }
  });

  it("does not close_ready goals with no close conditions by default", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { closeConditions: [] });
      repo.createAttempt({ hitchId: "goal-test", attemptType: "implement" });
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.metrics.closeConditionsPending).toBe(1);
      expect(result.recommendedNextAction.kind).toBe("run_review");
    } finally {
      db.close();
    }
  });

  it("allows empty close conditions only when policy explicitly permits it", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, {
        closeConditions: [],
        policy: {
          ...DEFAULT_HITCH_POLICY,
          allowEmptyCloseConditions: true,
        },
      });
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

  it("treats escalated in-scope findings as active blockers", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo);
      const finding = addFinding(repo, {
        scopeStatus: "in_scope",
        severity: "P1",
        lifecycleStatus: "escalated",
      });
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("needs_fix");
      expect(result.metrics.openInScopeP1).toBe(1);
      expect(result.recommendedNextAction).toMatchObject({
        kind: "fix_findings",
        findingIds: [finding.findingId],
      });
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
          ...DEFAULT_HITCH_POLICY,
          stopOnUnknownScope: false,
          closeRequires: {
            ...DEFAULT_HITCH_POLICY.closeRequires,
            noUnknownScope: false,
          },
        },
      });
      addFinding(repo, { scopeStatus: "unknown", severity: "P2" });
      passClose(repo);
      expect(service.evaluate("goal-test").decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("returns budget_exhausted when iterations exceed the goal budget", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxIterations: 1 });
      repo.createAttempt({ hitchId: "goal-test", attemptType: "implement" });
      repo.createAttempt({ hitchId: "goal-test", attemptType: "validate" });
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
      repo.createAttempt({ hitchId: "goal-test", attemptType: "implement" });
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
        hitchId: "goal-test",
        iteration: 1,
        attemptType: "implement",
      });
      repo.createAttempt({
        hitchId: "goal-test",
        iteration: 1,
        attemptType: "validate",
      });
      passClose(repo);
      expect(service.evaluate("goal-test").decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("reviews a pending coder run before another rerun instead of looping (#104)", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReviewCycles: 5, maxReruns: 4 });
      passClose(repo);
      // implement → review#1 (found the P1) → rerun. The rerun is UNREVIEWED.
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        createdAt: "2026-05-25T00:00:00.000Z",
      });
      const c = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      repo.completeReviewCycle({ cycleId: c.cycleId, findingsNew: 1 });
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        createdAt: "2026-05-25T00:02:00.000Z",
      });

      // The rerun (00:02) is newer than the latest review cycle (00:01): rather
      // than needs_fix → another coder rerun (which never reviews the fix and
      // burns the rerun budget), convergence reviews the pending run.
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.recommendedNextAction.kind).toBe("run_review");
      expect(result.reason).toMatch(/review the latest coder run/);
    } finally {
      db.close();
    }
  });

  it("treats close-check evidence before a later completed attempt as stale", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      passClose(repo, "goal-test", "2026-05-25T00:00:00.000Z");
      const attempt = repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        createdAt: "2026-05-25T00:01:00.000Z",
        startedAt: "2026-05-25T00:01:00.000Z",
      });
      repo.completeAttempt({
        attemptId: attempt.attemptId,
        status: "succeeded",
        completedAt: "2026-05-25T00:02:00.000Z",
      });
      // The attempt was reviewed (a later cycle) so convergence does not route
      // to a pending review (#104); the close-check is still stale vs the
      // attempt, so the decision is the "more validation required" fallthrough.
      addCycle(repo, 1, 0);

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.metrics.closeConditionsPending).toBe(1);
      expect(result.reason).toBe("more validation required");
    } finally {
      db.close();
    }
  });

  it("treats close-check evidence before a later finding fix as stale", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        createdAt: "2026-05-24T00:00:00.000Z",
        startedAt: "2026-05-24T00:00:00.000Z",
      });
      const finding = addFinding(repo, {
        scopeStatus: "in_scope",
        severity: "P1",
        seenAt: "2026-05-25T00:00:00.000Z",
      });
      passClose(repo, "goal-test", "2026-05-25T00:01:00.000Z");
      repo.markFindingFixed({
        findingId: finding.findingId,
        fixedAt: "2026-05-25T00:02:00.000Z",
      });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.metrics.closeConditionsPending).toBe(1);
    } finally {
      db.close();
    }
  });

  it("returns close_ready when close-check evidence is fresher than the fix", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      const finding = addFinding(repo, {
        scopeStatus: "in_scope",
        severity: "P1",
        seenAt: "2026-05-25T00:00:00.000Z",
      });
      repo.markFindingFixed({
        findingId: finding.findingId,
        fixedAt: "2026-05-25T00:01:00.000Z",
      });
      passClose(repo, "goal-test", "2026-05-25T00:02:00.000Z");

      expect(service.evaluate("goal-test").decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("treats close-check evidence as stale after a fixed finding beyond 10k rows", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      const attempt = repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        createdAt: "2026-05-25T00:00:00.000Z",
        startedAt: "2026-05-25T00:00:00.000Z",
      });
      repo.completeAttempt({
        attemptId: attempt.attemptId,
        status: "succeeded",
        completedAt: "2026-05-25T00:00:10.000Z",
      });
      const cycle = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-05-25T00:00:20.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        findingsNew: 0,
        completedAt: "2026-05-25T00:00:30.000Z",
      });
      insertFixedFindings(db, {
        hitchId: "goal-test",
        count: 10_000,
        prefix: "older-fixed",
        firstSeenAt: "2026-05-24T00:00:00.000Z",
        lastSeenAt: "2026-05-24T00:00:00.000Z",
        fixedAt: "2026-05-24T00:00:10.000Z",
        source: "human",
      });
      passClose(repo, "goal-test", "2026-05-25T00:01:00.000Z");
      insertFixedFindings(db, {
        hitchId: "goal-test",
        count: 1,
        prefix: "late-fixed",
        firstSeenAt: "2026-05-25T00:02:00.000Z",
        lastSeenAt: "2026-05-25T00:02:00.000Z",
        fixedAt: "2026-05-25T00:03:00.000Z",
        source: "human",
      });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.metrics.closeConditionsPending).toBe(1);
      expect(result.reason).toBe("more validation required");
    } finally {
      db.close();
    }
  });

  it.each([
    ["P0", "escalate", "openInScopeP0"],
    ["P1", "needs_fix", "openInScopeP1"],
  ] as const)(
    "does not fail-open when the tail finding beyond 10k rows is an open in-scope %s",
    (severity, decision, metric) => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo);
        insertFixedFindings(db, {
          hitchId: "goal-test",
          count: 10_000,
          prefix: `older-${severity}`,
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
          fixedAt: "2026-05-24T00:00:10.000Z",
          source: "human",
        });
        passClose(repo, "goal-test", "2026-05-25T00:00:00.000Z");
        addFinding(repo, {
          scopeStatus: "in_scope",
          severity,
          seenAt: "2026-05-25T00:01:00.000Z",
          summary: `tail open ${severity}`,
        });

        const result = service.evaluate("goal-test");
        expect(result.decision).toBe(decision);
        expect(result.metrics[metric]).toBe(1);
      } finally {
        db.close();
      }
    },
  );

  it("treats close-check evidence before a later finding escalation timestamp as stale", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      const attempt = repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        createdAt: "2026-05-25T00:00:00.000Z",
        startedAt: "2026-05-25T00:00:00.000Z",
      });
      repo.completeAttempt({
        attemptId: attempt.attemptId,
        status: "succeeded",
        completedAt: "2026-05-25T00:00:10.000Z",
      });
      const cycle = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-05-25T00:00:20.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        findingsNew: 1,
        completedAt: "2026-05-25T00:00:30.000Z",
      });
      const finding = addFinding(repo, {
        scopeStatus: "in_scope",
        severity: "P2",
        seenAt: "2026-05-25T00:00:25.000Z",
      });
      repo.markFindingFixed({
        findingId: finding.findingId,
        fixedAt: "2026-05-25T00:00:40.000Z",
      });
      passClose(repo, "goal-test", "2026-05-25T00:01:00.000Z");
      db.prepare(
        `UPDATE hitch_findings
            SET escalated_at = ?
          WHERE finding_id = ?`,
      ).run("2026-05-25T00:02:00.000Z", finding.findingId);

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.metrics.closeConditionsPending).toBe(1);
      expect(result.reason).toBe("more validation required");
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
        hitchId: "goal-test",
        iteration: 1,
        attemptType: "rerun",
      });
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });
      expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
    } finally {
      db.close();
    }
  });

  it("reviews the last succeeded coder run before budget_exhausted at the rerun limit (#197)", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReruns: 1, maxReviewCycles: 3 });
      passClose(repo, "goal-test", "2026-05-25T00:00:00.000Z");
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
        runId: "run-197a",
        createdAt: "2026-05-25T00:02:00.000Z",
      });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.recommendedNextAction.kind).toBe("run_review");
      expect(result.reason).toMatch(/review the last succeeded coder run/);
    } finally {
      db.close();
    }
  });

  it("reviews the last succeeded coder run before budget_exhausted with an open P1 (#197)", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReruns: 1, maxReviewCycles: 3 });
      passClose(repo, "goal-test", "2026-05-25T00:00:00.000Z");
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
        runId: "run-197b",
        createdAt: "2026-05-25T00:02:00.000Z",
      });
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.recommendedNextAction.kind).toBe("run_review");
      expect(result.reason).toMatch(/review the last succeeded coder run/);
    } finally {
      db.close();
    }
  });

  it("preserves P0 and strict over-budget precedence before the final succeeded-run review", () => {
    const p0 = fresh();
    try {
      createGoal(p0.repo, { maxReruns: 1, maxReviewCycles: 3 });
      passClose(p0.repo, "goal-test", "2026-05-25T00:00:00.000Z");
      p0.repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      p0.repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
        createdAt: "2026-05-25T00:02:00.000Z",
      });
      addFinding(p0.repo, { scopeStatus: "in_scope", severity: "P0" });

      const result = p0.service.evaluate("goal-test");
      expect(result.decision).toBe("escalate");
      expect(result.recommendedNextAction.kind).not.toBe("run_review");
    } finally {
      p0.db.close();
    }

    const overBudget = fresh();
    try {
      createGoal(overBudget.repo, { maxReruns: 1, maxReviewCycles: 3 });
      passClose(overBudget.repo, "goal-test", "2026-05-25T00:00:00.000Z");
      overBudget.repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      overBudget.repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
        createdAt: "2026-05-25T00:02:00.000Z",
      });
      overBudget.repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
        createdAt: "2026-05-25T00:03:00.000Z",
      });

      const result = overBudget.service.evaluate("goal-test");
      expect(result.decision).toBe("budget_exhausted");
      expect(result.reason).toBe("max reruns exceeded");
      expect(result.recommendedNextAction.kind).not.toBe("run_review");
    } finally {
      overBudget.db.close();
    }
  });

  it("does not review a succeeded final rerun when the review-cycle budget is spent", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReruns: 1, maxReviewCycles: 1 });
      passClose(repo, "goal-test", "2026-05-25T00:00:00.000Z");
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      const cycle = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-05-25T00:02:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        findingsNew: 0,
        completedAt: "2026-05-25T00:02:30.000Z",
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
        createdAt: "2026-05-25T00:03:00.000Z",
      });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("budget_exhausted");
      expect(result.reason).toBe("max review cycles reached");
      expect(result.recommendedNextAction.kind).not.toBe("run_review");
    } finally {
      db.close();
    }
  });

  it("does not review a non-succeeded final rerun at the budget limit even with review budget left (#197)", () => {
    // The #197 review-before-budget branch is gated on the latest coding attempt
    // being deterministically `succeeded`. A still-`running` (or otherwise
    // non-succeeded, non-failed) final rerun at the rerun limit must NOT be
    // reviewed — it is not reviewable — and still stops at budget, even though
    // the review-cycle budget is wide open.
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReruns: 1, maxReviewCycles: 3 });
      passClose(repo, "goal-test", "2026-05-25T00:00:00.000Z");
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "running",
        createdAt: "2026-05-25T00:03:00.000Z",
      });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("budget_exhausted");
      expect(result.recommendedNextAction.kind).not.toBe("run_review");
    } finally {
      db.close();
    }
  });

  it("does not review a succeeded final rerun that has no runId (#197)", () => {
    // The review runner reviews the latest coding attempt WITH a runId; a
    // succeeded final attempt lacking one would make run_review review an older
    // run and clear this attempt's pending-review state. The #197 branch
    // therefore requires a runId — without it, stop at budget instead.
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReruns: 1, maxReviewCycles: 3 });
      passClose(repo, "goal-test", "2026-05-25T00:00:00.000Z");
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
        createdAt: "2026-05-25T00:01:00.000Z",
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
        createdAt: "2026-05-25T00:03:00.000Z",
      });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("budget_exhausted");
      expect(result.recommendedNextAction.kind).not.toBe("run_review");
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
        hitchId: "goal-test",
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
      addCycleFindings(repo, 1, ["review", "review", "review"]);
      passClose(repo);
      expect(service.evaluate("goal-test").decision).toBe("diverging");
    } finally {
      db.close();
    }
  });

  it("returns diverging when new findings do not decrease", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      addCycleFindings(repo, 1, ["review", "review"]);
      addCycleFindings(repo, 2, ["review", "review"]);
      passClose(repo);
      expect(service.evaluate("goal-test").decision).toBe("diverging");
    } finally {
      db.close();
    }
  });

  it("returns diverging before recommending another P1 fix pass", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      addFinding(repo, { scopeStatus: "in_scope", severity: "P1" });
      addCycleFindings(repo, 1, ["review", "review"]);
      addCycleFindings(repo, 2, ["review", "review"]);
      passClose(repo);
      expect(service.evaluate("goal-test").decision).toBe("diverging");
    } finally {
      db.close();
    }
  });

  describe("#164: diverging is re-derived live (self-clearing), not a cached terminal", () => {
    it("clears a stored-diverging session to a LIVE decision when a transient trigger no longer holds", () => {
      const { db, repo, service } = fresh();
      try {
        // high review-cycle budget so the clean cycle does NOT trip
        // budget_exhausted and mask the self-clear with another stop.
        createGoal(repo, { maxReviewCycles: 20 });
        addCycleFindings(repo, 1, ["review", "review"]);
        addCycleFindings(repo, 2, ["review", "review"]); // non-decreasing → diverging
        expect(service.evaluate("goal-test").decision).toBe("diverging");
        // persist the diverging status (as syncHitchStatusForConvergence would)
        repo.updateStatus("goal-test", "diverging", "diverged", {
          createdBy: "test",
        });
        // a fresh CLEAN review cycle (0 new findings) clears the non-decreasing trigger
        addCycle(repo, 3, 0);
        // BEFORE the fix the stored status short-circuited to diverging; now it
        // re-derives live and clears to a live-work decision (not another stop).
        const after = service.evaluate("goal-test");
        expect(after.decision).not.toBe("diverging");
        expect(after.decision).not.toBe("budget_exhausted");
        expect(after.decision).not.toBe("escalate");
      } finally {
        db.close();
      }
    });

    it("keeps a stored-diverging session diverging when a CUMULATIVE budget trigger still holds (no false clear)", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo, { maxTotalNewFindings: 2, maxReviewCycles: 20 });
        addCycleFindings(repo, 1, ["review", "review", "review"]); // 3 > 2 → diverging
        expect(service.evaluate("goal-test").decision).toBe("diverging");
        repo.updateStatus("goal-test", "diverging", "diverged", {
          createdBy: "test",
        });
        // a clean cycle does NOT reduce the cumulative total (3 > budget 2):
        // re-derived live, it correctly STAYS diverging.
        addCycle(repo, 2, 0);
        expect(service.evaluate("goal-test").decision).toBe("diverging");
      } finally {
        db.close();
      }
    });

    it("syncs the hitch status from diverging back to in_progress when the live decision clears", () => {
      const { db, repo } = fresh();
      try {
        // maxReviewCycles high + no passed close check, so the cleared decision is
        // a live-work decision (NOT budget_exhausted / close_ready) and the status
        // reversion branch (diverging → in_progress) is the ONLY path off diverging.
        createGoal(repo, { maxReviewCycles: 20 });
        addCycleFindings(repo, 1, ["review", "review"]);
        addCycleFindings(repo, 2, ["review", "review"]);
        evaluateConvergenceAndRecordStatus({
          repository: repo,
          hitchId: "goal-test",
          createdBy: "test",
        });
        expect(repo.requireSession("goal-test").status).toBe("diverging");
        addCycle(repo, 3, 0); // clean cycle clears the transient trigger
        evaluateConvergenceAndRecordStatus({
          repository: repo,
          hitchId: "goal-test",
          createdBy: "test",
        });
        // the data-layer reversion moved it OFF diverging, back to live work.
        expect(repo.requireSession("goal-test").status).toBe("in_progress");
      } finally {
        db.close();
      }
    });

    it("does NOT clear divergence on a STARTED-but-incomplete review cycle (requires completed evidence)", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo, { maxReviewCycles: 20 });
        addCycleFindings(repo, 1, ["review", "review"]);
        addCycleFindings(repo, 2, ["review", "review"]); // non-decreasing → diverging
        expect(service.evaluate("goal-test").decision).toBe("diverging");
        repo.updateStatus("goal-test", "diverging", "diverged", {
          createdBy: "test",
        });
        // merely START cycle 3 — no findings imported, NOT completed. An
        // incomplete cycle is not clean review evidence and must not self-clear.
        repo.startReviewCycle({
          hitchId: "goal-test",
          cycleNumber: 3,
          reviewMode: "delta",
        });
        expect(service.evaluate("goal-test").decision).toBe("diverging");
      } finally {
        db.close();
      }
    });

    it("precedence: a stored-diverging session with an open in-scope P0 escalates (P0 gate wins)", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo, { maxReviewCycles: 20 });
        addCycleFindings(repo, 1, ["review", "review"]);
        addCycleFindings(repo, 2, ["review", "review"]);
        expect(service.evaluate("goal-test").decision).toBe("diverging");
        repo.updateStatus("goal-test", "diverging", "diverged", {
          createdBy: "test",
        });
        addFinding(repo, { scopeStatus: "in_scope", severity: "P0" });
        // re-derived live: the open in-scope P0 gate (step 3) precedes divergence.
        expect(service.evaluate("goal-test").decision).toBe("escalate");
      } finally {
        db.close();
      }
    });

    it("precedence: a stored-diverging session over the review-cycle budget reports budget_exhausted", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo, { maxReviewCycles: 2 });
        addCycleFindings(repo, 1, ["review", "review"]);
        addCycleFindings(repo, 2, ["review", "review"]); // diverging + cycles at max
        expect(service.evaluate("goal-test").decision).toBe("diverging");
        repo.updateStatus("goal-test", "diverging", "diverged", {
          createdBy: "test",
        });
        addCycle(repo, 3, 0); // now over the review-cycle budget
        // re-derived live: the budget gate (step 2) precedes divergence.
        expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
      } finally {
        db.close();
      }
    });
  });

  describe("source-aware divergence", () => {
    function reopenFindingPastPolicy(
      repo: HitchRepository,
      source: HitchFindingSource,
    ) {
      const finding = addFinding(repo, {
        source,
        scopeStatus: "in_scope",
        severity: "P2",
        summary: `reopens-${source}`,
      });
      for (let i = 0; i < 3; i += 1) {
        repo.markFindingFixed({ findingId: finding.findingId });
        repo.upsertFinding({
          hitchId: "goal-test",
          source,
          severity: "P2",
          category: "correctness",
          scopeStatus: "in_scope",
          summary: `reopens-${source}`,
        });
      }
      return repo.requireFinding(finding.findingId);
    }

    function addDuplicateFinding(
      repo: HitchRepository,
      input: {
        canonicalId: string;
        cycleId: string;
        summary: string;
      },
    ) {
      return repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        sourceCycleId: input.cycleId,
        severity: "P2",
        category: "correctness",
        scopeStatus: "duplicate",
        duplicateOf: input.canonicalId,
        summary: input.summary,
      }).finding;
    }

    it("operator/human-origin new findings do NOT trigger diverging", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo, { maxTotalNewFindings: 2 });
        addCycleFindings(repo, 1, ["human", "human", "human"]);
        addCycleFindings(repo, 2, ["mcp", "mcp", "mcp"]);
        passClose(repo);

        const result = service.evaluate("goal-test");
        expect(result.decision).not.toBe("diverging");
        expect(result.metrics.harnessOriginNewFindings).toBe(0);
        expect(result.metrics.harnessOriginNewFindingsThisCycle).toBe(0);
      } finally {
        db.close();
      }
    });

    it.each(["review", "other"] as const)(
      "harness-origin %s churn STILL triggers diverging",
      (source) => {
        const { db, repo, service } = fresh();
        try {
          createGoal(repo, { maxTotalNewFindings: 10 });
          addCycleFindings(repo, 1, [
            source,
            source,
            source,
            source,
            source,
            source,
          ]);
          passClose(repo);

          const result = service.evaluate("goal-test");
          expect(result.decision).toBe("diverging");
          expect(result.metrics.harnessOriginNewFindings).toBe(6);
          expect(result.metrics.harnessOriginNewFindingsThisCycle).toBe(6);
        } finally {
          db.close();
        }
      },
    );

    it("makes the maxReopenCount divergence branch source-aware", () => {
      const operator = fresh();
      try {
        createGoal(operator.repo);
        const direct = addFinding(operator.repo, {
          source: "review",
          scopeStatus: "out_of_scope",
          severity: "P2",
          summary: "operator-reported direct reopen",
        });
        const duplicateCanonical = addFinding(operator.repo, {
          source: "review",
          scopeStatus: "out_of_scope",
          severity: "P2",
          summary: "operator-reported duplicate reopen",
        });
        for (let i = 0; i < 3; i += 1) {
          operator.repo.markFindingFixed({ findingId: direct.findingId });
          operator.repo.upsertFinding({
            hitchId: "goal-test",
            source: "human",
            severity: "P2",
            category: "correctness",
            scopeStatus: "out_of_scope",
            summary: "operator-reported direct reopen",
          });

          operator.repo.markFindingFixed({
            findingId: duplicateCanonical.findingId,
          });
          operator.repo.upsertFinding({
            hitchId: "goal-test",
            source: "mcp",
            severity: "P2",
            category: "correctness",
            scopeStatus: "duplicate",
            summary: `operator-reported duplicate ${i}`,
            duplicateOf: duplicateCanonical.findingId,
          });
        }
        passClose(operator.repo);

        const result = operator.service.evaluate("goal-test");
        expect(result.metrics.maxReopenCount).toBe(0);
        expect(result.metrics.harnessOriginMaxReopenCount).toBe(0);
        expect(result.decision).not.toBe("diverging");
      } finally {
        operator.db.close();
      }

      const harness = fresh();
      try {
        createGoal(harness.repo);
        reopenFindingPastPolicy(harness.repo, "review");
        passClose(harness.repo);

        const result = harness.service.evaluate("goal-test");
        expect(result.metrics.harnessOriginMaxReopenCount).toBeGreaterThan(
          DEFAULT_HITCH_POLICY.divergence.maxReopenedPerFinding,
        );
        expect(result.decision).toBe("diverging");
      } finally {
        harness.db.close();
      }
    });

    it("does not diverge when current-cycle review churn is retained as duplicates", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo);
        const cycle = addCycle(repo, 1, 7);
        const canonical = addFinding(repo, {
          source: "review",
          sourceCycleId: cycle.cycleId,
          scopeStatus: "out_of_scope",
          severity: "P2",
          summary: "canonical paraphrased review defect",
        });
        for (let i = 0; i < 6; i += 1) {
          addDuplicateFinding(repo, {
            canonicalId: canonical.findingId,
            cycleId: cycle.cycleId,
            summary: `duplicate paraphrased review defect ${i}`,
          });
        }
        passClose(repo);

        const result = service.evaluate("goal-test");
        expect(result.metrics.newFindingsThisCycle).toBe(7);
        expect(result.metrics.harnessOriginNewFindingsThisCycle).toBe(1);
        expect(result.decision).not.toBe("diverging");
      } finally {
        db.close();
      }
    });

    it("handles mixed pre-fix and deduped cycle histories deterministically", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo);
        const first = addCycle(repo, 1, 6);
        addFinding(repo, {
          source: "review",
          sourceCycleId: first.cycleId,
          scopeStatus: "out_of_scope",
          severity: "P2",
          summary: "first canonical finding",
        });
        addFinding(repo, {
          source: "review",
          sourceCycleId: first.cycleId,
          scopeStatus: "out_of_scope",
          severity: "P2",
          summary: "second canonical finding",
        });

        const second = addCycle(repo, 2, 1);
        const canonical = addFinding(repo, {
          source: "review",
          sourceCycleId: second.cycleId,
          scopeStatus: "out_of_scope",
          severity: "P2",
          summary: "deduped cycle canonical finding",
        });
        for (let i = 0; i < 5; i += 1) {
          addDuplicateFinding(repo, {
            canonicalId: canonical.findingId,
            cycleId: second.cycleId,
            summary: `deduped cycle paraphrase ${i}`,
          });
        }
        passClose(repo);

        const result = service.evaluate("goal-test");
        expect(result.metrics.totalNewFindings).toBe(7);
        expect(result.metrics.harnessOriginNewFindingsByCycle).toEqual([
          {
            cycleId: first.cycleId,
            cycleNumber: 1,
            findingsNew: 2,
          },
          {
            cycleId: second.cycleId,
            cycleNumber: 2,
            findingsNew: 1,
          },
        ]);
        expect(result.decision).not.toBe("diverging");
      } finally {
        db.close();
      }
    });

    it("does not let paraphrase duplicates inflate the maxReopenCount divergence branch", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo);
        const canonical = addFinding(repo, {
          source: "review",
          scopeStatus: "out_of_scope",
          severity: "P2",
          summary:
            "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle",
        });
        const paraphrases = [
          "Review import uses only summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
          "Review import uses only summary text for finding identity, so reviewer paraphrases create new findings every cycle",
          "Review import uses only summary text for finding identity, so paraphrased reviewer findings create duplicate findings each cycle",
        ];
        paraphrases.forEach((summary, index) => {
          const cycle = addCycle(repo, index + 1, 0);
          repo.markFindingFixed({ findingId: canonical.findingId });
          repo.upsertFinding({
            hitchId: "goal-test",
            source: "review",
            sourceCycleId: cycle.cycleId,
            severity: "P2",
            category: "correctness",
            scopeStatus: "in_scope",
            summary,
          });
        });
        passClose(repo);

        const result = service.evaluate("goal-test");
        expect(repo.requireFinding(canonical.findingId)).toMatchObject({
          lifecycleStatus: "reopened",
          reopenCount: 0,
        });
        expect(result.metrics.maxReopenCount).toBe(0);
        expect(result.metrics.harnessOriginMaxReopenCount).toBe(0);
        expect(result.decision).not.toBe("diverging");
      } finally {
        db.close();
      }
    });

    it("open human P1 still blocks close but does not diverge", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo, { maxTotalNewFindings: 2 });
        addFinding(repo, {
          source: "human",
          scopeStatus: "in_scope",
          severity: "P1",
          summary: "operator-blocker",
        });
        addCycleFindings(repo, 1, ["human", "human"]);
        addCycleFindings(repo, 2, ["mcp", "mcp"]);
        passClose(repo);

        const result = service.evaluate("goal-test");
        expect(result.decision).not.toBe("diverging");
        expect(result.decision).not.toBe("close_ready");
        expect(result.metrics.openInScopeP1).toBe(1);
      } finally {
        db.close();
      }
    });

    it("operator-origin in-scope P0 still escalates outside divergence", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo);
        addFinding(repo, {
          source: "human",
          scopeStatus: "in_scope",
          severity: "P0",
          summary: "operator p0 blocker",
        });
        passClose(repo);

        const result = service.evaluate("goal-test");
        expect(result.decision).toBe("escalate");
        expect(result.reason).toBe("open in-scope P0 findings");
        expect(result.metrics.harnessOriginNewFindings).toBe(0);
      } finally {
        db.close();
      }
    });

    it("non-decreasing divergence excludes operator-origin findings only", () => {
      const operator = fresh();
      try {
        createGoal(operator.repo);
        addCycleFindings(operator.repo, 1, ["human", "human"]);
        addCycleFindings(operator.repo, 2, ["mcp", "mcp"]);
        passClose(operator.repo);

        const result = operator.service.evaluate("goal-test");
        expect(result.decision).not.toBe("diverging");
        expect(result.metrics.harnessOriginNewFindings).toBe(0);
      } finally {
        operator.db.close();
      }

      const harness = fresh();
      try {
        createGoal(harness.repo);
        addCycleFindings(harness.repo, 1, ["review", "review"]);
        addCycleFindings(harness.repo, 2, ["review", "review"]);
        passClose(harness.repo);

        expect(harness.service.evaluate("goal-test").decision).toBe(
          "diverging",
        );
      } finally {
        harness.db.close();
      }
    });
  });

  it("requires defer_followups when out-of-scope findings remain", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      const finding = addFinding(repo, { scopeStatus: "out_of_scope", severity: "P1" });
      passClose(repo);
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
          ...DEFAULT_HITCH_POLICY,
          deferOutOfScope: false,
        },
      });
      addFinding(repo, { scopeStatus: "out_of_scope", severity: "P1" });
      passClose(repo);
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
          ...DEFAULT_HITCH_POLICY,
          closeRequires: {
            ...DEFAULT_HITCH_POLICY.closeRequires,
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
        hitchId: "goal-test",
        conditionId: "typecheck",
        status: "failed",
        checkedBy: "test",
      });
      expect(service.evaluate("goal-test").decision).toBe("needs_fix");
    } finally {
      db.close();
    }
  });

  it.each(["skipped", "unknown"] as const)(
    "routes required command close checks with latest %s evidence back to the command runner",
    (status) => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo);
        repo.createAttempt({
          hitchId: "goal-test",
          attemptType: "implement",
          status: "succeeded",
          createdAt: "2026-06-13T00:00:00.000Z",
        });
        const cycle = repo.startReviewCycle({
          hitchId: "goal-test",
          cycleNumber: 1,
          reviewMode: "initial",
          createdAt: "2026-06-13T00:01:00.000Z",
        });
        repo.completeReviewCycle({
          cycleId: cycle.cycleId,
          completedAt: "2026-06-13T00:01:10.000Z",
        });
        repo.recordCloseCheck({
          hitchId: "goal-test",
          conditionId: "typecheck",
          status,
          checkedBy: "test",
          checkedAt: "2026-06-13T00:02:00.000Z",
        });

        const result = service.evaluate("goal-test");
        expect(result.decision).toBe("continue");
        expect(result.recommendedNextAction.kind).toBe("run_close_check");
      } finally {
        db.close();
      }
    },
  );

  it("waits for external evidence when only manual close conditions remain pending", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, {
        closeConditions: [
          { id: "manual-signoff", kind: "manual", required: true },
        ],
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "succeeded",
        createdAt: "2026-06-13T00:00:00.000Z",
      });
      const cycle = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-06-13T00:01:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        completedAt: "2026-06-13T00:01:10.000Z",
      });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.recommendedNextAction).toMatchObject({
        kind: "ask_human",
      });
      expect(result.reason).toMatch(/external close-check evidence/);
    } finally {
      db.close();
    }
  });

  it("runs pending command evidence before waiting on non-command evidence", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, {
        closeConditions: [
          { id: "typecheck", kind: "command", required: true },
          { id: "artifact", kind: "artifact_exists", required: true },
        ],
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "succeeded",
        createdAt: "2026-06-13T00:00:00.000Z",
      });
      const cycle = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-06-13T00:01:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        completedAt: "2026-06-13T00:01:10.000Z",
      });

      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.recommendedNextAction.kind).toBe("run_close_check");
    } finally {
      db.close();
    }
  });

  it("routes to a rerun (not review) when the latest coding attempt failed before review", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo); // close condition pending, no findings
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
      });
      const r = service.evaluate("goal-test");
      // a failed coding run produces no needs_review run — convergence must NOT
      // route to review (which would throw); it routes to a bounded rerun.
      expect(r.decision).toBe("needs_fix");
      expect(r.recommendedNextAction.kind).toBe("fix_findings");
      expect(r.reason).toMatch(/latest coding run failed/);
    } finally {
      db.close();
    }
  });

  it("does NOT route to a rerun once a later coding attempt succeeded (review path intact)", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo);
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
      });
      const r = service.evaluate("goal-test");
      expect(r.decision).toBe("continue");
      expect(r.recommendedNextAction.kind).toBe("run_review");
    } finally {
      db.close();
    }
  });

  it("a failed latest coding attempt with reruns exhausted escalates as budget_exhausted (bounded)", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, { maxReruns: 1, maxIterations: 10 });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        status: "failed",
      });
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "failed",
      });
      // rerunsUsed (1) >= maxReruns (1) → the budget guard terminates the loop
      // before the failed-run reroute, so it cannot rerun forever.
      expect(service.evaluate("goal-test").decision).toBe("budget_exhausted");
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
          hitchId: "goal-test",
          source: "review",
          severity: "P2",
          category: "correctness",
          scopeStatus: "in_scope",
          summary: "flaky",
        });
      }
      expect(service.evaluate("goal-test").decision).toBe("diverging");
    } finally {
      db.close();
    }
  });

  // #230 Task D5 — jury non-interference at the convergence layer.
  //
  // The deliberation jury is reached ONLY through the `classify` orchestrator
  // action, which `decideOrchestratorAction` returns ONLY for the
  // `needs_classification` decision (whose next-action kind is
  // `classify_findings`). The hard pre-emption order in `convergence.ts`
  // (terminal → budget_exhausted → P0-escalate → diverging) all short-circuit
  // BEFORE the `needs_classification` branch. These tests seed an open
  // unknown-scope finding (the SOLE precondition that would otherwise route to
  // classify → jury) ALONGSIDE each escalate/budget/divergence trigger and
  // prove the decision pre-empts classification: the decision is the expected
  // stop and the next-action kind is NEVER `classify_findings`, so the jury is
  // structurally unreachable on those paths (it escalates as before).
  describe("#230 D5: escalate/budget/divergence pre-empt classify (jury never runs)", () => {
    it("open in-scope P0 escalates instead of classifying a co-present unknown-scope finding", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo);
        passClose(repo);
        addFinding(repo, { scopeStatus: "unknown", severity: "P2" });
        addFinding(repo, { scopeStatus: "in_scope", severity: "P0" });
        const result = service.evaluate("goal-test");
        expect(result.decision).toBe("escalate");
        expect(result.decision).not.toBe("needs_classification");
        expect(result.recommendedNextAction.kind).not.toBe("classify_findings");
      } finally {
        db.close();
      }
    });

    it("budget_exhausted (iteration limit) stops instead of classifying a co-present unknown-scope finding", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo, { maxIterations: 1 });
        passClose(repo);
        repo.createAttempt({ hitchId: "goal-test", attemptType: "implement" });
        repo.createAttempt({ hitchId: "goal-test", attemptType: "validate" });
        addFinding(repo, { scopeStatus: "unknown", severity: "P2" });
        const result = service.evaluate("goal-test");
        expect(result.decision).toBe("budget_exhausted");
        expect(result.decision).not.toBe("needs_classification");
        expect(result.recommendedNextAction.kind).not.toBe("classify_findings");
      } finally {
        db.close();
      }
    });

    it("diverging stops instead of classifying a co-present unknown-scope finding", () => {
      const { db, repo, service } = fresh();
      try {
        createGoal(repo, { maxTotalNewFindings: 2 });
        addCycleFindings(repo, 1, ["review", "review", "review"]); // 3 > 2 → diverging
        addFinding(repo, { scopeStatus: "unknown", severity: "P2" });
        passClose(repo);
        const result = service.evaluate("goal-test");
        expect(result.decision).toBe("diverging");
        expect(result.decision).not.toBe("needs_classification");
        expect(result.recommendedNextAction.kind).not.toBe("classify_findings");
      } finally {
        db.close();
      }
    });

    // #230 Task D5 / P2-i — an advisory severity-divergence decision (the D2b
    // shape: a `continue`/non-blocking convergence decision recorded with
    // updateStatus:false after a jury auto_confirm) is purely advisory. The
    // close gate keys ONLY on live `hitch_findings` scope/severity metrics — it
    // never reads jury_severity_audits or recorded convergence decisions — so
    // recording the advisory decision must NOT move the close gate, and the
    // subject finding's severity (the authoritative harness mapping) must stay
    // UNCHANGED (the jury never auto-downgrades it).
    it("an advisory severity-divergence decision does not move the close gate or alter the finding severity", () => {
      const { db, repo, service } = fresh();
      try {
        // Permissive close policy (mirrors the existing close_ready-with-unknown
        // test): an unknown-scope finding does not block close here, so the hitch
        // is genuinely close_ready and the test isolates the advisory decision's
        // (non-)effect on the gate. The finding carries the authoritative harness
        // severity that the advisory diverged audit questions but never changes.
        createGoal(repo, {
          policy: {
            ...DEFAULT_HITCH_POLICY,
            stopOnUnknownScope: false,
            closeRequires: {
              ...DEFAULT_HITCH_POLICY.closeRequires,
              noUnknownScope: false,
            },
          },
        });
        const finding = addFinding(repo, {
          scopeStatus: "unknown",
          severity: "P2",
        });
        passClose(repo);

        // Baseline: the hitch is close_ready (no open blockers remain).
        const before = service.evaluate("goal-test");
        expect(before.decision).toBe("close_ready");

        // Record the advisory severity-divergence decision exactly as the D2b
        // orchestrator path does: a NON-blocking `continue` decision (NOT
        // `escalate`) so the course/phase rollup stays neutral.
        repo.recordConvergenceDecision({
          hitchId: "goal-test",
          decision: "continue",
          reason:
            "advisory: jury severity vote diverged from the harness mapping (severity unchanged)",
          recommendedNextAction: {
            kind: "ask_human",
            message: "Review the diverged severity audit; mapping is authoritative.",
            findingIds: [finding.findingId],
          },
          createdBy: "test",
        });

        // The close gate is unchanged: still close_ready (advisory record does
        // not feed the gate).
        const after = service.evaluate("goal-test");
        expect(after.decision).toBe("close_ready");

        // The finding's severity (authoritative harness mapping) is untouched.
        expect(repo.requireFinding(finding.findingId).severity).toBe("P2");
      } finally {
        db.close();
      }
    });
  });
});
