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
) {
  repo.createAttempt({
    hitchId: "goal-test",
    attemptType: "implement",
    status: "succeeded",
    runId: RUN_ID,
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
