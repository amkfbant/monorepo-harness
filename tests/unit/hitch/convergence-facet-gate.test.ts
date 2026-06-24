import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { RunRepository } from "../../../src/db/repositories/runs.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import type { HitchCloseCondition } from "../../../src/hitch/types.js";

const RUN_ID = "run-close";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "harness-facet-gate-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  const repo = new HitchRepository(db);
  return { db, repo, service: new ConvergenceService(repo) };
}

const FACET_CONDITION: HitchCloseCondition = {
  id: "facet-red",
  kind: "facet_red_test",
  required: true,
  rule: {
    facets: [
      {
        id: "auth-login",
        testGlobs: ["tests/auth/**"],
        changedFileGlobs: ["src/auth/**"],
      },
    ],
  },
};

function codingRun(
  db: ReturnType<typeof openDb>,
  repo: HitchRepository,
  changed: string[],
  createdAt = "2026-05-01T00:00:00.000Z",
) {
  repo.createAttempt({
    hitchId: "goal-test",
    attemptType: "implement",
    status: "succeeded",
    runId: RUN_ID,
    createdAt,
  });
  new RunRepository(db).upsertChangedFiles(
    RUN_ID,
    changed.map((path) => ({
      path,
      status: "tracked",
      allowed: true,
      source: "post-codex",
    })),
  );
}

function createGoal(
  repo: HitchRepository,
  closeConditions: HitchCloseCondition[],
) {
  return repo.createSession({
    hitchId: "goal-test",
    title: "Goal",
    closeConditions,
    createdBy: "test",
    createdSource: "cli",
  });
}

/**
 * Mark the latest coding run as reviewed so convergence proceeds past the #104
 * "review the latest coder run first" branch and reaches the close-condition
 * routing under test. A completed cycle AFTER the coding attempt clears
 * `reviewPending`.
 */
function markReviewed(repo: HitchRepository) {
  const cycle = repo.startReviewCycle({
    hitchId: "goal-test",
    reviewMode: "initial",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  repo.completeReviewCycle({
    cycleId: cycle.cycleId,
    completedAt: "2026-06-01T00:01:00.000Z",
  });
}

describe("ConvergenceService facet_red_test gate (#279 wiring)", () => {
  it("fail-open shape: production surface changed, no covering test → NOT close_ready", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [FACET_CONDITION]);
      codingRun(db, repo, ["src/auth/login.ts"]); // no covering test changed
      const result = service.evaluate("goal-test");
      expect(result.decision).not.toBe("close_ready");
      expect(result.metrics.closeConditionsFailed).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it("fail-closed: a required facet_red_test with no recorded evidence → NOT close_ready", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [FACET_CONDITION]);
      codingRun(db, repo, ["src/auth/login.ts", "tests/auth/login.test.ts"]);
      // test changed, but NO RED evidence recorded → pending, never passed
      const result = service.evaluate("goal-test");
      expect(result.decision).not.toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("happy path: changed test + matching RED evidence from the close run → close_ready", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [FACET_CONDITION]);
      codingRun(db, repo, ["src/auth/login.ts", "tests/auth/login.test.ts"]);
      repo.recordCloseCheck({
        hitchId: "goal-test",
        conditionId: "facet-red",
        status: "passed",
        checkedBy: "runner",
        recordingMode: "deterministic",
        evidence: {
          facets: [
            {
              facetId: "auth-login",
              redTestPath: "tests/auth/login.test.ts",
              redDemonstrated: true,
              runId: RUN_ID,
            },
          ],
        },
      });
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("fail-closed (newest-attempt strict): a later run-less rerun does NOT close on the prior passing run (#279 P1)", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [FACET_CONDITION]);
      // Prior run that legitimately PASSED the facet gate.
      codingRun(db, repo, ["src/auth/login.ts", "tests/auth/login.test.ts"]);
      repo.recordCloseCheck({
        hitchId: "goal-test",
        conditionId: "facet-red",
        status: "passed",
        checkedBy: "runner",
        recordingMode: "deterministic",
        evidence: {
          facets: [
            {
              facetId: "auth-login",
              redTestPath: "tests/auth/login.test.ts",
              redDemonstrated: true,
              runId: RUN_ID, // evidence bound to the PRIOR run
            },
          ],
        },
      });
      // A NEWER coding pass is in flight: a succeeded rerun attempt that has NOT
      // recorded a run_id yet. The lenient latestCodingRunId would skip it and
      // fall back to the prior run; the facet gate must NOT.
      repo.createAttempt({
        hitchId: "goal-test",
        attemptType: "rerun",
        status: "succeeded",
        // no runId
      });
      const result = service.evaluate("goal-test");
      expect(result.decision).not.toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("opt-in invariance: a hitch WITHOUT facet_red_test is unaffected by the gate", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [{ id: "typecheck", kind: "command", required: true }]);
      codingRun(db, repo, ["src/auth/login.ts"]); // production touched, no test
      repo.recordCloseCheck({
        hitchId: "goal-test",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "runner",
      });
      // No facet_red_test condition → the fail-open shape does NOT block close.
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });
});

// A facet rule that omits changedFileGlobs: a coding run that changes neither
// the covering test nor any production surface yields a `no_change` pending
// facet — which NO evidence row can clear (matchedTestPaths is empty). It is
// "code-recoverable": only a code/test change can satisfy it.
const FACET_CONDITION_NO_GLOBS: HitchCloseCondition = {
  id: "facet-red",
  kind: "facet_red_test",
  required: true,
  rule: {
    facets: [
      {
        id: "auth-login",
        testGlobs: ["tests/auth/**"],
      },
    ],
  },
};

describe("ConvergenceService facet_red_test recovery routing (#308 P2-2)", () => {
  it("code-recoverable pending (no covering test, evidence cannot clear it) routes to the coder, NOT ask_human", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [FACET_CONDITION_NO_GLOBS]);
      // Coding run touched an unrelated file: no matched test, no production
      // surface → `no_change` pending. Only a NEW test can clear the facet.
      codingRun(db, repo, ["src/billing/charge.ts"]);
      markReviewed(repo);
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("needs_fix");
      expect(result.recommendedNextAction.kind).toBe("fix_findings");
      expect(result.recommendedNextAction.message).toMatch(/covering test/i);
    } finally {
      db.close();
    }
  });

  it("don't over-route: evidence-recoverable pending (test present, no evidence yet) STILL routes to ask_human", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [FACET_CONDITION]);
      // Covering test changed but no RED evidence recorded yet → recoverable by
      // recording evidence → ask_human/record-evidence, NOT a coder rerun.
      codingRun(db, repo, ["src/auth/login.ts", "tests/auth/login.test.ts"]);
      markReviewed(repo);
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("continue");
      expect(result.recommendedNextAction.kind).toBe("ask_human");
    } finally {
      db.close();
    }
  });

  it("gate-invariance: a fail-open shape still FAILS and routes to needs_fix (unchanged gate)", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [FACET_CONDITION]);
      codingRun(db, repo, ["src/auth/login.ts"]); // production touched, no test
      markReviewed(repo);
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("needs_fix");
      expect(result.metrics.closeConditionsFailed).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
