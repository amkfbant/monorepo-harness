import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  HitchRepository,
  OPEN_FINDING_LIFECYCLES,
} from "../../../src/hitch/repository.js";

function freshRepo(): { db: ReturnType<typeof openDb>; repo: HitchRepository } {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-repo-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, repo: new HitchRepository(db) };
}

function createGoal(
  repo: HitchRepository,
  overrides: { hitchId?: string } = {},
) {
  return repo.createSession({
    hitchId: overrides.hitchId ?? "goal-test",
    title: "Goal convergence",
    projectId: "monorepo-harness",
    domain: "goal",
    scope: {
      targetFiles: ["src/goal/**"],
      allowedFindingCategories: ["correctness"],
    },
    closeConditions: [
      {
        id: "typecheck",
        kind: "command",
        required: true,
        description: "typecheck passes",
      },
    ],
    createdBy: "test",
    createdSource: "cli",
    createdAt: "2026-05-26T00:00:00.000Z",
  });
}

describe("HitchRepository", () => {
  it("creates and reads a goal session", () => {
    const { db, repo } = freshRepo();
    try {
      const goal = createGoal(repo);
      expect(goal.hitchId).toBe("goal-test");
      expect(goal.status).toBe("open");
      expect(goal.maxReviewCycles).toBe(3);
      expect(goal.policy.autoFixSeverities).toEqual(["P1"]);
      expect(repo.getSession("goal-test")?.closeConditions[0]?.id).toBe(
        "typecheck",
      );
    } finally {
      db.close();
    }
  });

  it("creates attempts and review cycles linked to a goal", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const attempt = repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
        runId: "run-a",
        input: { step: "implement" },
      });
      expect(attempt.iteration).toBe(1);
      expect(attempt.status).toBe("running");
      const completed = repo.completeAttempt({
        attemptId: attempt.attemptId,
        status: "succeeded",
        result: { ok: true },
      });
      expect(completed.result.ok).toBe(true);

      const cycle = repo.startReviewCycle({
        hitchId: "goal-test",
        reviewMode: "initial",
        triggerAttemptId: attempt.attemptId,
      });
      expect(cycle.cycleNumber).toBe(1);
      const done = repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        findingsSeen: 2,
        findingsNew: 1,
        findingsInScopeOpen: 1,
      });
      expect(done.findingsNew).toBe(1);
      expect(repo.requireSession("goal-test").currentReviewCycle).toBe(1);
    } finally {
      db.close();
    }
  });

  it("upserts findings by stable key and reopens fixed findings", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Repository drops classification reason",
        filePath: "src/goal/repository.ts",
      });
      expect(first.created).toBe(true);
      expect(first.finding.lifecycleStatus).toBe("open");

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: " correctness ",
        scopeStatus: "in_scope",
        summary: " repository   drops classification reason ",
        filePath: "./SRC/goal/repository.ts",
      });
      expect(duplicate.created).toBe(false);
      expect(duplicate.finding.findingId).toBe(first.finding.findingId);

      repo.markFindingFixed({
        findingId: first.finding.findingId,
        note: "stored",
        fixedAt: "2026-05-26T01:00:00.000Z",
      });
      const reopened = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Repository drops classification reason",
        filePath: "src/goal/repository.ts",
        seenAt: "2026-05-26T02:00:00.000Z",
      });
      expect(reopened.reopened).toBe(true);
      expect(reopened.finding.lifecycleStatus).toBe("reopened");
      expect(reopened.finding.reopenCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("counts open, reopened, and escalated findings as active", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const active = [
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P1",
          category: "correctness",
          scopeStatus: "in_scope",
          lifecycleStatus: "open",
          summary: "open in-scope",
        }).finding.findingId,
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P1",
          category: "correctness",
          scopeStatus: "in_scope",
          lifecycleStatus: "reopened",
          summary: "reopened in-scope",
        }).finding.findingId,
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P1",
          category: "correctness",
          scopeStatus: "in_scope",
          lifecycleStatus: "escalated",
          summary: "escalated in-scope",
        }).finding.findingId,
      ];
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "fixed",
        summary: "fixed in-scope",
      });
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "unknown",
        lifecycleStatus: "escalated",
        summary: "escalated unknown",
      });
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "follow-up",
        scopeStatus: "out_of_scope",
        summary: "out-of-scope default lifecycle",
      });
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "follow-up",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "escalated",
        summary: "escalated out-of-scope",
      });

      expect(repo.countFindingSummary("goal-test")).toMatchObject({
        openInScopeP1: 3,
        openUnknownScope: 1,
        openOutOfScope: 2,
      });
      expect(
        repo.countFindings({
          hitchId: "goal-test",
          lifecycleStatusIn: OPEN_FINDING_LIFECYCLES,
        }),
      ).toBe(5);
      const listedActive = repo
        .listFindings({
          hitchId: "goal-test",
          scopeStatus: "in_scope",
          severity: "P1",
          lifecycleStatusIn: OPEN_FINDING_LIFECYCLES,
        })
        .map((finding) => finding.findingId);
      expect(listedActive).toHaveLength(active.length);
      expect(listedActive).toEqual(expect.arrayContaining(active));
    } finally {
      db.close();
    }
  });

  it("classifies, fixes, defers, and records decisions", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const finding = repo.upsertFinding({
        hitchId: "goal-test",
        source: "human",
        severity: "P2",
        category: "future-feature",
        summary: "Add dashboard UI",
      }).finding;
      const classified = repo.classifyFinding({
        findingId: finding.findingId,
        scopeStatus: "out_of_scope",
        reason: "future dashboard UI",
      });
      expect(classified.lifecycleStatus).toBe("out_of_scope");
      const deferred = repo.deferFinding({
        findingId: finding.findingId,
        backlogItemId: "item-20260526-001",
        note: "follow-up",
      });
      expect(deferred.lifecycleStatus).toBe("deferred");
      expect(deferred.deferredBacklogItemId).toBe("item-20260526-001");

      const check = repo.recordCloseCheck({
        hitchId: "goal-test",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
        evidence: { command: "npm run typecheck" },
      });
      expect(check.evidence.command).toBe("npm run typecheck");

      const decision = repo.recordConvergenceDecision({
        hitchId: "goal-test",
        decision: "close_ready",
        reason: "passed",
        metrics: { openInScopeP1: 0 },
        recommendedNextAction: {
          kind: "close_hitch",
          message: "close",
        },
        createdBy: "test",
      });
      expect(decision.recommendedNextAction?.kind).toBe("close_hitch");
      expect(repo.listDecisions("goal-test")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("preserves duplicate classification when the same stable key reappears", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Canonical finding",
      }).finding;
      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        summary: "Duplicate finding",
      }).finding;
      repo.classifyFinding({
        findingId: duplicate.findingId,
        scopeStatus: "duplicate",
        duplicateOf: canonical.findingId,
        reason: "same root cause",
      });

      const seenAgain = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        summary: "Duplicate finding",
      });
      expect(seenAgain.created).toBe(false);
      expect(seenAgain.finding.findingId).toBe(duplicate.findingId);
      expect(seenAgain.finding.lifecycleStatus).toBe("duplicate");
      expect(repo.listFindings({ hitchId: "goal-test" })).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("rejects duplicate classification without a canonical finding", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Duplicate without canonical",
      }).finding;

      expect(() =>
        repo.classifyFinding({
          findingId: duplicate.findingId,
          scopeStatus: "duplicate",
          reason: "same root cause",
        }),
      ).toThrow(/duplicateOf/);
    } finally {
      db.close();
    }
  });

  it("rejects duplicate classification that points outside the goal", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      createGoal(repo, { hitchId: "goal-other" });
      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Duplicate finding",
      }).finding;
      const other = repo.upsertFinding({
        hitchId: "goal-other",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Other goal finding",
      }).finding;

      expect(() =>
        repo.classifyFinding({
          findingId: duplicate.findingId,
          scopeStatus: "duplicate",
          duplicateOf: other.findingId,
          reason: "same root cause",
        }),
      ).toThrow(/different hitch/);
    } finally {
      db.close();
    }
  });

  it("rejects duplicate-scoped finding inserts without a canonical finding", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      expect(() =>
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P1",
          category: "correctness",
          scopeStatus: "duplicate",
          summary: "Duplicate without canonical",
        }),
      ).toThrow(/duplicateOf/);
    } finally {
      db.close();
    }
  });

  it("allows duplicate-scoped finding inserts with a canonical same-goal finding", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Canonical finding",
      }).finding;
      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "duplicate",
        duplicateOf: canonical.findingId,
        summary: "Duplicate with canonical",
      }).finding;

      expect(duplicate.lifecycleStatus).toBe("duplicate");
      expect(duplicate.duplicateOf).toBe(canonical.findingId);
    } finally {
      db.close();
    }
  });

  it("rejects duplicate canonical targets that are themselves duplicate-scoped", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Canonical finding",
      }).finding;
      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        summary: "Duplicate finding",
      }).finding;
      repo.classifyFinding({
        findingId: duplicate.findingId,
        scopeStatus: "duplicate",
        duplicateOf: canonical.findingId,
        reason: "same root cause",
      });
      repo.markFindingFixed({ findingId: duplicate.findingId });
      const chained = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Chained duplicate",
      }).finding;

      expect(() =>
        repo.classifyFinding({
          findingId: chained.findingId,
          scopeStatus: "duplicate",
          duplicateOf: duplicate.findingId,
          reason: "same root cause",
        }),
      ).toThrow(/also a duplicate/);
    } finally {
      db.close();
    }
  });

  it("promotes duplicate severity onto canonical findings and reopens fixed canonicals", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Canonical blocker",
      }).finding;
      repo.markFindingFixed({ findingId: canonical.findingId });
      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P0",
        category: "correctness",
        summary: "Duplicate blocker",
      }).finding;
      const classified = repo.classifyFinding({
        findingId: duplicate.findingId,
        scopeStatus: "duplicate",
        duplicateOf: canonical.findingId,
        reason: "same root cause",
      });
      const promoted = repo.requireFinding(canonical.findingId);

      expect(classified.lifecycleStatus).toBe("duplicate");
      expect(promoted.severity).toBe("P0");
      expect(promoted.lifecycleStatus).toBe("reopened");
      expect(promoted.fixedAt).toBeNull();
      expect(promoted.reopenCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("reopens duplicate canonicals when an existing duplicate is seen again", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Canonical blocker",
      }).finding;
      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "Duplicate blocker",
      }).finding;
      repo.classifyFinding({
        findingId: duplicate.findingId,
        scopeStatus: "duplicate",
        duplicateOf: canonical.findingId,
        reason: "same root cause",
      });
      repo.markFindingFixed({ findingId: canonical.findingId });

      const seenAgain = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P0",
        category: "correctness",
        summary: "Duplicate blocker",
      });
      const promoted = repo.requireFinding(canonical.findingId);

      expect(seenAgain.created).toBe(false);
      expect(seenAgain.reopened).toBe(true);
      expect(seenAgain.finding.lifecycleStatus).toBe("duplicate");
      expect(promoted.severity).toBe("P0");
      expect(promoted.lifecycleStatus).toBe("reopened");
      expect(promoted.reopenCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("promotes severity when the same stable key is later reported higher", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "security",
        summary: "Potential bypass",
      }).finding;
      expect(first.severity).toBe("P2");
      const second = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P0",
        category: "security",
        summary: "Potential bypass",
      }).finding;
      expect(second.findingId).toBe(first.findingId);
      expect(second.severity).toBe("P0");
    } finally {
      db.close();
    }
  });
});

describe("reopenSession (#76)", () => {
  it("reopens a closed goal: status open, terminal markers cleared, budget extended", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "closed", "all done");
      const before = repo.requireSession("goal-test");
      expect(before.status).toBe("closed");
      expect(before.closedAt).not.toBeNull();
      const after = repo.reopenSession("goal-test", {
        extendIterations: 3,
        extendReviewCycles: 2,
        extendReruns: 1,
      });
      expect(after.status).toBe("open");
      expect(after.closedAt).toBeNull();
      expect(after.closeSummary).toBeNull();
      expect(after.maxIterations).toBe(before.maxIterations + 3);
      expect(after.maxReviewCycles).toBe(before.maxReviewCycles + 2);
      expect(after.maxReruns).toBe(before.maxReruns + 1);
    } finally {
      db.close();
    }
  });

  it("reopens a budget_exhausted goal", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "budget_exhausted", "out of budget");
      expect(repo.reopenSession("goal-test").status).toBe("open");
    } finally {
      db.close();
    }
  });

  it("refuses to reopen a cancelled goal (deliberate abandon)", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "cancelled", "abandoned");
      expect(() => repo.reopenSession("goal-test")).toThrow(/not a reopenable/);
    } finally {
      db.close();
    }
  });

  it("refuses to reopen a live (open) goal", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      expect(() => repo.reopenSession("goal-test")).toThrow(/not a reopenable/);
    } finally {
      db.close();
    }
  });

  it("refuses to reopen a diverging goal (would immediately re-diverge)", () => {
    // divergence triggers derive from immutable history; reopen only extends
    // iteration/review/rerun budgets, so a reopened diverging goal would re-fire
    // `diverging` at once. Reopening it needs a divergence-budget design.
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "diverging", "finding churn");
      expect(() => repo.reopenSession("goal-test")).toThrow(/not a reopenable/);
    } finally {
      db.close();
    }
  });
});
