// Read-only aggregation for `harness hitch summary` (#84 Stage A).
//
// Walks course → phases → linked hitches and builds the `SafeCourseSummary`
// projection consumed by the pure renderer. EVERYTHING here is read-only:
//
//   - NO state transitions (the harness owns those; a summary must not mutate).
//   - NEVER calls `convergence.evaluate()` NOR `rollupCourse()` — rollupCourse
//     runs a per-hitch `evaluate()` (roadmap/rollup.ts), which is both N+1 and a
//     live re-derivation we must not trigger from a report. The latest decision
//     is read from the PERSISTED `hitch_convergence_decisions` rows instead, and
//     the headline P0/P1 roll-up is a plain SUM of per-hitch
//     `countFindingSummary`.
//   - Enumerates hitches via `phases.hitchIdsFor` (phase_hitches), the
//     deterministic course→hitch path.
//
// SAFETY: free-text fields are routed through `redactFreeText` (the only
// `RedactedText` constructor) and findings are mapped field-by-field via
// `toSafeFinding` — never spread — so B列 columns (detail/filePath/symbol/…)
// cannot reach the projection. See reporter/hitch-summary.ts for the model.

import type Database from "better-sqlite3";
import { CourseRepository } from "../../roadmap/course-repository.js";
import { PhaseRepository } from "../../roadmap/phase-repository.js";
import { HitchRepository } from "../../hitch/repository.js";
import { latestCodingRunId, runPr } from "../../hitch/repositories/shared.js";
import { isAdvisorySeverityRecord } from "../../hitch/convergence-status.js";
import type {
  HitchConvergenceDecision,
  HitchConvergenceDecisionRecord,
  HitchFinding,
  HitchLifecycleEvent,
  HitchStatus,
} from "../../hitch/types.js";
import {
  redactFreeText,
  type InterventionCounts,
  type SafeCourseSummary,
  type SafeFindingLine,
  type SafeHitchLine,
  type SafePhaseGroup,
} from "../../reporter/hitch-summary.js";

/** Mirror `hitch status` (10_000): bounded but lists every finding. */
const FINDING_LIST_LIMIT = 10_000;

/**
 * Displayed "latest decision" for a hitch — mirrors the rollup DISPLAY rule
 * (roadmap/rollup.ts `latestDecisionForPhase`) WITHOUT calling `evaluate()`:
 *   1. a terminally closed/cancelled session reports its LIVE terminal status
 *      ("closed"/"cancel") — force-close/cancel record no decision row, so the
 *      last stored row is stale (#171);
 *   2. otherwise the newest NON-advisory decision — advisory severity-audit rows
 *      (codex#254-P2 FIX1) must never mask a still-blocking live state.
 * `listDecisions` is ASC, so the last non-advisory row is the newest.
 */
function latestHitchDecision(
  status: HitchStatus,
  decisions: readonly HitchConvergenceDecisionRecord[],
): HitchConvergenceDecision | null {
  if (status === "closed") return "closed";
  if (status === "cancelled") return "cancel";
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i]!;
    if (!isAdvisorySeverityRecord(d)) return d.decision;
  }
  return null;
}

function toSafeFinding(f: HitchFinding): SafeFindingLine {
  // ALLOWLIST — explicit named fields ONLY (never `...f`). Adding a new
  // free-text column to HitchFinding must not silently surface it here.
  return {
    findingId: f.findingId,
    source: f.source,
    severity: f.severity,
    scopeStatus: f.scopeStatus,
    lifecycleStatus: f.lifecycleStatus,
    category: redactFreeText(f.category),
    summary: redactFreeText(f.summary),
    firstSeenAt: f.firstSeenAt,
  };
}

function countInterventions(
  events: readonly HitchLifecycleEvent[],
): InterventionCounts {
  const c: InterventionCounts = {
    reopened: 0,
    prAdopted: 0,
    divergingRecovered: 0,
    updated: 0,
  };
  for (const e of events) {
    if (e.event === "reopened") c.reopened += 1;
    else if (e.event === "pr_adopted") c.prAdopted += 1;
    else if (e.event === "diverging_recovered") c.divergingRecovered += 1;
    else if (e.event === "updated") c.updated += 1;
  }
  return c;
}

/**
 * Extract ONLY the `{number,url}` scalars from the latest `pr_adopted` event's
 * `detail.adoptedPr`. The rest of `detail` is a withheld B列 blob — never read.
 * Strict typeof guards keep a malformed payload fail-closed (→ null). Events are
 * ASC, so the last match wins (re-adoption supersedes).
 */
function adoptedPr(
  events: readonly HitchLifecycleEvent[],
): { number: number | null; url: string | null } | null {
  let found: { number: number | null; url: string | null } | null = null;
  for (const e of events) {
    if (e.event !== "pr_adopted" || e.detail === null) continue;
    const ap = (e.detail as Record<string, unknown>).adoptedPr;
    if (ap === null || typeof ap !== "object") continue;
    const rec = ap as Record<string, unknown>;
    const number = typeof rec.number === "number" ? rec.number : null;
    const url = typeof rec.url === "string" ? rec.url : null;
    if (number === null && url === null) continue;
    found = { number, url };
  }
  return found;
}

/**
 * Adopted PR (operator takeover) takes precedence: `adoptPr` writes the adopted
 * PR into the lifecycle event, NOT into `runs`, so `runPr(latestCodingRunId)`
 * would return the SUPERSEDED PR for an adopted hitch. Fall back to the run's PR
 * columns only when there is no adoption.
 */
function resolvePr(
  db: Database.Database,
  hitchId: string,
  events: readonly HitchLifecycleEvent[],
): { number: number | null; url: string | null } | null {
  const adopted = adoptedPr(events);
  if (adopted !== null) return adopted;
  const runId = latestCodingRunId(db, hitchId);
  if (runId === null) return null;
  const pr = runPr(db, runId);
  return pr === null ? null : { number: pr.number, url: pr.url };
}

function buildHitchLine(
  db: Database.Database,
  repo: HitchRepository,
  hitchId: string,
): SafeHitchLine | null {
  // A dangling phase_hitches link (session deleted) is skipped — a read-only
  // report must not throw on a data inconsistency.
  const session = repo.getSession(hitchId);
  if (session === null) return null;
  const events = repo.listLifecycleEvents(hitchId);
  return {
    hitchId,
    title: redactFreeText(session.title),
    status: session.status,
    latestDecision: latestHitchDecision(
      session.status,
      repo.listDecisions(hitchId),
    ),
    findingCounts: repo.countFindingSummary(hitchId),
    escalated: session.status === "escalated",
    interventionCounts: countInterventions(events),
    pr: resolvePr(db, hitchId, events),
    findings: repo
      .listFindings({ hitchId, limit: FINDING_LIST_LIMIT })
      .map(toSafeFinding),
  };
}

export function buildHitchSummary(
  db: Database.Database,
  courseId: string,
): SafeCourseSummary {
  const courses = new CourseRepository(db);
  const phases = new PhaseRepository(db);
  const repo = new HitchRepository(db);

  const course = courses.require(courseId); // throws CourseUserError if absent

  // Build each hitch at most once (phase_hitches PK is hitch_id, but cache is
  // defensive) so the roll-up sum cannot double-count.
  const built = new Map<string, SafeHitchLine>();
  const getHitch = (hitchId: string): SafeHitchLine | null => {
    const cached = built.get(hitchId);
    if (cached !== undefined) return cached;
    const line = buildHitchLine(db, repo, hitchId);
    if (line !== null) built.set(hitchId, line);
    return line;
  };

  const phaseGroups: SafePhaseGroup[] = phases
    .listForCourse(courseId)
    .map((phase) => ({
      phaseId: phase.phaseId,
      title: redactFreeText(phase.title),
      status: phase.status,
      hitches: phases
        .hitchIdsFor(phase.phaseId)
        .map(getHitch)
        .filter((h): h is SafeHitchLine => h !== null),
    }));

  let openInScopeP0 = 0;
  let openInScopeP1 = 0;
  for (const h of built.values()) {
    openInScopeP0 += h.findingCounts.openInScopeP0;
    openInScopeP1 += h.findingCounts.openInScopeP1;
  }

  return {
    courseId: course.courseId,
    title: redactFreeText(course.title),
    description:
      course.description === null ? null : redactFreeText(course.description),
    status: course.status,
    openInScopeP0,
    openInScopeP1,
    phases: phaseGroups,
  };
}
