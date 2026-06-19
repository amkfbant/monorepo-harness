import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import type { HitchCloseCondition } from "../../../src/hitch/types.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";

const MANUAL_SIGNOFF: HitchCloseCondition = {
  id: "manual-signoff",
  kind: "manual",
  required: true,
  description: "operator signoff",
};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "harness-convergence-drift-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  const hitches = new HitchRepository(db);
  return {
    db,
    hitches,
    service: new ConvergenceService(hitches),
    courses: new CourseRepository(db),
    phases: new PhaseRepository(db),
  };
}

function seedReviewedCodingAttempt(repo: HitchRepository, hitchId: string): void {
  repo.createAttempt({
    hitchId,
    attemptType: "implement",
    status: "succeeded",
    runId: `run-${hitchId}`,
    createdAt: "2026-06-18T00:00:00.000Z",
  });
  for (const cycleNumber of [1, 2]) {
    const cycle = repo.startReviewCycle({
      hitchId,
      cycleNumber,
      reviewMode: cycleNumber === 1 ? "initial" : "delta",
      createdAt: `2026-06-18T00:0${cycleNumber}:00.000Z`,
    });
    repo.completeReviewCycle({
      cycleId: cycle.cycleId,
      completedAt: `2026-06-18T00:0${cycleNumber}:30.000Z`,
    });
  }
}

describe("ConvergenceService runtime spec drift diagnostics", () => {
  it("enriches ask_human for pending external evidence with pending cycles and linked phase spec drift", () => {
    const { db, hitches, service, courses, phases } = fresh();
    try {
      const course = courses.create({
        courseId: "course-drift",
        title: "Course Drift",
        projectId: "demo",
        createdBy: "test",
        createdSource: "cli",
      });
      const phase = phases.add({
        courseId: course.courseId,
        phaseId: "phase-drift",
        title: "Phase Drift",
        scope: {},
        closeConditions: [MANUAL_SIGNOFF],
        createdBy: "test",
        createdSource: "cli",
      });
      phases.recordSpecApproval(phase.phaseId, {
        approvedBy: "operator",
        now: "2026-06-18T00:00:00.000Z",
      });

      hitches.createSession({
        hitchId: "h-drift",
        title: "Hitch Drift",
        projectId: "demo",
        scope: {},
        closeConditions: [MANUAL_SIGNOFF],
        createdBy: "test",
        createdSource: "cli",
      });
      phases.linkHitch(phase.phaseId, "h-drift");
      phases.updateSpec({
        phaseId: phase.phaseId,
        scope: { targetFiles: ["src/**"] },
        allowScopeWiden: true,
        now: "2026-06-18T00:00:30.000Z",
      });
      seedReviewedCodingAttempt(hitches, "h-drift");

      const result = service.evaluate("h-drift");

      expect(result.decision).toBe("continue");
      expect(result.recommendedNextAction.kind).toBe("ask_human");
      expect(result.recommendedNextAction.message).toContain(
        "condition manual-signoff kind=manual pending 2 cycles",
      );
      expect(result.recommendedNextAction.message).toContain(
        "Spec approval hash drift: phase phase-drift approved=",
      );
      expect(result.recommendedNextAction.message).toContain(" current=");
    } finally {
      db.close();
    }
  });
});
