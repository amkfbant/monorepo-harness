import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { DEFAULT_HITCH_POLICY } from "../../../src/hitch/types.js";
import type { HitchNextAction } from "../../../src/hitch/types.js";
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

  it("breaks latestDecision created_at ties by decisionId across linked hitches", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-tie", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-tie", createdBy: "t", createdSource: "cli" });
    const high = hitches.createSession({ title: "H-high", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    const low = hitches.createSession({ title: "H-low", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, high.hitchId, "2026-06-12T00:00:00.000Z");
    phases.linkHitch(p.phaseId, low.hitchId, "2026-06-12T00:00:01.000Z");
    const createdAt = "2026-06-12T01:00:00.000Z";
    hitches.recordConvergenceDecision({
      decisionId: "decision-z",
      hitchId: high.hitchId,
      decision: "close_ready",
      reason: "same timestamp high id",
      createdAt,
      createdBy: "t",
    });
    hitches.recordConvergenceDecision({
      decisionId: "decision-a",
      hitchId: low.hitchId,
      decision: "needs_fix",
      reason: "same timestamp low id",
      createdAt,
      createdBy: "t",
    });

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.latestDecision).toBe("close_ready");
  });

  it("re-derives the rollup decision to `closed` for a force-closed hitch (#171: stale stored `diverging` is suppressed)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-force", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-force", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({ title: "H-force", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, h.hitchId);
    // The orchestrator stopped on divergence and recorded it as the latest decision …
    hitches.recordConvergenceDecision({
      hitchId: h.hitchId,
      decision: "diverging",
      reason: "total new findings exceeded hitch budget",
      createdBy: "t",
    });
    // … then the operator took over, resolved/deferred everything, and force-closed
    // the hitch + phase. `hitch close --force` (updateStatus) records NO decision row,
    // so the stored latest decision stays the stale `diverging`.
    hitches.updateStatus(h.hitchId, "closed", "operator takeover: PR #999 merged", { createdBy: "op" });
    phases.setStatus(p.phaseId, "closed");

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    // The closed session re-derives live to `closed`; the stale `diverging` must NOT show.
    expect(rollup.phases[0]!.latestDecision).toBe("closed");
  });

  it("re-derives the rollup decision to `cancel` for a cancelled hitch whose last recorded decision was `diverging` (#171)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-cancel", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-cancel", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({ title: "H-cancel", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, h.hitchId);
    hitches.recordConvergenceDecision({
      hitchId: h.hitchId,
      decision: "diverging",
      reason: "a finding reopened too many times",
      createdBy: "t",
    });
    hitches.updateStatus(h.hitchId, "cancelled", "abandoned, superseded by new hitch", { createdBy: "op" });

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.latestDecision).toBe("cancel");
  });

  it("preserves a recorded `diverging` decision for an ACTIVE (non-terminal) hitch — #171 only re-derives terminal closures (audit value kept)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-active", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-active", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({ title: "H-active", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, h.hitchId);
    hitches.recordConvergenceDecision({
      hitchId: h.hitchId,
      decision: "diverging",
      reason: "total new findings exceeded hitch budget",
      createdBy: "t",
    });
    // Hitch is left in_progress (not closed/cancelled): the recorded decision is the
    // most recent audit value and must remain displayed for an active hitch.
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.latestDecision).toBe("diverging");
  });

  it("multi-hitch phase: terminal-selected hitch shows `closed` but an active sibling's open P1 keeps it unready (#171)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-multi", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-multi", createdBy: "t", createdSource: "cli" });
    const active = hitches.createSession({ title: "H-active", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    const forced = hitches.createSession({ title: "H-forced", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, active.hitchId, "2026-06-12T00:00:00.000Z");
    phases.linkHitch(p.phaseId, forced.hitchId, "2026-06-12T00:00:01.000Z");
    // active sibling: older recorded decision + a live open in-scope P1 blocker
    hitches.recordConvergenceDecision({
      hitchId: active.hitchId,
      decision: "needs_fix",
      reason: "open P1",
      createdAt: "2026-06-12T01:00:00.000Z",
      createdBy: "t",
    });
    hitches.upsertFinding({
      hitchId: active.hitchId,
      severity: "P1",
      source: "human",
      category: "correctness",
      summary: "still open on the active sibling",
      scopeStatus: "in_scope",
    });
    // forced hitch: newest recorded decision was `diverging`, then force-closed
    hitches.recordConvergenceDecision({
      hitchId: forced.hitchId,
      decision: "diverging",
      reason: "budget",
      createdAt: "2026-06-12T02:00:00.000Z",
      createdBy: "t",
    });
    hitches.updateStatus(forced.hitchId, "closed", "takeover", { createdBy: "op" });

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    const node = rollup.phases[0]!;
    // The recency-selected (forced) hitch re-derives to `closed` for display …
    expect(node.latestDecision).toBe("closed");
    // … but the live, independent aggregates still surface the active sibling's blocker.
    expect(node.derivedOpenP1).toBeGreaterThanOrEqual(1);
    expect(node.readyToClose).toBe(false);
  });

  it("a force-closed hitch with NO recorded decision row reports latestDecision=null (benign — not `diverging`/unresolved; #171)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-nodec", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-nodec", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({ title: "H-nodec", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, h.hitchId);
    // Never recorded a convergence decision; force-closed directly.
    hitches.updateStatus(h.hitchId, "closed", "closed without ever deciding", { createdBy: "op" });
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.latestDecision).toBeNull();
  });

  it("codex#254-P2 FIX1: an advisory severity-audit `continue` row does NOT mask a still-blocking live convergence in the rollup display", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-adv", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-adv", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({ title: "H-adv", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, h.hitchId);
    // LIVE convergence is BLOCKING: an open unknown-scope finding routes
    // needs_classification under the default policy (stopOnUnknownScope).
    hitches.upsertFinding({
      hitchId: h.hitchId,
      severity: "P1",
      source: "review",
      category: "correctness",
      summary: "unknown-scope blocker",
      scopeStatus: "unknown",
    });
    // A genuine blocking decision was recorded first …
    hitches.recordConvergenceDecision({
      hitchId: h.hitchId,
      decision: "needs_classification",
      reason: "unknown-scope findings require classification",
      createdAt: "2026-06-12T01:00:00.000Z",
      createdBy: "t",
    });
    // … then a D2b ADVISORY severity-audit record was written as the NEWEST stored
    // row (decision:"continue", updateStatus:false, marked advisory in metrics).
    // It must NOT become the displayed latest decision while the phase is blocked.
    hitches.recordConvergenceDecision({
      hitchId: h.hitchId,
      decision: "continue",
      reason: "advisory: jury severity vote diverged from the harness mapping (severity unchanged)",
      metrics: { advisorySeverityRecord: true },
      createdAt: "2026-06-12T02:00:00.000Z",
      createdBy: "t",
    });

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    const node = rollup.phases[0]!;
    // The advisory `continue` row must be ignored for DISPLAY: the latest decision
    // reflects the real blocking state, NOT the advisory "continue".
    expect(node.latestDecision).not.toBe("continue");
    expect(node.latestDecision).toBe("needs_classification");
    // The phase is still not ready (live convergence blocks).
    expect(node.readyToClose).toBe(false);
    // The advisory row stays PERSISTED/retrievable (only the display ignores it).
    const stored = hitches.listDecisions(h.hitchId);
    expect(stored.some((d) => d.decision === "continue")).toBe(true);
    expect(
      stored.some(
        (d) =>
          d.decision === "continue" &&
          (d.metrics as { advisorySeverityRecord?: boolean }).advisorySeverityRecord === true,
      ),
    ).toBe(true);
  });

  it("codex#254-R5 P2 FIX2: an UNMARKED (pre-marker) advisory severity-audit `continue` row is shape-detected and still does NOT mask a blocking live convergence", () => {
    // EARLIER #230 builds wrote the D2b advisory record with NO
    // `metrics.advisorySeverityRecord` marker. After upgrading WITHOUT a backfill
    // migration such a row is still the newest stored decision; the rollup must
    // shape-detect it (decision==="continue" AND
    // recommendedNextAction.decisionPacket.decisionKinds includes "severity_audit")
    // so it does not mask a still-blocking live convergence in the DISPLAY.
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({ title: "C-adv-shape", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-adv-shape", createdBy: "t", createdSource: "cli" });
    const h = hitches.createSession({ title: "H-adv-shape", projectId: "demo", scope: {}, closeConditions: [], createdBy: "t", createdSource: "cli" });
    phases.linkHitch(p.phaseId, h.hitchId);
    // LIVE convergence is BLOCKING (open unknown-scope finding -> needs_classification).
    hitches.upsertFinding({
      hitchId: h.hitchId,
      severity: "P1",
      source: "review",
      category: "correctness",
      summary: "unknown-scope blocker",
      scopeStatus: "unknown",
    });
    // A genuine blocking decision was recorded first …
    hitches.recordConvergenceDecision({
      hitchId: h.hitchId,
      decision: "needs_classification",
      reason: "unknown-scope findings require classification",
      createdAt: "2026-06-12T01:00:00.000Z",
      createdBy: "t",
    });
    // … then a PRE-MARKER advisory severity-audit record (NEWEST row): a status-
    // neutral `continue` whose decision packet ONLY advertises a severity audit.
    // It carries NO `metrics.advisorySeverityRecord` marker — only the SHAPE.
    hitches.recordConvergenceDecision({
      hitchId: h.hitchId,
      decision: "continue",
      reason: "advisory: jury severity vote diverged from the harness mapping (severity unchanged)",
      // NB: NO advisorySeverityRecord metric — this is the pre-marker case.
      metrics: {},
      recommendedNextAction: {
        kind: "ask_human",
        message: "severity audit diverged (advisory only)",
        decisionPacket: { decisionKinds: ["severity_audit"] },
      } as unknown as HitchNextAction,
      createdAt: "2026-06-12T02:00:00.000Z",
      createdBy: "t",
    });

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    const node = rollup.phases[0]!;
    // The UNMARKED advisory `continue` row must be ignored for DISPLAY via shape
    // detection: the latest decision reflects the real blocking state.
    expect(node.latestDecision).not.toBe("continue");
    expect(node.latestDecision).toBe("needs_classification");
    expect(node.readyToClose).toBe(false);
    // The advisory row stays PERSISTED/retrievable (only the display ignores it).
    const stored = hitches.listDecisions(h.hitchId);
    expect(stored.some((d) => d.decision === "continue")).toBe(true);
    // And it genuinely carried NO marker (it was shape-detected, not marker-detected).
    const advisory = stored.find((d) => d.decision === "continue");
    expect(
      (advisory?.metrics as { advisorySeverityRecord?: boolean }).advisorySeverityRecord,
    ).toBeUndefined();
  });

  it("exposes a phase operator note in the rollup (#171b)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const c = courses.create({ title: "C-note", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P-note", createdBy: "t", createdSource: "cli" });
    phases.setNote(p.phaseId, "force-closed after PR #999 merged; findings all fixed/deferred");
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.note).toBe(
      "force-closed after PR #999 merged; findings all fixed/deferred",
    );
  });

  it("reports a null phase note when none is set (#171b)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const c = courses.create({ title: "C-nonote", projectId: "demo", createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, title: "P-nonote", createdBy: "t", createdSource: "cli" });
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.phases[0]!.note).toBeNull();
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
        hitches.updateStatus(h.hitchId, "closed", "declared closed", {
          createdBy: "test",
        });
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

  function seedHitchRunUsage(
    hitchId: string,
    runId: string,
    kinds: ReadonlyArray<["coder" | "reviewer" | "evaluator", number]>,
  ): void {
    conn
      .prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, updated_at)
         VALUES (?, 't', 'apps/web', 'domain-coding', 'main', 'needs_review',
           '2026-06-13T00:00:00Z')`,
      )
      .run(runId);
    conn
      .prepare(
        `INSERT INTO hitch_attempts
           (attempt_id, hitch_id, iteration, attempt_type, status, run_id,
            created_at)
         VALUES (?, ?, 1, 'implement', 'succeeded', ?, '2026-06-13T00:00:00Z')`,
      )
      .run(`att-${runId}`, hitchId, runId);
    kinds.forEach(([kind, total], i) => {
      conn
        .prepare(
          `INSERT INTO run_usage
             (run_id, kind, seq, input_tokens, output_tokens, total_tokens,
              usage_source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'exact', '2026-06-13T00:00:00Z')`,
        )
        .run(runId, kind, i, total - 1, 1, total);
    });
  }

  it("sums per-hitch token usage into course tokenTotals (live, by kind)", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({
      title: "C", projectId: "demo", createdBy: "t", createdSource: "cli",
    });
    const mkPhase = (title: string) =>
      phases.add({
        courseId: c.courseId, title, createdBy: "t", createdSource: "cli",
      });
    const mkHitch = (title: string) =>
      hitches.createSession({
        title, projectId: "demo", scope: {}, closeConditions: [],
        createdBy: "t", createdSource: "cli",
      });
    const p1 = mkPhase("P1");
    const p2 = mkPhase("P2");
    const h1 = mkHitch("H1");
    const h2 = mkHitch("H2");
    phases.linkHitch(p1.phaseId, h1.hitchId);
    phases.linkHitch(p2.phaseId, h2.hitchId);
    seedHitchRunUsage(h1.hitchId, "run-1", [
      ["coder", 30],
      ["reviewer", 5],
    ]);
    seedHitchRunUsage(h2.hitchId, "run-2", [
      ["coder", 12],
      ["evaluator", 3],
    ]);

    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.tokenTotals.totalTokens).toBe(50);
    expect(rollup.tokenTotals.runsWithUsage).toBe(2);
    expect(rollup.tokenTotals.byKind.coder.totalTokens).toBe(42);
    expect(rollup.tokenTotals.byKind.reviewer.totalTokens).toBe(5);
    expect(rollup.tokenTotals.byKind.evaluator.totalTokens).toBe(3);
  });

  it("reports zero course tokenTotals when no hitch has usage", () => {
    const courses = new CourseRepository(conn);
    const phases = new PhaseRepository(conn);
    const hitches = new HitchRepository(conn);
    const c = courses.create({
      title: "C", projectId: "demo", createdBy: "t", createdSource: "cli",
    });
    const p = phases.add({
      courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli",
    });
    const h = hitches.createSession({
      title: "H", projectId: "demo", scope: {}, closeConditions: [],
      createdBy: "t", createdSource: "cli",
    });
    phases.linkHitch(p.phaseId, h.hitchId);
    const rollup = rollupCourse({ db: conn, courseId: c.courseId });
    expect(rollup.tokenTotals.totalTokens).toBe(0);
    expect(rollup.tokenTotals.runsWithUsage).toBe(0);
    expect(rollup.tokenTotals.byKind.reviewer.totalTokens).toBe(0);
  });
});
