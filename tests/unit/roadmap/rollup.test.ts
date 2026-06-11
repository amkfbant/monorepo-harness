import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { rollupCourse } from "../../../src/roadmap/rollup.js";
import {
  recordConvergenceDecisionWithStatus,
} from "../../../src/hitch/convergence-status.js";

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

  it("latestDecision is populated from the phase's hitch convergence decisions", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C2", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P2", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({ title: "H2", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, h.hitchId);
    recordConvergenceDecisionWithStatus({
      repository: hitches,
      hitchId: h.hitchId,
      decision: "needs_fix",
      reason: "test",
      metrics: {},
      createdBy: "t",
      updateStatus: false,
    });
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.latestDecision).toBe("needs_fix");
  });

  it("throws on cycle/orphan — fail-closed integrity guard", () => {
    const courses = new CourseRepository(conn);
    const c = courses.create({ title: "C3", createdBy: "t", createdSource: "cli" });
    // Insert two phases with a direct cycle: A.parent = B, B.parent = A.
    // Temporarily disable FK to bypass the constraint (this is intentionally invalid data).
    conn.pragma("foreign_keys = OFF");
    const insertPhase = conn.prepare(
      `INSERT INTO phases (phase_id, course_id, parent_phase_id, title, position, status, created_by, created_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'pending', 't', 'cli', datetime('now'), datetime('now'))`,
    );
    insertPhase.run("phase-A", c.courseId, "phase-B", "A");
    insertPhase.run("phase-B", c.courseId, "phase-A", "B");
    conn.pragma("foreign_keys = ON");
    expect(() => rollupCourse({ db: conn, courseId: c.courseId })).toThrow(
      /phase tree is inconsistent \(cycle or orphan parent\)/,
    );
  });
});
