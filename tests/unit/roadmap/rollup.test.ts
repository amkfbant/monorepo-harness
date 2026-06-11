import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { rollupCourse } from "../../../src/roadmap/rollup.js";

describe("rollupCourse (SP-1)", () => {
  let conn: Database.Database;
  beforeEach(() => {
    conn = new Database(":memory:");
    conn.pragma("foreign_keys = ON");
    runMigrations(conn);
  });

  it("derives open in-scope P0/P1 live from hitch_findings (declared status cannot hide them)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({
      title: "C",
      projectId: "demo",
      createdBy: "t",
      createdSource: "cli",
    });
    const p = phases.add({
      courseId: c.courseId,
      title: "P",
      createdBy: "t",
      createdSource: "cli",
    });
    const h = hitches.createSession({
      title: "H",
      projectId: "demo",
      scope: {},
      closeConditions: [],
      createdBy: "t",
      createdSource: "cli",
    });
    phases.linkHitch(p.phaseId, h.hitchId);
    // record an open in-scope P1 finding (UpsertHitchFindingInput requires `source`);
    // scopeStatus "in_scope" defaults lifecycleStatus to "open" (no classify step needed).
    hitches.upsertFinding({
      hitchId: h.hitchId,
      severity: "P1",
      source: "human",
      category: "correctness",
      summary: "bug",
      scopeStatus: "in_scope",
    });
    // even if the operator marks the phase "closed", the rollup still reports the open P1
    phases.setStatus(p.phaseId, "closed");
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.openP0).toBe(0);
    expect(rollup.openP1).toBeGreaterThanOrEqual(1);
    const node = rollup.phases[0]!;
    expect(node.declaredStatus).toBe("closed");
    expect(node.derivedOpenP1).toBeGreaterThanOrEqual(1);
  });
});
