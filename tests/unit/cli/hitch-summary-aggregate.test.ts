import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { ADVISORY_SEVERITY_RECORD_KEY } from "../../../src/hitch/convergence-status.js";
import { buildHitchSummary } from "../../../src/cli/hitch/summary-aggregate.js";

const GHP = "ghp_0123456789abcdefghijklmnopqrstuvwx";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "harness-hitch-summary-agg-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return {
    db,
    courses: new CourseRepository(db),
    phases: new PhaseRepository(db),
    repo: new HitchRepository(db),
  };
}

function seedCoursePhase(
  courses: CourseRepository,
  phases: PhaseRepository,
): void {
  courses.create({
    courseId: "course-1",
    title: "Course One",
    description: "the description",
    createdBy: "t",
    createdSource: "cli",
  });
  phases.add({
    courseId: "course-1",
    phaseId: "phase-1",
    title: "Phase One",
    scope: {},
    closeConditions: [],
    createdBy: "t",
    createdSource: "cli",
  });
}

describe("buildHitchSummary (read-only aggregation, #84 Stage A)", () => {
  it("projects course→phase→hitch with counts, latest decision, redacted findings", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      repo.createSession({
        hitchId: "h-1",
        title: "Hitch One",
        scope: {},
        closeConditions: [],
        createdBy: "t",
        createdSource: "cli",
      });
      phases.linkHitch("phase-1", "h-1");
      repo.upsertFinding({
        hitchId: "h-1",
        source: "review",
        severity: "P1",
        category: "correctness",
        summary: "off-by-one in pagination",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
      });
      repo.upsertFinding({
        hitchId: "h-1",
        source: "review",
        severity: "P0",
        category: "security",
        summary: `leaked ${GHP} token`,
        detail: "secret detail must never surface",
        filePath: "apps/secret/path.ts",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
      });
      repo.recordConvergenceDecision({
        hitchId: "h-1",
        decision: "continue",
        reason: "first pass",
        createdBy: "harness",
        createdAt: "2026-06-20T00:00:00.000Z",
      });
      repo.recordConvergenceDecision({
        hitchId: "h-1",
        decision: "needs_fix",
        reason: "p0 still open",
        createdBy: "harness",
        createdAt: "2026-06-20T00:01:00.000Z",
      });

      const summary = buildHitchSummary(db, "course-1");

      expect(summary.courseId).toBe("course-1");
      expect(summary.title).toBe("Course One");
      expect(summary.description).toBe("the description");
      expect(summary.status).toBe("active");
      // rolled up by SUMMING per-hitch counts (NOT rollupCourse / evaluate)
      expect(summary.openInScopeP0).toBe(1);
      expect(summary.openInScopeP1).toBe(1);

      expect(summary.phases).toHaveLength(1);
      const ph = summary.phases[0]!;
      expect(ph.phaseId).toBe("phase-1");
      expect(ph.title).toBe("Phase One");
      expect(ph.hitches).toHaveLength(1);

      const h = ph.hitches[0]!;
      expect(h.hitchId).toBe("h-1");
      expect(h.title).toBe("Hitch One");
      expect(h.latestDecision).toBe("needs_fix");
      expect(h.findingCounts.openInScopeP0).toBe(1);
      expect(h.findingCounts.openInScopeP1).toBe(1);

      const summaries = h.findings.map((f) => f.summary as string);
      expect(summaries).toContain("off-by-one in pagination");
      expect(summaries.some((s) => s.includes("ghp_"))).toBe(false);
      expect(summaries).toContain("[redacted]");

      // allowlist projection: B列 free-text columns NEVER reach the projection.
      const blob = JSON.stringify(summary);
      expect(blob).not.toContain("secret detail must never surface");
      expect(blob).not.toContain("apps/secret/path.ts");
      for (const f of h.findings) {
        expect(f).not.toHaveProperty("detail");
        expect(f).not.toHaveProperty("filePath");
        expect(f).not.toHaveProperty("symbol");
        expect(f).not.toHaveProperty("suggestedFix");
      }
    } finally {
      db.close();
    }
  });

  it("prefers the adopted PR from the pr_adopted event", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      repo.createSession({
        hitchId: "h-2",
        title: "Hitch Two",
        scope: {},
        closeConditions: [],
        createdBy: "t",
        createdSource: "cli",
      });
      phases.linkHitch("phase-1", "h-2");
      repo.adoptPr({
        hitchId: "h-2",
        prNumber: 999,
        prUrl: "https://github.com/x/y/pull/999",
        reason: "operator takeover",
        createdBy: "op",
      });

      const summary = buildHitchSummary(db, "course-1");
      const h = summary.phases[0]!.hitches.find((x) => x.hitchId === "h-2")!;
      expect(h.pr).toEqual({
        number: 999,
        url: "https://github.com/x/y/pull/999",
      });
      expect(h.interventionCounts.prAdopted).toBe(1);
    } finally {
      db.close();
    }
  });

  it("does not let an advisory severity-audit row mask the latest blocking decision", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      repo.createSession({
        hitchId: "h-adv",
        title: "Hitch Adv",
        scope: {},
        closeConditions: [],
        createdBy: "t",
        createdSource: "cli",
      });
      phases.linkHitch("phase-1", "h-adv");
      repo.recordConvergenceDecision({
        hitchId: "h-adv",
        decision: "needs_fix",
        reason: "p0 open",
        createdBy: "harness",
        createdAt: "2026-06-20T00:00:00.000Z",
      });
      // advisory severity-audit row recorded LATER (status-neutral continue)
      repo.recordConvergenceDecision({
        hitchId: "h-adv",
        decision: "continue",
        reason: "severity audit",
        metrics: { [ADVISORY_SEVERITY_RECORD_KEY]: true },
        createdBy: "harness",
        createdAt: "2026-06-20T00:05:00.000Z",
      });

      const summary = buildHitchSummary(db, "course-1");
      const h = summary.phases[0]!.hitches.find((x) => x.hitchId === "h-adv")!;
      // must NOT display the advisory "continue" that masks the blocking state
      expect(h.latestDecision).toBe("needs_fix");
    } finally {
      db.close();
    }
  });

  it("reports the live terminal status for a closed/cancelled session", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      for (const [id, terminal] of [
        ["h-closed", "closed"],
        ["h-cancelled", "cancelled"],
      ] as const) {
        repo.createSession({
          hitchId: id,
          title: id,
          scope: {},
          closeConditions: [],
          createdBy: "t",
          createdSource: "cli",
        });
        phases.linkHitch("phase-1", id);
        // a stale mid-flight decision lingers in the audit log
        repo.recordConvergenceDecision({
          hitchId: id,
          decision: "diverging",
          reason: "mid-flight",
          createdBy: "harness",
          createdAt: "2026-06-20T00:00:00.000Z",
        });
        repo.updateStatus(id, terminal, "operator action", {
          createdBy: "op",
        });
      }

      const summary = buildHitchSummary(db, "course-1");
      const byId = new Map(
        summary.phases[0]!.hitches.map((h) => [h.hitchId, h]),
      );
      expect(byId.get("h-closed")!.latestDecision).toBe("closed");
      expect(byId.get("h-cancelled")!.latestDecision).toBe("cancel");
    } finally {
      db.close();
    }
  });

  it("flags escalation from session status", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      repo.createSession({
        hitchId: "h-3",
        title: "Hitch Three",
        scope: {},
        closeConditions: [],
        createdBy: "t",
        createdSource: "cli",
      });
      phases.linkHitch("phase-1", "h-3");
      repo.updateStatus("h-3", "escalated", "manual escalation", {
        createdBy: "op",
      });

      const summary = buildHitchSummary(db, "course-1");
      const h = summary.phases[0]!.hitches.find((x) => x.hitchId === "h-3")!;
      expect(h.status).toBe("escalated");
      expect(h.escalated).toBe(true);
    } finally {
      db.close();
    }
  });

  it("skips a dangling phase_hitches link whose session no longer exists", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      repo.createSession({
        hitchId: "h-gone",
        title: "Gone",
        scope: {},
        closeConditions: [],
        createdBy: "t",
        createdSource: "cli",
      });
      phases.linkHitch("phase-1", "h-gone");
      db.prepare("DELETE FROM hitch_sessions WHERE hitch_id = ?").run("h-gone");

      const summary = buildHitchSummary(db, "course-1");
      expect(summary.phases[0]!.hitches).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("throws for an unknown course", () => {
    const { db } = fresh();
    try {
      expect(() => buildHitchSummary(db, "course-missing")).toThrow();
    } finally {
      db.close();
    }
  });

  it("handles a course with no phases and a phase with no hitches", () => {
    const { db, courses, phases } = fresh();
    try {
      courses.create({
        courseId: "course-empty",
        title: "Empty",
        createdBy: "t",
        createdSource: "cli",
      });
      const a = buildHitchSummary(db, "course-empty");
      expect(a.phases).toHaveLength(0);
      expect(a.openInScopeP0).toBe(0);

      phases.add({
        courseId: "course-empty",
        phaseId: "p-empty",
        title: "P Empty",
        scope: {},
        closeConditions: [],
        createdBy: "t",
        createdSource: "cli",
      });
      const b = buildHitchSummary(db, "course-empty");
      expect(b.phases).toHaveLength(1);
      expect(b.phases[0]!.hitches).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
