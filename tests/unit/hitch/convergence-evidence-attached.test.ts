import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { attachHitchEvidence } from "../../../src/hitch/evidence-write.js";
import type { HitchCloseCondition } from "../../../src/hitch/types.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "harness-evidence-gate-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  const repo = new HitchRepository(db);
  return { db, repo, service: new ConvergenceService(repo) };
}

const EVIDENCE_CONDITION: HitchCloseCondition = {
  id: "manual-evidence",
  kind: "evidence_attached",
  required: true,
};

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

describe("ConvergenceService evidence_attached gate (#91 Stage B wiring)", () => {
  it("fail-closed: a required evidence_attached with no attached evidence → NOT close_ready", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [EVIDENCE_CONDITION]);
      const result = service.evaluate("goal-test");
      expect(result.decision).not.toBe("close_ready");
      expect(result.metrics.closeConditionsPending).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it("happy path: an operator evidence row for the condition flips the gate → close_ready", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [EVIDENCE_CONDITION]);
      // Sanity: pending before any evidence is attached.
      expect(service.evaluate("goal-test").decision).not.toBe("close_ready");
      attachHitchEvidence(repo, {
        hitchId: "goal-test",
        label: "manual verification",
        output: "all good",
        conditionId: "manual-evidence",
      });
      // Proves the evidenceRows threading is live end-to-end through the real
      // convergence path: without the wiring the gate sees no evidence.
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("scoped: evidence attached to a DIFFERENT condition id does NOT satisfy the gate", () => {
    const { db, repo, service } = fresh();
    try {
      // Two declared conditions: the evidence_attached one (the gate under test)
      // and a separate one we will (legitimately) attach evidence to. Attaching
      // to the OTHER declared condition must not satisfy the evidence_attached
      // gate. The other condition id must be DECLARED — Task 3's add-time
      // validation now rejects evidence attached to an undeclared condition id.
      createGoal(repo, [
        EVIDENCE_CONDITION,
        { id: "other-evidence", kind: "evidence_attached", required: false },
      ]);
      attachHitchEvidence(repo, {
        hitchId: "goal-test",
        label: "unrelated",
        output: "for another condition",
        conditionId: "other-evidence",
      });
      const result = service.evaluate("goal-test");
      expect(result.decision).not.toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("opt-in invariance: a hitch WITHOUT an evidence_attached condition is unaffected", () => {
    const { db, repo, service } = fresh();
    try {
      createGoal(repo, [{ id: "typecheck", kind: "command", required: true }]);
      repo.recordCloseCheck({
        hitchId: "goal-test",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "runner",
      });
      // No evidence_attached condition → evidenceRows threading must not change
      // the outcome; a satisfied command condition closes as before.
      const result = service.evaluate("goal-test");
      expect(result.decision).toBe("close_ready");
    } finally {
      db.close();
    }
  });
});
