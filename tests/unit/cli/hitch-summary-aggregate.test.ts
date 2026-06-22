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
import { buildHitchSummary, type HitchSummaryFilter } from "../../../src/cli/hitch/summary-aggregate.js";

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

// ── Stage B: time-window filter ──────────────────────────────────────────────

/**
 * Seed a hitch linked to "phase-1" and return its id. Caller must call
 * `seedCoursePhase` first.
 */
function seedHitch(
  repo: HitchRepository,
  phases: PhaseRepository,
  db: ReturnType<typeof fresh>["db"],
  hitchId: string,
  updatedAt: string,
  /** Optional P0 finding to add (for roll-up tests). */
  addP0 = false,
): void {
  repo.createSession({
    hitchId,
    title: `Hitch ${hitchId}`,
    scope: {},
    closeConditions: [],
    createdBy: "t",
    createdSource: "cli",
  });
  phases.linkHitch("phase-1", hitchId);
  if (addP0) {
    repo.upsertFinding({
      hitchId,
      source: "review",
      severity: "P0",
      category: "correctness",
      summary: "p0 finding",
      scopeStatus: "in_scope",
      lifecycleStatus: "open",
    });
  }
  // Set the deterministic timestamp LAST — upsertFinding calls touchHitchSession
  // which overwrites updated_at, so the final write must come after all mutations.
  db.prepare(
    "UPDATE hitch_sessions SET updated_at = ? WHERE hitch_id = ?",
  ).run(updatedAt, hitchId);
}

describe("buildHitchSummary — Stage B time-window filter (#84)", () => {
  const T_EARLY = "2026-01-01T00:00:00.000Z"; // ms: 1735689600000
  const T_MID = "2026-06-01T00:00:00.000Z"; // ms: 1748736000000
  const T_LATE = "2026-12-31T00:00:00.000Z"; // ms: 1767139200000

  it("no filter (default arg) — includes every hitch; result has NO `window` property", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-none-a", T_EARLY);
      seedHitch(repo, phases, db, "h-w-none-b", T_LATE);

      const summary = buildHitchSummary(db, "course-1");

      expect(summary.phases[0]!.hitches).toHaveLength(2);
      expect(summary).not.toHaveProperty("window");
    } finally {
      db.close();
    }
  });

  it("in-window included / out-of-window excluded", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-in", T_MID);
      seedHitch(repo, phases, db, "h-w-out", T_EARLY);

      const filter: HitchSummaryFilter = {
        sinceMs: Date.parse("2026-05-01T00:00:00.000Z"),
        untilMs: Date.parse("2026-07-01T00:00:00.000Z"),
      };
      const summary = buildHitchSummary(db, "course-1", filter);

      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-w-in");
      expect(ids).not.toContain("h-w-out");
    } finally {
      db.close();
    }
  });

  it("inclusive lower boundary — hitch with updatedAt === since is included", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-at-since", T_MID);
      const sinceMs = Date.parse(T_MID);

      const summary = buildHitchSummary(db, "course-1", { sinceMs });

      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-w-at-since");
    } finally {
      db.close();
    }
  });

  it("inclusive upper boundary — hitch with updatedAt === until is included", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-at-until", T_MID);
      const untilMs = Date.parse(T_MID);

      const summary = buildHitchSummary(db, "course-1", { untilMs });

      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-w-at-until");
    } finally {
      db.close();
    }
  });

  it("roll-up excludes filtered hitches from openInScopeP0/P1", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      // In-window hitch with a P0
      seedHitch(repo, phases, db, "h-w-rollup-in", T_MID, true);
      // Out-of-window hitch with a P0 — must NOT be counted
      seedHitch(repo, phases, db, "h-w-rollup-out", T_EARLY, true);

      const filter: HitchSummaryFilter = {
        sinceMs: Date.parse("2026-05-01T00:00:00.000Z"),
        untilMs: Date.parse("2026-07-01T00:00:00.000Z"),
      };
      const summary = buildHitchSummary(db, "course-1", filter);

      expect(summary.openInScopeP0).toBe(1); // only the in-window hitch
    } finally {
      db.close();
    }
  });

  it("since-only: includes hitches with updatedAt >= since", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-since-yes", T_MID);
      seedHitch(repo, phases, db, "h-w-since-no", T_EARLY);

      const summary = buildHitchSummary(db, "course-1", {
        sinceMs: Date.parse("2026-05-01T00:00:00.000Z"),
      });

      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-w-since-yes");
      expect(ids).not.toContain("h-w-since-no");
    } finally {
      db.close();
    }
  });

  it("until-only: includes hitches with updatedAt <= until", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-until-yes", T_EARLY);
      seedHitch(repo, phases, db, "h-w-until-no", T_LATE);

      const summary = buildHitchSummary(db, "course-1", {
        untilMs: Date.parse("2026-06-01T00:00:00.000Z"),
      });

      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-w-until-yes");
      expect(ids).not.toContain("h-w-until-no");
    } finally {
      db.close();
    }
  });

  it("`window` is present and canonical ISO when filter is active", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-iso", T_MID);

      const sinceMs = Date.parse("2026-06-01T00:00:00.000Z");
      const summary = buildHitchSummary(db, "course-1", { sinceMs });

      expect(summary.window).toEqual({
        sinceIso: "2026-06-01T00:00:00.000Z",
        untilIso: null,
      });
    } finally {
      db.close();
    }
  });

  it("empty-result window: no matching hitch → hitches empty, openInScopeP0 === 0", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-empty", T_EARLY);

      const filter: HitchSummaryFilter = {
        sinceMs: Date.parse("2026-11-01T00:00:00.000Z"),
        untilMs: Date.parse("2026-12-30T00:00:00.000Z"),
      };
      const summary = buildHitchSummary(db, "course-1", filter);

      expect(summary.phases[0]!.hitches).toHaveLength(0);
      expect(summary.openInScopeP0).toBe(0);
    } finally {
      db.close();
    }
  });

  it("fail-closed unparseable timestamp: excluded with filter, included without", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-bad-ts", T_MID);
      // Overwrite with an invalid timestamp
      db.prepare(
        "UPDATE hitch_sessions SET updated_at = ? WHERE hitch_id = ?",
      ).run("not-a-timestamp", "h-w-bad-ts");

      // With an active filter → excluded (fail-closed)
      const withFilter = buildHitchSummary(db, "course-1", {
        sinceMs: Date.parse("2026-01-01T00:00:00.000Z"),
      });
      expect(
        withFilter.phases[0]!.hitches.map((h) => h.hitchId),
      ).not.toContain("h-w-bad-ts");

      // Without filter → included (Stage A fast-path preserved)
      const noFilter = buildHitchSummary(db, "course-1");
      expect(
        noFilter.phases[0]!.hitches.map((h) => h.hitchId),
      ).toContain("h-w-bad-ts");
    } finally {
      db.close();
    }
  });

  it("fail-closed on Date.parse-only-valid timestamp: Feb 31 excluded with filter, included without", () => {
    // '2026-02-31T00:00:00.000Z' is accepted by Date.parse (rolls over to Mar 3)
    // but must be rejected by the strict parser → excluded with any filter active.
    const FEB_31 = "2026-02-31T00:00:00.000Z";
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitch(repo, phases, db, "h-w-feb31", T_MID);
      // Overwrite with the impossible-but-Date.parse-accepted timestamp
      db.prepare(
        "UPDATE hitch_sessions SET updated_at = ? WHERE hitch_id = ?",
      ).run(FEB_31, "h-w-feb31");

      // With an active filter → excluded (fail-closed strict parser rejects Feb 31)
      const withFilter = buildHitchSummary(db, "course-1", {
        sinceMs: Date.parse("2026-01-01T00:00:00.000Z"),
      });
      expect(
        withFilter.phases[0]!.hitches.map((h) => h.hitchId),
      ).not.toContain("h-w-feb31");

      // Without filter → included (fast-path bypasses parsing entirely)
      const noFilter = buildHitchSummary(db, "course-1");
      expect(
        noFilter.phases[0]!.hitches.map((h) => h.hitchId),
      ).toContain("h-w-feb31");
    } finally {
      db.close();
    }
  });
});

// ── Stage C: status/domain filter predicates ─────────────────────────────────

/**
 * Seed a hitch with optional domain, status, and P0 finding. Caller must call
 * `seedCoursePhase` first. Reuses the Stage B `seedHitch` deterministic-timestamp
 * pattern for `updatedAt`.
 */
function seedHitchC(
  repo: HitchRepository,
  phases: PhaseRepository,
  db: ReturnType<typeof fresh>["db"],
  hitchId: string,
  opts: {
    updatedAt?: string;
    domain?: string;
    status?: "open" | "closed" | "cancelled" | "escalated";
    addP0?: boolean;
  } = {},
): void {
  const { updatedAt = "2026-06-01T00:00:00.000Z", domain, status, addP0 = false } = opts;
  repo.createSession({
    hitchId,
    title: `Hitch ${hitchId}`,
    scope: {},
    closeConditions: [],
    createdBy: "t",
    createdSource: "cli",
    ...(domain !== undefined ? { domain } : {}),
  });
  phases.linkHitch("phase-1", hitchId);
  if (status !== undefined && status !== "open") {
    repo.updateStatus(hitchId, status, "test setup", { createdBy: "t" });
  }
  if (addP0) {
    repo.upsertFinding({
      hitchId,
      source: "review",
      severity: "P0",
      category: "correctness",
      summary: "p0 finding",
      scopeStatus: "in_scope",
      lifecycleStatus: "open",
    });
  }
  // Set deterministic timestamp LAST (upsertFinding / updateStatus touch updated_at).
  db.prepare(
    "UPDATE hitch_sessions SET updated_at = ? WHERE hitch_id = ?",
  ).run(updatedAt, hitchId);
}

describe("buildHitchSummary — Stage C status/domain filter (#84)", () => {
  it("status include: only the matching-status hitch is returned", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitchC(repo, phases, db, "h-c-status-closed", { status: "closed" });
      seedHitchC(repo, phases, db, "h-c-status-open", { status: "open" });

      const summary = buildHitchSummary(db, "course-1", { status: "closed" });
      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-c-status-closed");
      expect(ids).not.toContain("h-c-status-open");
    } finally {
      db.close();
    }
  });

  it("status exclude: non-matching status is absent from result", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitchC(repo, phases, db, "h-c-excl-esc", { status: "escalated" });
      seedHitchC(repo, phases, db, "h-c-excl-open", { status: "open" });

      const summary = buildHitchSummary(db, "course-1", { status: "open" });
      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-c-excl-open");
      expect(ids).not.toContain("h-c-excl-esc");
    } finally {
      db.close();
    }
  });

  it("domain include: only the matching-domain hitch is returned", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitchC(repo, phases, db, "h-c-dom-match", { domain: "apps/a" });
      seedHitchC(repo, phases, db, "h-c-dom-other", { domain: "apps/b" });

      const summary = buildHitchSummary(db, "course-1", { domain: "apps/a" });
      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-c-dom-match");
      expect(ids).not.toContain("h-c-dom-other");
    } finally {
      db.close();
    }
  });

  it("domain exclude: null-domain session never matches a provided domain filter", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitchC(repo, phases, db, "h-c-dom-null", {}); // domain omitted → null
      seedHitchC(repo, phases, db, "h-c-dom-a", { domain: "apps/a" });

      const summary = buildHitchSummary(db, "course-1", { domain: "apps/a" });
      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-c-dom-a");
      expect(ids).not.toContain("h-c-dom-null");
    } finally {
      db.close();
    }
  });

  it("AND semantics: status AND domain both required", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      // Matches both
      seedHitchC(repo, phases, db, "h-c-and-both", { status: "closed", domain: "apps/a" });
      // Closed but wrong domain
      seedHitchC(repo, phases, db, "h-c-and-closed-wrong-dom", { status: "closed", domain: "apps/b" });
      // Correct domain but not closed
      seedHitchC(repo, phases, db, "h-c-and-open-right-dom", { status: "open", domain: "apps/a" });

      const summary = buildHitchSummary(db, "course-1", { status: "closed", domain: "apps/a" });
      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-c-and-both");
      expect(ids).not.toContain("h-c-and-closed-wrong-dom");
      expect(ids).not.toContain("h-c-and-open-right-dom");
    } finally {
      db.close();
    }
  });

  it("AND semantics: status combined with sinceMs window", () => {
    const T_EARLY_C = "2026-01-01T00:00:00.000Z";
    const T_MID_C = "2026-06-01T00:00:00.000Z";
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      // Closed AND in window — must appear
      seedHitchC(repo, phases, db, "h-c-and-win-ok", { status: "closed", updatedAt: T_MID_C });
      // Closed but out of window — excluded
      seedHitchC(repo, phases, db, "h-c-and-win-old", { status: "closed", updatedAt: T_EARLY_C });
      // In window but open — excluded
      seedHitchC(repo, phases, db, "h-c-and-win-open", { status: "open", updatedAt: T_MID_C });

      const summary = buildHitchSummary(db, "course-1", {
        status: "closed",
        sinceMs: Date.parse("2026-05-01T00:00:00.000Z"),
      });
      const ids = summary.phases[0]!.hitches.map((h) => h.hitchId);
      expect(ids).toContain("h-c-and-win-ok");
      expect(ids).not.toContain("h-c-and-win-old");
      expect(ids).not.toContain("h-c-and-win-open");
    } finally {
      db.close();
    }
  });

  it("roll-up excludes filtered-out hitches from openInScopeP0/P1", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      // Included hitch (closed, with P0)
      seedHitchC(repo, phases, db, "h-c-rollup-in", { status: "closed", addP0: true });
      // Excluded hitch (open, with P0) — must NOT be counted
      seedHitchC(repo, phases, db, "h-c-rollup-out", { status: "open", addP0: true });

      const summary = buildHitchSummary(db, "course-1", { status: "closed" });
      expect(summary.openInScopeP0).toBe(1);
    } finally {
      db.close();
    }
  });

  it("projection echo: statusFilter present when status filter active", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitchC(repo, phases, db, "h-c-echo-status", { status: "closed" });

      const summary = buildHitchSummary(db, "course-1", { status: "closed" });
      expect(summary.statusFilter).toBe("closed");
    } finally {
      db.close();
    }
  });

  it("projection echo: domainFilter present when domain filter active", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitchC(repo, phases, db, "h-c-echo-domain", { domain: "apps/a" });

      const summary = buildHitchSummary(db, "course-1", { domain: "apps/a" });
      expect(summary.domainFilter).toBe("apps/a");
    } finally {
      db.close();
    }
  });

  it("no filter (default arg) — no statusFilter or domainFilter in result", () => {
    const { db, courses, phases, repo } = fresh();
    try {
      seedCoursePhase(courses, phases);
      seedHitchC(repo, phases, db, "h-c-nofilter", { status: "closed", domain: "apps/a" });

      const summary = buildHitchSummary(db, "course-1");
      // Stage A/B: all hitches included
      expect(summary.phases[0]!.hitches).toHaveLength(1);
      // Stage C: no echo fields when no filter
      expect(summary).not.toHaveProperty("statusFilter");
      expect(summary).not.toHaveProperty("domainFilter");
    } finally {
      db.close();
    }
  });
});
