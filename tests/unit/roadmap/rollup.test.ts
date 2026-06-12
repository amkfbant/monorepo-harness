import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { DEFAULT_HITCH_POLICY } from "../../../src/hitch/types.js";
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

  it("marks a phase readyToClose when its hitch evaluates close_ready with no open P0/P1", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-ready", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-ready", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({
      title: "H-ready",
      projectId: "demo",
      scope: {},
      closeConditions: [{
        id: "no-blockers",
        kind: "finding_policy",
        required: true,
        rule: { maxOpenInScopeP0: 0, maxOpenInScopeP1: 0, maxOpenUnknownScope: 0 },
      }],
      createdBy: "t",
      createdSource: "cli",
    });
    phases.linkHitch(p.phaseId, h.hitchId);

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.readyToClose).toBe(true);
  });

  it("marks a phase not readyToClose when its hitch still needs fixes", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-needs-fix", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-needs-fix", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({
      title: "H-needs-fix",
      projectId: "demo",
      scope: {},
      closeConditions: [{
        id: "no-blockers",
        kind: "finding_policy",
        required: true,
        rule: { maxOpenInScopeP0: 0, maxOpenInScopeP1: 0, maxOpenUnknownScope: 0 },
      }],
      createdBy: "t",
      createdSource: "cli",
    });
    phases.linkHitch(p.phaseId, h.hitchId);
    hitches.upsertFinding({
      hitchId: h.hitchId,
      severity: "P1",
      source: "human",
      category: "correctness",
      summary: "bug",
      scopeStatus: "in_scope",
    });

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.readyToClose).toBe(false);
  });

  it.each([
    ["close_ready", "open"],
    ["close_ready", "escalated"],
    ["closed", "reopened"],
  ] as const)(
    "keeps readyToClose false when hitch convergence is %s but DB has a %s in-scope P1",
    (targetDecision, findingLifecycle) => {
      const courses = new CourseRepository(conn);
      const phases = new PhaseRepository(conn);
      const hitches = new HitchRepository(conn);
      const c = courses.create({
        title: `C-${targetDecision}-${findingLifecycle}`,
        projectId: "demo",
        createdBy: "t",
        createdSource: "cli",
      });
      const p = phases.add({
        courseId: c.courseId,
        title: `P-${targetDecision}-${findingLifecycle}`,
        createdBy: "t",
        createdSource: "cli",
      });
      const h = hitches.createSession({
        title: `H-${targetDecision}-${findingLifecycle}`,
        projectId: "demo",
        scope: {},
        closeConditions: [
          {
            id: "manual-pass",
            kind: "manual",
            required: true,
          },
        ],
        policy: {
          ...DEFAULT_HITCH_POLICY,
          closeRequires: {
            ...DEFAULT_HITCH_POLICY.closeRequires,
            noOpenInScopeP1: false,
          },
        },
        createdBy: "t",
        createdSource: "cli",
      });
      phases.linkHitch(p.phaseId, h.hitchId);
      hitches.upsertFinding({
        hitchId: h.hitchId,
        severity: "P1",
        source: "human",
        category: "correctness",
        summary: "live blocker",
        scopeStatus: "in_scope",
        seenAt: "2026-01-01T00:00:00.000Z",
        ...(findingLifecycle === "escalated"
          ? { lifecycleStatus: "escalated" as const }
          : {}),
      });
      if (findingLifecycle === "reopened") {
        const findings = hitches.listFindings({ hitchId: h.hitchId, limit: 10 });
        expect(findings.length).toBeGreaterThanOrEqual(1);
        hitches.markFindingFixed({
          findingId: findings[0]!.findingId,
          fixedAt: "2026-01-01T00:00:01.000Z",
        });
        hitches.upsertFinding({
          hitchId: h.hitchId,
          severity: "P1",
          source: "human",
          category: "correctness",
          summary: "live blocker",
          scopeStatus: "in_scope",
          seenAt: "2026-01-01T00:00:02.000Z",
        });
      }
      if (targetDecision === "closed") {
        hitches.updateStatus(h.hitchId, "closed", "declared closed");
      } else {
        hitches.recordCloseCheck({
          hitchId: h.hitchId,
          conditionId: "manual-pass",
          status: "passed",
          checkedAt: "2026-01-01T00:00:03.000Z",
          checkedBy: "t",
        });
      }

      expect(new ConvergenceService(hitches).evaluate(h.hitchId).decision).toBe(
        targetDecision,
      );
      const rollup = rollupCourse({ db: conn, courseId: c.courseId });
      const node = rollup.phases[0]!;
      expect(node.derivedOpenP1).toBeGreaterThanOrEqual(1);
      expect(node.readyToClose).toBe(false);
    },
  );

  it("counts reopened in-scope P1 findings (P0 fix: reopened must not be silently dropped)", () => {
    // Regression for SP-1 codex P0: rollup previously only counted lifecycleStatus='open',
    // so a reopened in-scope P1 could let a declared-closed phase hide a live blocker.
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({
      title: "C-reopen",
      projectId: "demo",
      createdBy: "t",
      createdSource: "cli",
    });
    const p = phases.add({
      courseId: c.courseId,
      title: "P-reopen",
      createdBy: "t",
      createdSource: "cli",
    });
    const h = hitches.createSession({
      title: "H-reopen",
      projectId: "demo",
      scope: {},
      closeConditions: [],
      createdBy: "t",
      createdSource: "cli",
    });
    phases.linkHitch(p.phaseId, h.hitchId);
    // Insert finding as 'open', then mark it 'fixed', then upsert again to transition to 'reopened'.
    // upsertFinding transitions fixed → reopened when the same stable_key is seen again.
    hitches.upsertFinding({
      hitchId: h.hitchId,
      severity: "P1",
      source: "human",
      category: "correctness",
      summary: "reopenable bug",
      scopeStatus: "in_scope",
    });
    // Mark the finding fixed so we can reopen it
    const findings = hitches.listFindings({ hitchId: h.hitchId, limit: 10 });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    hitches.markFindingFixed({ findingId: findings[0]!.findingId });
    // Upsert the same finding again — this transitions lifecycle_status from 'fixed' → 'reopened'
    hitches.upsertFinding({
      hitchId: h.hitchId,
      severity: "P1",
      source: "human",
      category: "correctness",
      summary: "reopenable bug",
      scopeStatus: "in_scope",
    });
    // Declare the phase closed — rollup must still surface the reopened P1
    phases.setStatus(p.phaseId, "closed");
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.openP1).toBeGreaterThanOrEqual(1);
    const node = rollup.phases[0]!;
    expect(node.declaredStatus).toBe("closed");
    expect(node.derivedOpenP1).toBeGreaterThanOrEqual(1);
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
