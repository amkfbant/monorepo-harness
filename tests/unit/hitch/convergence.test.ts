import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { DEFAULT_HITCH_POLICY, type HitchPolicy } from "../../../src/hitch/types.js";

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

function addCycle(repo: HitchRepository, cycleNumber: number, findingsNew: number) {
  const cycle = repo.startReviewCycle({
    hitchId: "goal-test",
    cycleNumber,
    reviewMode: cycleNumber === 1 ? "initial" : "delta",
  });
  repo.completeReviewCycle({ cycleId: cycle.cycleId, findingsNew });
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
  },
) {
  const insert = db.prepare(
    `INSERT INTO hitch_findings (
       finding_id, hitch_id, stable_key, source, severity, category,
       scope_status, lifecycle_status, summary, first_seen_at, last_seen_at,
       fixed_at, reopen_count
     )
     VALUES (?, ?, ?, 'review', 'P2', 'correctness', 'in_scope', 'fixed',
       ?, ?, ?, ?, 0)`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < input.count; i += 1) {
      const id = `${input.prefix}-${i}`;
      insert.run(
        id,
        input.hitchId,
        id,
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
      });
      passClose(repo, "goal-test", "2026-05-25T00:01:00.000Z");
      insertFixedFindings(db, {
        hitchId: "goal-test",
        count: 1,
        prefix: "late-fixed",
        firstSeenAt: "2026-05-25T00:02:00.000Z",
        lastSeenAt: "2026-05-25T00:02:00.000Z",
        fixedAt: "2026-05-25T00:03:00.000Z",
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
