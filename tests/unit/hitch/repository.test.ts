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
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import {
  DEFAULT_HITCH_POLICY,
  HARNESS_ORIGIN_FINDING_SOURCES,
  type HitchCloseCondition,
  type HitchFindingSource,
  type HitchPolicy,
  type HitchScope,
} from "../../../src/hitch/types.js";

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

function addFinding(
  repo: HitchRepository,
  input: {
    source: HitchFindingSource;
    sourceCycleId?: string;
    summary: string;
    duplicateOf?: string;
  },
) {
  return repo.upsertFinding({
    hitchId: "goal-test",
    source: input.source,
    sourceCycleId: input.sourceCycleId,
    duplicateOf: input.duplicateOf,
    severity: "P2",
    category: "correctness",
    scopeStatus: "out_of_scope",
    summary: input.summary,
  }).finding;
}

function seedRun(
  db: ReturnType<typeof openDb>,
  input: {
    runId: string;
    prUrl?: string | null;
    prNumber?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch, status,
       pr_url, pr_number, updated_at)
     VALUES (?, 'repo', 'goal', 'domain-coding', 'main', 'approved', ?, ?,
       '2026-06-13T00:00:00.000Z')`,
  ).run(input.runId, input.prUrl ?? null, input.prNumber ?? null);
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

  it("rejects invalid close conditions at the createSession choke point", () => {
    const { db, repo } = freshRepo();
    try {
      expect(() =>
        repo.createSession({
          hitchId: "hitch-invalid-close",
          title: "Invalid close condition",
          scope: {},
          closeConditions: [
            {
              id: "deploy",
              kind: "operation_status",
              required: true,
              metadata: {},
            },
          ],
          createdBy: "test",
          createdSource: "cli",
        }),
      ).toThrow(/operation_status_missing_operation_id/);
      expect(repo.getSession("hitch-invalid-close")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("rejects invalid scope at the createSession choke point", () => {
    const { db, repo } = freshRepo();
    try {
      expect(() =>
        repo.createSession({
          hitchId: "hitch-invalid-scope",
          title: "Invalid scope",
          scope: { targetFiles: [123] } as never,
          closeConditions: [],
          createdBy: "test",
          createdSource: "cli",
        }),
      ).toThrow();
      expect(repo.getSession("hitch-invalid-scope")).toBeNull();
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

  it("reports source-aware harness-origin divergence metrics", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const cycle1 = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-05-26T00:01:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle1.cycleId,
        findingsNew: 4,
        completedAt: "2026-05-26T00:01:30.000Z",
      });
      const cycle2 = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 2,
        reviewMode: "delta",
        createdAt: "2026-05-26T00:02:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle2.cycleId,
        findingsNew: 5,
        completedAt: "2026-05-26T00:02:30.000Z",
      });

      const review = addFinding(repo, {
        source: "review",
        sourceCycleId: cycle1.cycleId,
        summary: "review finding",
      });
      addFinding(repo, {
        source: "test",
        sourceCycleId: cycle1.cycleId,
        summary: "test finding",
      });
      addFinding(repo, {
        source: "doctor",
        sourceCycleId: cycle2.cycleId,
        summary: "doctor finding",
      });
      const codex = addFinding(repo, {
        source: "codex",
        sourceCycleId: cycle2.cycleId,
        summary: "codex finding",
      });
      addFinding(repo, {
        source: "other",
        sourceCycleId: cycle2.cycleId,
        summary: "other finding",
      });
      addFinding(repo, {
        source: "human",
        sourceCycleId: cycle1.cycleId,
        summary: "human finding",
      });
      const human = addFinding(repo, {
        source: "human",
        sourceCycleId: cycle2.cycleId,
        summary: "human reopened finding",
      });
      addFinding(repo, {
        source: "mcp",
        sourceCycleId: cycle2.cycleId,
        summary: "mcp finding",
      });
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        sourceCycleId: cycle1.cycleId,
        severity: "P2",
        category: "correctness",
        scopeStatus: "duplicate",
        summary: "duplicate review finding",
        duplicateOf: review.findingId,
      });

      for (let i = 0; i < 3; i += 1) {
        repo.markFindingFixed({ findingId: codex.findingId });
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "codex",
          sourceCycleId: cycle2.cycleId,
          severity: "P2",
          category: "correctness",
          scopeStatus: "in_scope",
          summary: "codex finding",
        });
      }
      for (let i = 0; i < 4; i += 1) {
        repo.markFindingFixed({ findingId: human.findingId });
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "human",
          sourceCycleId: cycle2.cycleId,
          severity: "P2",
          category: "correctness",
          scopeStatus: "out_of_scope",
          summary: "human reopened finding",
        });
      }

      const metrics = repo.harnessOriginDivergenceMetrics("goal-test");

      expect(metrics.harnessOriginNewFindings).toBe(
        HARNESS_ORIGIN_FINDING_SOURCES.length,
      );
      expect(metrics.harnessOriginMaxReopenCount).toBe(3);
      expect(metrics.harnessOriginNewFindingsByCycle).toEqual([
        {
          cycleId: cycle1.cycleId,
          cycleNumber: 1,
          findingsNew: 2,
        },
        {
          cycleId: cycle2.cycleId,
          cycleNumber: 2,
          findingsNew: 3,
        },
      ]);
    } finally {
      db.close();
    }
  });

  describe("#283: non-actionable advisory categories excluded from divergence churn", () => {
    function seedTwoCycles(repo: HitchRepository) {
      createGoal(repo);
      const cycle1 = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-05-26T00:01:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle1.cycleId,
        findingsNew: 1,
        completedAt: "2026-05-26T00:01:30.000Z",
      });
      const cycle2 = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 2,
        reviewMode: "delta",
        createdAt: "2026-05-26T00:02:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle2.cycleId,
        findingsNew: 1,
        completedAt: "2026-05-26T00:02:30.000Z",
      });
      // cycle1: a genuine actionable finding (counts).
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        sourceCycleId: cycle1.cycleId,
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary: "real cycle1 finding",
      });
      return { cycle1, cycle2 };
    }

    it("does NOT count a review-non-blocking-comment advisory toward the churn counter", () => {
      const { db, repo } = freshRepo();
      try {
        const { cycle1, cycle2 } = seedTwoCycles(repo);
        // cycle2: ONLY an approval/positive advisory (review-non-blocking-comment).
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: cycle2.cycleId,
          severity: "P2",
          category: "review-non-blocking-comment",
          scopeStatus: "out_of_scope",
          summary: "The diff addresses the consensus guard cleanly.",
        });

        const metrics = repo.harnessOriginDivergenceMetrics("goal-test");

        expect(metrics.harnessOriginNewFindings).toBe(1);
        expect(metrics.harnessOriginNewFindingsByCycle).toEqual([
          { cycleId: cycle1.cycleId, cycleNumber: 1, findingsNew: 1 },
          { cycleId: cycle2.cycleId, cycleNumber: 2, findingsNew: 0 },
        ]);
      } finally {
        db.close();
      }
    });

    it("does NOT count a review-out-of-scope-suggestion advisory toward the churn counter", () => {
      const { db, repo } = freshRepo();
      try {
        const { cycle1, cycle2 } = seedTwoCycles(repo);
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: cycle2.cycleId,
          severity: "P2",
          category: "review-out-of-scope-suggestion",
          scopeStatus: "out_of_scope",
          summary: "Consider extracting this helper in a follow-up.",
        });

        const metrics = repo.harnessOriginDivergenceMetrics("goal-test");

        expect(metrics.harnessOriginNewFindings).toBe(1);
        expect(metrics.harnessOriginNewFindingsByCycle).toEqual([
          { cycleId: cycle1.cycleId, cycleNumber: 1, findingsNew: 1 },
          { cycleId: cycle2.cycleId, cycleNumber: 2, findingsNew: 0 },
        ]);
      } finally {
        db.close();
      }
    });

    it("STILL counts a genuine ACTIONABLE out_of_scope P2 finding (filter is category-based, not scope-based)", () => {
      const { db, repo } = freshRepo();
      try {
        const { cycle1, cycle2 } = seedTwoCycles(repo);
        // out_of_scope + P2 but an ACTIONABLE category → must still count.
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: cycle2.cycleId,
          severity: "P2",
          category: "correctness",
          scopeStatus: "out_of_scope",
          summary: "genuine out-of-scope correctness churn",
        });

        const metrics = repo.harnessOriginDivergenceMetrics("goal-test");

        expect(metrics.harnessOriginNewFindings).toBe(2);
        expect(metrics.harnessOriginNewFindingsByCycle).toEqual([
          { cycleId: cycle1.cycleId, cycleNumber: 1, findingsNew: 1 },
          { cycleId: cycle2.cycleId, cycleNumber: 2, findingsNew: 1 },
        ]);
      } finally {
        db.close();
      }
    });

    it("STILL counts review-required-change / review-negative-decision blockers", () => {
      const { db, repo } = freshRepo();
      try {
        const { cycle1, cycle2 } = seedTwoCycles(repo);
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: cycle2.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "blocking required change",
        });

        const metrics = repo.harnessOriginDivergenceMetrics("goal-test");

        expect(metrics.harnessOriginNewFindings).toBe(2);
        expect(metrics.harnessOriginNewFindingsByCycle).toEqual([
          { cycleId: cycle1.cycleId, cycleNumber: 1, findingsNew: 1 },
          { cycleId: cycle2.cycleId, cycleNumber: 2, findingsNew: 1 },
        ]);
      } finally {
        db.close();
      }
    });
  });

  // #278: auto-resolution flips lifecycle_status open->fixed only; it must NOT
  // erase the divergence audit ledger (source / source_cycle_id rows are
  // preserved), so the cumulative/per-cycle circuit-breaker (#196/#280) stays
  // intact.
  it("#278: resolveSupersededReviewFindings preserves the divergence ledger (lifecycle change only)", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const cycle1 = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-05-26T00:01:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle1.cycleId,
        findingsNew: 1,
        completedAt: "2026-05-26T00:01:30.000Z",
      });
      const cycle2 = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 2,
        reviewMode: "delta",
        createdAt: "2026-05-26T00:02:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle2.cycleId,
        findingsNew: 0,
        completedAt: "2026-05-26T00:02:30.000Z",
      });
      const blocker = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        sourceCycleId: cycle1.cycleId,
        severity: "P1",
        category: "review-required-change",
        scopeStatus: "in_scope",
        summary: "blocking required change from cycle 1",
      }).finding;

      const before = repo.harnessOriginDivergenceMetrics("goal-test");
      expect(before.harnessOriginNewFindings).toBe(1);

      const resolved = repo.resolveSupersededReviewFindings({
        hitchId: "goal-test",
        supersedingCycleId: cycle2.cycleId,
        categories: ["review-required-change", "review-negative-decision"],
        decisionRunId: "run-approve",
        resolvedAt: "2026-05-26T00:03:00.000Z",
      });
      expect(resolved.map((f) => f.findingId)).toEqual([blocker.findingId]);
      expect(repo.requireFinding(blocker.findingId).lifecycleStatus).toBe(
        "fixed",
      );

      // Ledger preserved: cumulative total and the ORIGINAL cycle's churn count
      // are unchanged after the lifecycle flip.
      const after = repo.harnessOriginDivergenceMetrics("goal-test");
      expect(after.harnessOriginNewFindings).toBe(1);
      expect(after.harnessOriginNewFindingsByCycle).toEqual([
        { cycleId: cycle1.cycleId, cycleNumber: 1, findingsNew: 1 },
        { cycleId: cycle2.cycleId, cycleNumber: 2, findingsNew: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  // #278: STRICT allowlist edges at the repository boundary (fail-closed).
  describe("#278: resolveSupersededReviewFindings strict allowlist (fail-closed)", () => {
    function seedEarlierCycle(repo: HitchRepository) {
      createGoal(repo, { hitchId: "goal-test" });
      const earlier = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
      });
      repo.completeReviewCycle({ cycleId: earlier.cycleId, findingsNew: 1 });
      const superseding = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 2,
        reviewMode: "delta",
      });
      repo.completeReviewCycle({ cycleId: superseding.cycleId, findingsNew: 0 });
      return { earlier, superseding };
    }

    function resolve(repo: HitchRepository, supersedingCycleId: string) {
      return repo.resolveSupersededReviewFindings({
        hitchId: "goal-test",
        supersedingCycleId,
        categories: ["review-required-change", "review-negative-decision"],
        decisionRunId: "run-approve",
      });
    }

    it("never resolves a P0 review-required-change (defensive severity guard)", () => {
      const { db, repo } = freshRepo();
      try {
        const { earlier, superseding } = seedEarlierCycle(repo);
        const p0 = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: earlier.cycleId,
          severity: "P0",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "a P0 review blocker must never auto-resolve",
        }).finding;

        expect(resolve(repo, superseding.cycleId)).toEqual([]);
        expect(repo.requireFinding(p0.findingId).lifecycleStatus).toBe("open");
      } finally {
        db.close();
      }
    });

    it("never resolves when the approving run is NOT the hitch's current coding-run target", () => {
      const { db, repo } = freshRepo();
      try {
        const { earlier, superseding } = seedEarlierCycle(repo);
        // The hitch's current review target is run-current (latest coding attempt),
        // but the approve (resolve helper) is for run-approve — a stale/foreign run.
        repo.createAttempt({
          hitchId: "goal-test",
          attemptType: "implement",
          status: "succeeded",
          runId: "run-current",
        });
        const blocker = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: earlier.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "blocker that a non-current run's approve must not retire",
        }).finding;

        expect(resolve(repo, superseding.cycleId)).toEqual([]);
        expect(repo.requireFinding(blocker.findingId).lifecycleStatus).toBe(
          "open",
        );

        // Sanity: when the approve IS for the current target run, it resolves.
        const resolved = repo.resolveSupersededReviewFindings({
          hitchId: "goal-test",
          supersedingCycleId: superseding.cycleId,
          categories: ["review-required-change", "review-negative-decision"],
          decisionRunId: "run-current",
        });
        expect(resolved.map((f) => f.findingId)).toEqual([blocker.findingId]);
        expect(repo.requireFinding(blocker.findingId).lifecycleStatus).toBe(
          "fixed",
        );
      } finally {
        db.close();
      }
    });

    it("never resolves a duplicate child row (duplicate_of IS NOT NULL guard)", () => {
      const { db, repo } = freshRepo();
      try {
        const { earlier, superseding } = seedEarlierCycle(repo);
        const canonical = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: earlier.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "canonical blocker",
          filePath: "src/a.ts",
        }).finding;
        const dup = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: earlier.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "duplicate",
          duplicateOf: canonical.findingId,
          summary: "duplicate of canonical blocker",
          filePath: "src/b.ts",
        }).finding;
        expect(repo.requireFinding(dup.findingId).duplicateOf).toBe(
          canonical.findingId,
        );

        const resolved = resolve(repo, superseding.cycleId);
        // Only the in-scope canonical resolves; the duplicate child is never touched.
        expect(resolved.map((f) => f.findingId)).toEqual([canonical.findingId]);
        expect(repo.requireFinding(dup.findingId).lifecycleStatus).not.toBe(
          "fixed",
        );
      } finally {
        db.close();
      }
    });

    it("never resolves a review blocker with a NULL source_cycle_id (cannot prove earlier — fail-closed)", () => {
      const { db, repo } = freshRepo();
      try {
        const { superseding } = seedEarlierCycle(repo);
        // Manual CLI path: a `--source review` finding with NO --source-cycle-id.
        const nullCycle = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "review blocker with no source cycle id",
        }).finding;
        expect(nullCycle.sourceCycleId).toBeNull();

        expect(resolve(repo, superseding.cycleId)).toEqual([]);
        expect(repo.requireFinding(nullCycle.findingId).lifecycleStatus).toBe(
          "open",
        );
      } finally {
        db.close();
      }
    });

    it("never resolves when the superseding cycle id does not exist for the hitch (fail-closed)", () => {
      const { db, repo } = freshRepo();
      try {
        const { earlier } = seedEarlierCycle(repo);
        const blocker = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: earlier.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "earlier blocker, but superseding cycle is bogus",
        }).finding;

        const resolved = repo.resolveSupersededReviewFindings({
          hitchId: "goal-test",
          supersedingCycleId: "cycle-does-not-exist",
          categories: ["review-required-change", "review-negative-decision"],
          decisionRunId: "run-approve",
        });
        expect(resolved).toEqual([]);
        expect(repo.requireFinding(blocker.findingId).lifecycleStatus).toBe(
          "open",
        );
      } finally {
        db.close();
      }
    });

    it("drops a disallowed category even if the caller passes it in (allowlist enforced inside the repo)", () => {
      const { db, repo } = freshRepo();
      try {
        const { earlier, superseding } = seedEarlierCycle(repo);
        const advisory = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: earlier.cycleId,
          severity: "P1",
          category: "review-non-blocking-comment",
          scopeStatus: "in_scope",
          summary: "advisory comment misclassified as a caller-supplied category",
        }).finding;

        // Caller mistakenly passes a non-blocking category; the repo must drop it.
        const resolved = repo.resolveSupersededReviewFindings({
          hitchId: "goal-test",
          supersedingCycleId: superseding.cycleId,
          categories: ["review-non-blocking-comment"],
          decisionRunId: "run-approve",
        });
        expect(resolved).toEqual([]);
        expect(repo.requireFinding(advisory.findingId).lifecycleStatus).toBe(
          "open",
        );
      } finally {
        db.close();
      }
    });
  });

  // #278 (codex P2): the resolution_note audit record must name the CURRENT
  // superseding cycle, even after a reopen->re-approve. A STALE prior auto-resolve
  // note is refreshed; a genuine operator note is preserved.
  describe("#278: resolveSupersededReviewFindings audit-note refresh", () => {
    function startCompleteCycle(
      repo: HitchRepository,
      cycleNumber: number,
      at: string,
    ) {
      const cycle = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber,
        reviewMode: cycleNumber === 1 ? "initial" : "delta",
        createdAt: at,
      });
      repo.completeReviewCycle({ cycleId: cycle.cycleId, findingsNew: 0 });
      return cycle;
    }

    it("refreshes a STALE prior auto-resolve note to the current superseding cycle on reopen->re-approve", () => {
      const { db, repo } = freshRepo();
      try {
        createGoal(repo, { hitchId: "goal-test" });
        const cycle1 = startCompleteCycle(repo, 1, "2026-05-26T00:01:00.000Z");
        const cycle2 = startCompleteCycle(repo, 2, "2026-05-26T00:02:00.000Z");

        // cycle1: a blocking required change.
        const seed = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: cycle1.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "stable blocker text",
          filePath: "src/x.ts",
        }).finding;

        // cycle2 approve auto-resolves -> note names cycle2.
        repo.resolveSupersededReviewFindings({
          hitchId: "goal-test",
          supersedingCycleId: cycle2.cycleId,
          categories: ["review-required-change", "review-negative-decision"],
          decisionRunId: "run-approve-2",
        });
        const afterC2 = repo.requireFinding(seed.findingId);
        expect(afterC2.lifecycleStatus).toBe("fixed");
        expect(afterC2.resolutionNote).toContain(cycle2.cycleId);

        // cycle3: the same blocker is re-raised (fixed->reopened, same stable_key).
        startCompleteCycle(repo, 3, "2026-05-26T00:03:00.000Z");
        const reopened = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: cycle1.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "stable blocker text",
          filePath: "src/x.ts",
        }).finding;
        expect(reopened.findingId).toBe(seed.findingId);
        expect(reopened.lifecycleStatus).toBe("reopened");

        // cycle4 approve re-resolves -> note MUST name cycle4, not the stale cycle2.
        const cycle4 = startCompleteCycle(repo, 4, "2026-05-26T00:04:00.000Z");
        repo.resolveSupersededReviewFindings({
          hitchId: "goal-test",
          supersedingCycleId: cycle4.cycleId,
          categories: ["review-required-change", "review-negative-decision"],
          decisionRunId: "run-approve-4",
        });
        const afterC4 = repo.requireFinding(seed.findingId);
        expect(afterC4.lifecycleStatus).toBe("fixed");
        expect(afterC4.resolutionNote).toContain(cycle4.cycleId);
        expect(afterC4.resolutionNote).toContain("run-approve-4");
        expect(afterC4.resolutionNote).not.toContain(cycle2.cycleId);
      } finally {
        db.close();
      }
    });

    it("PRESERVES a genuine operator-authored resolution_note", () => {
      const { db, repo } = freshRepo();
      try {
        createGoal(repo, { hitchId: "goal-test" });
        const cycle1 = startCompleteCycle(repo, 1, "2026-05-26T00:01:00.000Z");
        const cycle2 = startCompleteCycle(repo, 2, "2026-05-26T00:02:00.000Z");
        const blocker = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: cycle1.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "operator-noted blocker",
        }).finding;
        // Operator records a manual note (markFindingFixed then reopen, simulating
        // an operator-authored note that must survive a later auto-resolve).
        repo.markFindingFixed({
          findingId: blocker.findingId,
          note: "operator: verified fixed in commit abc123",
        });
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          sourceCycleId: cycle1.cycleId,
          severity: "P1",
          category: "review-required-change",
          scopeStatus: "in_scope",
          summary: "operator-noted blocker",
        });
        expect(repo.requireFinding(blocker.findingId).lifecycleStatus).toBe(
          "reopened",
        );

        repo.resolveSupersededReviewFindings({
          hitchId: "goal-test",
          supersedingCycleId: cycle2.cycleId,
          categories: ["review-required-change", "review-negative-decision"],
          decisionRunId: "run-approve-2",
        });
        const after = repo.requireFinding(blocker.findingId);
        expect(after.lifecycleStatus).toBe("fixed");
        // Operator note preserved; NOT overwritten by the auto-resolve note.
        expect(after.resolutionNote).toBe(
          "operator: verified fixed in commit abc123",
        );
        expect(after.resolutionNote).not.toContain("auto-resolved");
      } finally {
        db.close();
      }
    });
  });

  it("keeps first-seen divergence origin immutable on duplicate upsert", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const cycle1 = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 1,
        reviewMode: "initial",
        createdAt: "2026-05-26T00:02:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle1.cycleId,
        findingsNew: 1,
        completedAt: "2026-05-26T00:02:30.000Z",
      });
      const cycle2 = repo.startReviewCycle({
        hitchId: "goal-test",
        cycleNumber: 2,
        reviewMode: "delta",
        createdAt: "2026-05-26T00:01:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle2.cycleId,
        findingsNew: 1,
        completedAt: "2026-05-26T00:01:30.000Z",
      });

      const first = addFinding(repo, {
        source: "review",
        sourceCycleId: cycle1.cycleId,
        summary: "origin must stay review",
      });
      const second = repo.upsertFinding({
        hitchId: "goal-test",
        source: "human",
        sourceCycleId: cycle2.cycleId,
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary: "origin must stay review",
      });

      expect(second.created).toBe(false);
      const finding = repo.requireFinding(first.findingId);
      expect(finding.source).toBe("review");
      expect(finding.sourceCycleId).toBe(cycle1.cycleId);
      expect(repo.harnessOriginDivergenceMetrics("goal-test")).toMatchObject({
        harnessOriginNewFindings: 1,
        harnessOriginNewFindingsByCycle: [
          {
            cycleId: cycle1.cycleId,
            cycleNumber: 1,
            findingsNew: 1,
          },
          {
            cycleId: cycle2.cycleId,
            cycleNumber: 2,
            findingsNew: 0,
          },
        ],
      });
    } finally {
      db.close();
    }
  });

  it("counts only harness-origin driven reopens for harness divergence churn", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const direct = addFinding(repo, {
        source: "review",
        summary: "operator direct reopen",
      });
      const duplicateCanonical = addFinding(repo, {
        source: "review",
        summary: "operator duplicate reopen canonical record",
      });

      for (let i = 0; i < 3; i += 1) {
        repo.markFindingFixed({ findingId: direct.findingId });
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "human",
          severity: "P2",
          category: "correctness",
          scopeStatus: "in_scope",
          summary: "operator direct reopen",
        });

        repo.markFindingFixed({ findingId: duplicateCanonical.findingId });
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "human",
          severity: "P2",
          category: "correctness",
          scopeStatus: "in_scope",
          summary: "operator duplicate reopen canonical record again",
        });
      }

      expect(repo.requireFinding(direct.findingId)).toMatchObject({
        source: "review",
        lifecycleStatus: "reopened",
        reopenCount: 0,
      });
      expect(repo.requireFinding(duplicateCanonical.findingId)).toMatchObject({
        source: "review",
        lifecycleStatus: "reopened",
        reopenCount: 0,
      });
      expect(
        repo.harnessOriginDivergenceMetrics("goal-test")
          .harnessOriginMaxReopenCount,
      ).toBe(0);

      for (let i = 0; i < 3; i += 1) {
        repo.markFindingFixed({ findingId: direct.findingId });
        repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P2",
          category: "correctness",
          scopeStatus: "in_scope",
          summary: "operator direct reopen",
        });
      }

      expect(repo.requireFinding(direct.findingId).reopenCount).toBe(3);
      expect(
        repo.harnessOriginDivergenceMetrics("goal-test")
          .harnessOriginMaxReopenCount,
      ).toBe(3);
    } finally {
      db.close();
    }
  });

  it("discardAttempt is idempotent and recomputes current_iteration", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "implement",
      });
      const second = repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
      });
      expect(repo.requireSession("goal-test").currentIteration).toBe(2);

      repo.discardAttempt(second.attemptId, "2026-06-12T00:00:00.000Z");
      expect(repo.listAttempts("goal-test").map((a) => a.attemptId)).toEqual([
        first.attemptId,
      ]);
      expect(repo.requireSession("goal-test").currentIteration).toBe(1);

      expect(() =>
        repo.discardAttempt(second.attemptId, "2026-06-12T00:00:01.000Z"),
      ).not.toThrow();
      expect(repo.listAttempts("goal-test").map((a) => a.attemptId)).toEqual([
        first.attemptId,
      ]);
      expect(repo.requireSession("goal-test").currentIteration).toBe(1);

      repo.discardAttempt(first.attemptId, "2026-06-12T00:00:02.000Z");
      expect(repo.listAttempts("goal-test")).toEqual([]);
      expect(repo.requireSession("goal-test").currentIteration).toBe(0);
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

  it.each([
    ["out_of_scope", "out_of_scope"],
    ["deferred", "in_scope"],
    ["accepted_risk", "in_scope"],
    ["fixed", "in_scope"],
  ] as const)(
    "promotes exact stable-key %s canonicals when an open blocker returns",
    (lifecycleStatus, scopeStatus) => {
      const { db, repo } = freshRepo();
      try {
        createGoal(repo);
        const first = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P2",
          category: "correctness",
          scopeStatus,
          lifecycleStatus,
          summary: "Repository exact dedup must not hide returning blocker",
        });

        const duplicate = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P1",
          category: "correctness",
          scopeStatus: "in_scope",
          lifecycleStatus: "open",
          summary: "Repository exact dedup must not hide returning blocker",
        });

        expect(duplicate).toMatchObject({
          created: false,
          reopened: true,
        });
        expect(repo.requireFinding(first.finding.findingId)).toMatchObject({
          scopeStatus: "in_scope",
          lifecycleStatus: "reopened",
          severity: "P1",
          reopenCount: 1,
        });
        expect(repo.countFindingSummary("goal-test")).toMatchObject({
          openInScopeP1: 1,
        });
      } finally {
        db.close();
      }
    },
  );

  it("does not downgrade escalated exact canonicals to reopened when an open blocker returns", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "escalated",
        summary: "Repository exact dedup must not downgrade escalated blockers",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary: "Repository exact dedup must not downgrade escalated blockers",
      });

      expect(duplicate).toMatchObject({
        created: false,
        reopened: false,
      });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "escalated",
        severity: "P1",
        reopenCount: 0,
      });
    } finally {
      db.close();
    }
  });

  it("does not increment exact stable-key promotion reopen counts for operator-origin findings", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "accepted_risk",
        summary: "Operator reported blocker should reopen without divergence churn",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "human",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary: "Operator reported blocker should reopen without divergence churn",
      });

      expect(duplicate.reopened).toBe(true);
      expect(repo.requireFinding(first.finding.findingId)).toMatchObject({
        lifecycleStatus: "reopened",
        reopenCount: 0,
      });
      expect(repo.countFindingSummary("goal-test")).toMatchObject({
        openInScopeP1: 1,
      });
    } finally {
      db.close();
    }
  });

  it("does not demote exact stable-key canonicals for non-blocking incoming findings", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary: "Repository exact dedup keeps existing blockers blocking",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P3",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary: "Repository exact dedup keeps existing blockers blocking",
      });

      expect(duplicate).toMatchObject({
        created: false,
        reopened: false,
      });
      expect(repo.requireFinding(first.finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        severity: "P1",
      });
      expect(repo.countFindingSummary("goal-test")).toMatchObject({
        openInScopeP1: 1,
      });
    } finally {
      db.close();
    }
  });

  it("does not reopen a fixed exact canonical for non-blocking repeats", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "fixed",
        summary:
          "Repository exact dedup keeps fixed advisory repeats out of the blocker set",
      });

      const repeat = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
        summary:
          "Repository exact dedup keeps fixed advisory repeats out of the blocker set",
      });

      expect(repeat).toMatchObject({ created: false, reopened: false });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "out_of_scope",
        lifecycleStatus: "fixed",
        reopenCount: 0,
      });
    } finally {
      db.close();
    }
  });

  it("retains paraphrased near duplicates as duplicate audit rows", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P0",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Review import uses only summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
      });

      expect(duplicate.created).toBe(true);
      expect(duplicate.finding).toMatchObject({
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
        duplicateOf: first.finding.findingId,
        severity: "P0",
      });
      expect(duplicate.finding.classificationReason).toMatch(
        /near-duplicate of/,
      );
      expect(repo.requireFinding(first.finding.findingId)).toMatchObject({
        severity: "P0",
        reopenCount: 0,
      });
    } finally {
      db.close();
    }
  });

  it("reopens a fixed canonical for near duplicates without inflating reopen counts", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary:
          "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle",
      });
      repo.markFindingFixed({ findingId: first.finding.findingId });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary:
          "Review import uses only summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
      });

      expect(duplicate).toMatchObject({
        created: true,
        reopened: true,
      });
      expect(repo.requireFinding(first.finding.findingId)).toMatchObject({
        lifecycleStatus: "reopened",
        severity: "P1",
        reopenCount: 0,
      });
      expect(repo.maxFindingReopenCount("goal-test")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("does not reopen a fixed near-duplicate canonical for non-blocking repeats", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary:
          "Review import keeps fixed advisory canonical rows stable when paraphrased repeats arrive",
      });
      repo.markFindingFixed({ findingId: canonical.finding.findingId });

      const repeat = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
        summary:
          "Review import keeps fixed advisory canonical rows stable when paraphrase repeats arrive",
      });

      expect(repeat).toMatchObject({ created: true, reopened: false });
      expect(repeat.finding).toMatchObject({
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
        duplicateOf: canonical.finding.findingId,
      });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "out_of_scope",
        lifecycleStatus: "fixed",
        reopenCount: 0,
      });
    } finally {
      db.close();
    }
  });

  it("promotes out-of-scope near-duplicate canonicals when an in-scope blocker returns", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const outOfScope = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary:
          "Review import uses summary text for finding identity and paraphrased reviewer findings create new findings every cycle",
      });

      const inScope = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Review import uses summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
      });

      expect(inScope.created).toBe(true);
      expect(inScope.finding).toMatchObject({
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
        duplicateOf: outOfScope.finding.findingId,
      });
      expect(repo.requireFinding(outOfScope.finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "reopened",
        severity: "P1",
        reopenCount: 1,
      });
      expect(repo.countFindingSummary("goal-test")).toMatchObject({
        openInScopeP1: 1,
      });
    } finally {
      db.close();
    }
  });

  it.each([
    ["out_of_scope", "out_of_scope", 1],
    ["deferred", "in_scope", 1],
    ["accepted_risk", "in_scope", 1],
    ["fixed", "in_scope", 0],
  ] as const)(
    "promotes near-duplicate %s canonicals when an open blocker returns",
    (lifecycleStatus, scopeStatus, reopenCount) => {
      const { db, repo } = freshRepo();
      try {
        createGoal(repo);
        const canonical = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P2",
          category: "correctness",
          scopeStatus,
          lifecycleStatus,
          summary:
            "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle",
        });

        const duplicate = repo.upsertFinding({
          hitchId: "goal-test",
          source: "review",
          severity: "P1",
          category: "correctness",
          scopeStatus: "in_scope",
          lifecycleStatus: "open",
          summary:
            "Review import uses only summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
        });

        expect(duplicate.finding).toMatchObject({
          scopeStatus: "duplicate",
          lifecycleStatus: "duplicate",
          duplicateOf: canonical.finding.findingId,
        });
        expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
          scopeStatus: "in_scope",
          lifecycleStatus: "reopened",
          severity: "P1",
          reopenCount,
        });
        expect(repo.countFindingSummary("goal-test")).toMatchObject({
          openInScopeP1: 1,
        });
      } finally {
        db.close();
      }
    },
  );

  it("does not downgrade escalated near-duplicate canonicals to reopened when an open blocker returns", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "escalated",
        summary:
          "Review import must keep escalated canonical lifecycle when paraphrased blockers return every cycle",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary:
          "Review import must keep escalated canonical lifecycle when paraphrased blockers return each cycle",
      });

      expect(duplicate.finding).toMatchObject({
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
        duplicateOf: canonical.finding.findingId,
      });
      expect(duplicate.reopened).toBe(false);
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "escalated",
        severity: "P1",
        reopenCount: 0,
      });
    } finally {
      db.close();
    }
  });

  it("reopens exact canonicals for unknown-scope close blockers", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.recordCloseCheck({
        hitchId: "goal-test",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "accepted_risk",
        summary:
          "Canonical dedup must not hide unknown scope review blockers behind accepted risk",
        detail: "Older accepted-risk wording",
      });

      const incoming = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "unknown",
        lifecycleStatus: "open",
        summary:
          "Canonical dedup must not hide unknown scope review blockers behind accepted risk",
        detail: "Latest unknown-scope blocker wording",
      });

      expect(incoming).toMatchObject({ created: false, reopened: true });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "unknown",
        lifecycleStatus: "reopened",
        severity: "P1",
        summary:
          "Canonical dedup must not hide unknown scope review blockers behind accepted risk",
        detail: "Latest unknown-scope blocker wording",
      });
      expect(new ConvergenceService(repo).evaluate("goal-test").decision).toBe(
        "needs_classification",
      );
    } finally {
      db.close();
    }
  });

  it("does not promote canonicals for P3 or info incoming findings", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "accepted_risk",
        summary:
          "Canonical dedup keeps weak informational repeats out of the close blocker set",
        detail: "Original accepted-risk detail",
      });

      const incoming = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P3",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary:
          "Canonical dedup keeps weak informational repeats out of the close blocker set",
        detail: "Weaker incoming detail",
      });

      expect(incoming).toMatchObject({ created: false, reopened: false });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "out_of_scope",
        lifecycleStatus: "accepted_risk",
        severity: "P2",
        summary:
          "Canonical dedup keeps weak informational repeats out of the close blocker set",
        detail: "Original accepted-risk detail",
      });
    } finally {
      db.close();
    }
  });

  it("updates canonical text when near-duplicate promotion makes it blocking", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "accepted_risk",
        summary:
          "Canonical context keeps outdated accepted risk wording in coder rerun details",
        detail: "Old accepted-risk detail",
        filePath: "src/hitch/repository.ts",
        symbol: "promoteDuplicateCanonical",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary:
          "Canonical context keeps stale accepted risk wording in coder rerun details",
        detail: "Latest blocking detail",
        filePath: "src/hitch/repository.ts",
        symbol: "promoteDuplicateCanonical",
      });

      expect(duplicate.finding).toMatchObject({
        scopeStatus: "duplicate",
        duplicateOf: canonical.finding.findingId,
      });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "reopened",
        severity: "P1",
        summary:
          "Canonical context keeps stale accepted risk wording in coder rerun details",
        detail: "Latest blocking detail",
      });
    } finally {
      db.close();
    }
  });

  it("keeps canonical text when near-duplicate incoming is weaker", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary:
          "Canonical context keeps existing blocker wording when weaker repeats arrive",
        detail: "Original blocking detail",
        filePath: "src/hitch/repository.ts",
        symbol: "promoteDuplicateCanonical",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P3",
        category: "correctness",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
        summary:
          "Canonical context keeps current blocker wording when weaker repeats arrive",
        detail: "Weaker repeat detail",
        filePath: "src/hitch/repository.ts",
        symbol: "promoteDuplicateCanonical",
      });

      expect(duplicate.finding).toMatchObject({
        scopeStatus: "duplicate",
        duplicateOf: canonical.finding.findingId,
      });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        severity: "P1",
        summary:
          "Canonical context keeps existing blocker wording when weaker repeats arrive",
        detail: "Original blocking detail",
      });
    } finally {
      db.close();
    }
  });

  it("does not increment near-duplicate promotion reopen counts for operator-origin findings", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "accepted_risk",
        summary:
          "Review import deduplication may hide operator reported blockers behind accepted risk",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "human",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary:
          "Review import deduplication can hide operator reported blockers behind accepted risk",
      });

      expect(duplicate.finding).toMatchObject({
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
        duplicateOf: canonical.finding.findingId,
      });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        lifecycleStatus: "reopened",
        reopenCount: 0,
      });
    } finally {
      db.close();
    }
  });

  it("does not demote near-duplicate canonicals for non-blocking incoming findings", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const canonical = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        summary:
          "Review import deduplication must keep existing canonical blockers blocking",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P3",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary:
          "Review import deduplication should keep existing canonical blockers blocking",
      });

      expect(duplicate.finding).toMatchObject({
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
        duplicateOf: canonical.finding.findingId,
      });
      expect(repo.requireFinding(canonical.finding.findingId)).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        severity: "P1",
      });
      expect(repo.countFindingSummary("goal-test")).toMatchObject({
        openInScopeP1: 1,
      });
    } finally {
      db.close();
    }
  });

  it("deduplicates near duplicates while retaining duplicate audit rows", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary:
          "Review import uses summary text for finding identity and paraphrased reviewer findings create new findings every cycle",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary:
          "Review import uses summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
      });

      expect(duplicate.finding).toMatchObject({
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
        duplicateOf: first.finding.findingId,
      });
    } finally {
      db.close();
    }
  });

  it("keeps same-file near duplicates separate when symbols differ", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Repository close gate allows paraphrased reviewer findings to escape the close blocker count",
        filePath: "src/hitch/repository.ts",
        symbol: "countFindingSummary",
      });

      const second = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Repository close gate lets paraphrased reviewer findings escape the close blocker count",
        filePath: "src/hitch/repository.ts",
        symbol: "findNearDuplicateForInput",
      });

      expect(second.finding).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        duplicateOf: null,
      });
      expect(repo.countFindingSummary("goal-test")).toMatchObject({
        openInScopeP1: 2,
      });
    } finally {
      db.close();
    }
  });

  it("deduplicates same-file near duplicates with the same symbol", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const first = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Repository close gate allows paraphrased reviewer findings to escape the close blocker count",
        filePath: "src/hitch/repository.ts",
        symbol: "countFindingSummary",
      });

      const duplicate = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Repository close gate lets paraphrased reviewer findings escape the close blocker count",
        filePath: "src/hitch/repository.ts",
        symbol: "countFindingSummary",
      });

      expect(duplicate.finding).toMatchObject({
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
        duplicateOf: first.finding.findingId,
      });
    } finally {
      db.close();
    }
  });

  it("keeps near duplicates separate when meaningful numbers differ", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Close check timeout should remain 30s when waiting for review consensus",
      });

      const second = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Close check timeout should remain 5s when waiting for review consensus",
      });

      expect(second.finding).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        duplicateOf: null,
      });
      expect(repo.countFindingSummary("goal-test")).toMatchObject({
        openInScopeP1: 2,
      });
    } finally {
      db.close();
    }
  });

  it("skips near-duplicate matching for explicit stable keys", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle",
      });

      const explicit = repo.upsertFinding({
        hitchId: "goal-test",
        stableKey: "external-review:123:codex",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Review import uses only summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
      });

      expect(explicit.created).toBe(true);
      expect(explicit.finding).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        duplicateOf: null,
        stableKey: "external-review:123:codex",
      });
    } finally {
      db.close();
    }
  });

  it("skips near-duplicate matching when the policy knob is disabled", () => {
    const { db, repo } = freshRepo();
    try {
      repo.createSession({
        hitchId: "goal-test",
        title: "Goal convergence",
        projectId: "monorepo-harness",
        domain: "goal",
        policy: {
          ...DEFAULT_HITCH_POLICY,
          divergence: {
            ...DEFAULT_HITCH_POLICY.divergence,
            nearDuplicateDedup: false,
          },
        },
        createdBy: "test",
        createdSource: "cli",
      });
      repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle",
      });

      const second = repo.upsertFinding({
        hitchId: "goal-test",
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary:
          "Review import uses only summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
      });

      expect(second.created).toBe(true);
      expect(second.finding).toMatchObject({
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        duplicateOf: null,
      });
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
      expect(seenAgain.finding.scopeStatus).toBe("duplicate");
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

describe("adoptPr (#169)", () => {
  it("records an adopted PR event with the superseded run PR without rewriting runs", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo, { hitchId: "hitch-adopt" });
      seedRun(db, {
        runId: "run-old",
        prUrl: "https://github.com/acme/app/pull/7",
        prNumber: 7,
      });
      repo.createAttempt({
        hitchId: "hitch-adopt",
        attemptType: "implement",
        status: "succeeded",
        runId: "run-old",
      });

      const result = repo.adoptPr({
        hitchId: "hitch-adopt",
        prUrl: "https://github.com/acme/app/pull/42",
        prNumber: 42,
        reason: "operator takeover",
        createdBy: "operator",
        now: "2026-06-13T01:00:00.000Z",
      });
      expect(result.status).toBe("open");
      const run = db
        .prepare("SELECT pr_url, pr_number FROM runs WHERE run_id = 'run-old'")
        .get() as { pr_url: string; pr_number: number };
      expect(run).toEqual({
        pr_url: "https://github.com/acme/app/pull/7",
        pr_number: 7,
      });
      expect(repo.listLifecycleEvents("hitch-adopt")).toMatchObject([
        {
          event: "pr_adopted",
          reason: "operator takeover",
          createdBy: "operator",
          detail: {
            adoptedPr: {
              url: "https://github.com/acme/app/pull/42",
              number: 42,
            },
            supersededPr: {
              url: "https://github.com/acme/app/pull/7",
              number: 7,
            },
            runId: "run-old",
          },
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("records null supersededPr when the latest run has no PR", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo, { hitchId: "hitch-adopt-no-pr" });
      seedRun(db, { runId: "run-no-pr" });
      repo.createAttempt({
        hitchId: "hitch-adopt-no-pr",
        attemptType: "implement",
        status: "succeeded",
        runId: "run-no-pr",
      });

      repo.adoptPr({
        hitchId: "hitch-adopt-no-pr",
        prNumber: 52,
        reason: "operator takeover",
        createdBy: "operator",
      });
      expect(repo.listLifecycleEvents("hitch-adopt-no-pr")[0]?.detail).toEqual({
        adoptedPr: { url: null, number: 52 },
        supersededPr: null,
        runId: "run-no-pr",
      });
    } finally {
      db.close();
    }
  });
});

describe("updateSessionConfig (#142)", () => {
  const closeConditions: HitchCloseCondition[] = [
    { id: "typecheck", kind: "command", required: true, command: "npm run typecheck" },
  ];
  const broadScope: HitchScope = {
    targetFiles: ["src/**", "docs/**"],
    targetOperations: ["run", "review"],
    allowedFindingCategories: ["correctness", "security"],
    excludedCategories: ["future-feature"],
    targetSummary: "hitch convergence",
    notes: "initial",
  };

  function createUpdateGoal(repo: HitchRepository, hitchId = "hitch-update") {
    return repo.createSession({
      hitchId,
      title: "Update",
      scope: broadScope,
      closeConditions,
      policy: DEFAULT_HITCH_POLICY,
      createdBy: "test",
      createdSource: "cli",
      createdAt: "2026-06-13T00:00:00.000Z",
    });
  }

  it("updates close conditions and records previous config in an updated event", () => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo);
      const nextClose: HitchCloseCondition[] = [
        ...closeConditions,
        { id: "manual-ok", kind: "manual", required: true },
      ];
      const updated = repo.updateSessionConfig({
        hitchId: "hitch-update",
        closeConditions: nextClose,
        reason: "add manual signoff",
        createdBy: "operator",
        now: "2026-06-13T01:00:00.000Z",
      });
      expect(updated.closeConditions.map((c) => c.id)).toEqual([
        "typecheck",
        "manual-ok",
      ]);
      expect(updated.updatedAt).toBe("2026-06-13T01:00:00.000Z");
      expect(repo.listLifecycleEvents("hitch-update")).toMatchObject([
        {
          event: "updated",
          reason: "add manual signoff",
          detail: {
            updatedFields: ["closeConditions"],
            previousCloseConditions: closeConditions,
          },
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("allows scope narrowing and notes-only edits without --allow-scope-widen", () => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo);
      const updated = repo.updateSessionConfig({
        hitchId: "hitch-update",
        scope: {
          targetFiles: ["src/**"],
          targetOperations: ["run"],
          allowedFindingCategories: ["correctness"],
          excludedCategories: ["future-feature", "docs"],
          targetSummary: "hitch convergence",
          notes: "narrowed",
        },
        reason: "narrow to source work",
        createdBy: "operator",
      });
      expect(updated.scope).toMatchObject({
        targetFiles: ["src/**"],
        targetOperations: ["run"],
        allowedFindingCategories: ["correctness"],
        excludedCategories: ["future-feature", "docs"],
        targetSummary: "hitch convergence",
        notes: "narrowed",
      });
    } finally {
      db.close();
    }
  });

  it("allows dropping positive matchers (targetOperations/allowedFindingCategories) without --allow-scope-widen", () => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo);
      // drop the pure positive matchers — their sets shrink to ∅ (narrowing).
      // targetFiles (a gate), excludedCategories, and targetSummary are kept
      // unchanged: dropping the file gate or an exclusion would legitimately
      // widen, so those stay put to isolate the positive-matcher-drop case.
      const updated = repo.updateSessionConfig({
        hitchId: "hitch-update",
        scope: {
          targetFiles: ["src/**", "docs/**"],
          excludedCategories: ["future-feature"],
          targetSummary: "hitch convergence",
          notes: "doc-only pass",
        },
        reason: "drop matchers",
        createdBy: "operator",
      });
      expect(updated.scope.targetOperations).toBeUndefined();
      expect(updated.scope.allowedFindingCategories).toBeUndefined();
      expect(updated.scope.notes).toBe("doc-only pass");
    } finally {
      db.close();
    }
  });

  it("treats removing the targetFiles gate as widening (fail-closed)", () => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo); // baseline targetFiles: ["src/**", "docs/**"]
      // dropping targetFiles removes the out-of-scope gate, so findings outside
      // the old patterns can become in_scope — widening, requires the flag.
      const withoutFiles = {
        targetOperations: ["run", "review"],
        allowedFindingCategories: ["correctness", "security"],
        excludedCategories: ["future-feature"],
        targetSummary: "hitch convergence",
        notes: "drop the file gate",
      };
      expect(() =>
        repo.updateSessionConfig({
          hitchId: "hitch-update",
          scope: withoutFiles,
          reason: "drop gate",
          createdBy: "operator",
        }),
      ).toThrow(/scope widen/i);
      // tightening the gate to a subset is allowed (narrowing)
      expect(
        repo.updateSessionConfig({
          hitchId: "hitch-update",
          scope: { ...withoutFiles, targetFiles: ["src/**"] },
          reason: "tighten gate",
          createdBy: "operator",
        }).scope.targetFiles,
      ).toEqual(["src/**"]);
    } finally {
      db.close();
    }
  });

  it("allows non-gate policy updates without --allow-gate-loosen", () => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo);
      const nextPolicy: HitchPolicy = {
        ...DEFAULT_HITCH_POLICY,
        autoFixSeverities: ["P0", "P1"],
      };
      const updated = repo.updateSessionConfig({
        hitchId: "hitch-update",
        policy: nextPolicy,
        reason: "allow P0 autofix under operator control",
        createdBy: "operator",
      });
      expect(updated.policy.autoFixSeverities).toEqual(["P0", "P1"]);
    } finally {
      db.close();
    }
  });

  it.each([
    ["targetFiles", { ...broadScope, targetFiles: ["src/**", "docs/**", "tests/**"] }],
    ["targetOperations", { ...broadScope, targetOperations: ["run", "review", "merge"] }],
    [
      "allowedFindingCategories",
      {
        ...broadScope,
        allowedFindingCategories: ["correctness", "security", "performance"],
      },
    ],
    ["targetSummary", { ...broadScope, targetSummary: "hitch convergence and release" }],
  ] satisfies Array<[string, HitchScope]>)(
    "rejects %s widening unless --allow-scope-widen is set",
    (_field, scope) => {
      const { db, repo } = freshRepo();
      try {
        createUpdateGoal(repo);
        expect(() =>
          repo.updateSessionConfig({
            hitchId: "hitch-update",
            scope,
            reason: "widen",
            createdBy: "operator",
          }),
        ).toThrow(/scope widen/i);
        expect(
          repo.updateSessionConfig({
            hitchId: "hitch-update",
            scope,
            reason: "approved widen",
            allowScopeWiden: true,
            createdBy: "operator",
          }).scope,
        ).toEqual(scope);
      } finally {
        db.close();
      }
    },
  );

  it.each([
    ["allowedFindingCategories", { allowedFindingCategories: ["correctness"] }],
    ["targetOperations", { targetOperations: ["run"] }],
    ["targetFiles", { targetFiles: ["src/**"] }],
  ] satisfies Array<[string, HitchScope]>)(
    "treats adding %s from an undefined baseline as widening (fail-closed)",
    (_field, added) => {
      const { db, repo } = freshRepo();
      try {
        // baseline leaves the positive matcher fields undefined
        repo.createSession({
          hitchId: "hitch-min",
          title: "min",
          scope: { notes: "narrow start" },
          closeConditions,
          policy: DEFAULT_HITCH_POLICY,
          createdBy: "test",
          createdSource: "cli",
        });
        // undefined → non-empty matcher widens the in-scope surface, so it must
        // be rejected without --allow-scope-widen (the earlier bug let it pass)
        expect(() =>
          repo.updateSessionConfig({
            hitchId: "hitch-min",
            scope: { notes: "narrow start", ...added },
            reason: "widen from empty",
            createdBy: "operator",
          }),
        ).toThrow(/scope widen/i);
        expect(
          repo.updateSessionConfig({
            hitchId: "hitch-min",
            scope: { notes: "narrow start", ...added },
            reason: "approved widen",
            allowScopeWiden: true,
            createdBy: "operator",
          }).scope,
        ).toMatchObject(added);
      } finally {
        db.close();
      }
    },
  );

  it("requires --allow-gate-loosen when close conditions or policy relax the close gate", () => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo);
      expect(() =>
        repo.updateSessionConfig({
          hitchId: "hitch-update",
          closeConditions: [],
          reason: "remove typecheck",
          createdBy: "operator",
        }),
      ).toThrow(/gate loosen/i);
      expect(() =>
        repo.updateSessionConfig({
          hitchId: "hitch-update",
          policy: {
            ...DEFAULT_HITCH_POLICY,
            closeRequires: {
              ...DEFAULT_HITCH_POLICY.closeRequires,
              noOpenInScopeP1: false,
            },
          },
          reason: "allow P1",
          createdBy: "operator",
        }),
      ).toThrow(/gate loosen/i);

      const updated = repo.updateSessionConfig({
        hitchId: "hitch-update",
        closeConditions: [],
        reason: "operator accepts looser gate",
        allowGateLoosen: true,
        createdBy: "operator",
      });
      expect(updated.closeConditions).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("validates updated close conditions before writing config", () => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo);
      expect(() =>
        repo.updateSessionConfig({
          hitchId: "hitch-update",
          closeConditions: [
            {
              id: "deploy",
              kind: "operation_status",
              required: true,
              metadata: {},
            },
          ],
          reason: "invalid external gate",
          allowGateLoosen: true,
          createdBy: "operator",
        }),
      ).toThrow(/operation_status_missing_operation_id/);
      expect(repo.requireSession("hitch-update").closeConditions).toEqual(
        closeConditions,
      );
      expect(repo.listLifecycleEvents("hitch-update")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each([
    ["closed", /reopen.*before updating/i],
    ["budget_exhausted", /reopen.*before updating/i],
    ["escalated", /reopen.*before updating/i],
    ["cancelled", /cannot be reopened/i],
    ["diverging", /cannot be reopened/i],
  ] as const)("rejects updates for terminal status %s with state guidance", (status, pattern) => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo);
      repo.updateStatus("hitch-update", status, "terminal", { createdBy: "test" });
      expect(() =>
        repo.updateSessionConfig({
          hitchId: "hitch-update",
          closeConditions,
          reason: "try update",
          createdBy: "operator",
        }),
      ).toThrow(pattern);
    } finally {
      db.close();
    }
  });

  it("rejects updates with no config fields", () => {
    const { db, repo } = freshRepo();
    try {
      createUpdateGoal(repo);
      expect(() =>
        repo.updateSessionConfig({
          hitchId: "hitch-update",
          reason: "nothing",
          createdBy: "operator",
        }),
      ).toThrow(/at least one/i);
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
      repo.updateStatus("goal-test", "closed", "all done", {
        createdBy: "closer",
      });
      const before = repo.requireSession("goal-test");
      expect(before.status).toBe("closed");
      expect(before.closedAt).not.toBeNull();
      const after = repo.reopenSession("goal-test", {
        reason: "late P1",
        createdBy: "operator",
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
      expect(repo.listLifecycleEvents("goal-test")).toMatchObject([
        { event: "closed", reason: "all done", createdBy: "closer" },
        { event: "reopened", reason: "late P1", createdBy: "operator" },
      ]);
    } finally {
      db.close();
    }
  });

  it("reopens a budget_exhausted goal", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "budget_exhausted", "out of budget", {
        createdBy: "budgeter",
      });
      expect(
        repo.reopenSession("goal-test", {
          reason: "add budget",
          createdBy: "operator",
        }).status,
      ).toBe("open");
    } finally {
      db.close();
    }
  });

  it("persists cancel reasons in lifecycle events", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "cancelled", "abandoned", {
        createdBy: "operator",
        now: "2026-06-12T00:00:00.000Z",
      });
      expect(repo.listLifecycleEvents("goal-test")).toMatchObject([
        {
          event: "cancelled",
          reason: "abandoned",
          createdAt: "2026-06-12T00:00:00.000Z",
          createdBy: "operator",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("records each reopen as a separate lifecycle event", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "closed", "first close", {
        createdBy: "closer",
      });
      repo.reopenSession("goal-test", {
        reason: "first late finding",
        createdBy: "operator",
      });
      repo.updateStatus("goal-test", "closed", "second close", {
        createdBy: "closer",
      });
      repo.reopenSession("goal-test", {
        reason: "second late finding",
        createdBy: "operator",
      });
      expect(
        repo
          .listLifecycleEvents("goal-test")
          .filter((event) => event.event === "reopened")
          .map((event) => event.reason),
      ).toEqual(["first late finding", "second late finding"]);
    } finally {
      db.close();
    }
  });

  it("does not record a reopen event when the status update rolls back", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "closed", "done", { createdBy: "closer" });
      db.prepare(
        `CREATE TRIGGER fail_reopen_update
           BEFORE UPDATE OF status ON hitch_sessions
           WHEN NEW.hitch_id = 'goal-test' AND NEW.status = 'open'
         BEGIN
           SELECT RAISE(ABORT, 'forced reopen failure');
         END`,
      ).run();
      expect(() =>
        repo.reopenSession("goal-test", {
          reason: "should roll back",
          createdBy: "operator",
        }),
      ).toThrow(/forced reopen failure/);
      expect(repo.requireSession("goal-test").status).toBe("closed");
      expect(
        repo
          .listLifecycleEvents("goal-test")
          .filter((event) => event.event === "reopened"),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not record close or cancel events when the status update rolls back", () => {
    for (const status of ["closed", "cancelled"] as const) {
      const { db, repo } = freshRepo();
      try {
        createGoal(repo);
        db.prepare(
          `CREATE TRIGGER fail_terminal_update
             BEFORE UPDATE OF status ON hitch_sessions
             WHEN NEW.hitch_id = 'goal-test' AND NEW.status = '${status}'
           BEGIN
             SELECT RAISE(ABORT, 'forced terminal failure');
           END`,
        ).run();
        expect(() =>
          repo.updateStatus("goal-test", status, "should roll back", {
            createdBy: "operator",
          }),
        ).toThrow(/forced terminal failure/);
        expect(repo.requireSession("goal-test").status).toBe("open");
        expect(
          repo
            .listLifecycleEvents("goal-test")
            .filter((event) => event.event === status),
        ).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  it("refuses to reopen a cancelled goal (deliberate abandon)", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "cancelled", "abandoned", {
        createdBy: "operator",
      });
      expect(() =>
        repo.reopenSession("goal-test", {
          reason: "retry",
          createdBy: "operator",
        }),
      ).toThrow(/not a reopenable/);
    } finally {
      db.close();
    }
  });

  it("refuses to reopen a live (open) goal", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      expect(() =>
        repo.reopenSession("goal-test", {
          reason: "retry",
          createdBy: "operator",
        }),
      ).toThrow(/not a reopenable/);
    } finally {
      db.close();
    }
  });

  it("refuses to reopen a diverging goal (recovery is live self-clear, not reopen)", () => {
    // `diverging` is not reopenable: since #164 it self-clears via live
    // re-derivation (a transient trigger clears on a clean cycle). reopen extends
    // only iteration/review/rerun budgets — not the divergence budget — so it is
    // also the wrong recovery for a cumulative trigger (it would re-fire at once).
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      repo.updateStatus("goal-test", "diverging", "finding churn", {
        createdBy: "operator",
      });
      expect(() =>
        repo.reopenSession("goal-test", {
          reason: "retry",
          createdBy: "operator",
        }),
      ).toThrow(/not a reopenable/);
    } finally {
      db.close();
    }
  });
});
