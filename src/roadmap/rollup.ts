import type Database from "better-sqlite3";
import { ConvergenceService } from "../hitch/convergence.js";
import {
  HitchRepository,
  OPEN_FINDING_LIFECYCLES,
} from "../hitch/repository.js";
import { isAdvisorySeverityRecord } from "../hitch/convergence-status.js";
import { PhaseRepository, phaseNote } from "./phase-repository.js";
import { derivePhaseReadiness } from "./ready-to-close.js";
import type { PhaseStatus } from "./types.js";
import {
  hitchTokenUsage,
  sumHitchTokenUsage,
  type DbHitchTokenUsage,
} from "../db/repositories/aggregates.js";

export interface PhaseRollup {
  phaseId: string;
  title: string;
  declaredStatus: PhaseStatus;
  hitchIds: string[];
  derivedOpenP0: number;
  derivedOpenP1: number;
  depth: number;
  latestDecision: string | null;
  /** Operator audit note (#171b), or null. Stored via `phase update --note`. */
  note: string | null;
  readyToClose: boolean;
}

export interface CourseRollup {
  courseId: string;
  phases: PhaseRollup[]; // flattened, in tree pre-order
  openP0: number;
  openP1: number;
  phaseCountsByStatus: Record<PhaseStatus, number>;
  /**
   * Live token usage across the whole course: the sum of every linked hitch's
   * `hitchTokenUsage` (retry-inclusive, by kind). A derived projection like the
   * open P0/P1 counts — never a stored snapshot.
   */
  tokenTotals: DbHitchTokenUsage;
}

/** Live open in-scope P0/P1 for a hitch — SQL aggregate over hitch_findings.
 * Uses the same active lifecycle set as hitch convergence. Uses a direct COUNT
 * aggregate — no row-fetch LIMIT. */
export function openCounts(
  db: Database.Database,
  hitchId: string,
): { p0: number; p1: number } {
  const lifecyclePlaceholders = OPEN_FINDING_LIFECYCLES.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT severity, COUNT(*) AS n FROM hitch_findings
        WHERE hitch_id = ?
          AND scope_status = 'in_scope'
          AND lifecycle_status IN (${lifecyclePlaceholders})
          AND severity IN ('P0','P1')
        GROUP BY severity`,
    )
    .all(hitchId, ...OPEN_FINDING_LIFECYCLES) as Array<{
    severity: string;
    n: number;
  }>;
  let p0 = 0;
  let p1 = 0;
  for (const row of rows) {
    if (row.severity === "P0") p0 = row.n;
    else if (row.severity === "P1") p1 = row.n;
  }
  return { p0, p1 };
}

/**
 * Decision shown for a phase: the most recently recorded `hitch_convergence_
 * decisions.decision` across its hitches (latest by created_at, tie-broken by
 * decisionId), or null if none.
 *
 * #171 — a force-closed / cancelled hitch keeps its last recorded *mid-flight*
 * decision (e.g. `diverging`) in the audit log, but the session is now
 * terminally closed and `hitch close --force` / `cancel` record no decision row,
 * so that stored value is stale for the rollup display. When the selected hitch
 * has been terminally closed/cancelled, report its LIVE decision (`closed` /
 * `cancel`) instead. Active (non-terminal) hitches keep their recorded decision
 * — that is the genuine latest audit value and `readyToClose` already reflects
 * live convergence independently.
 *
 * codex#254-P2 FIX1 — advisory D2b severity-audit rows are skipped via the
 * shared {@link isAdvisorySeverityRecord} predicate (hitch/convergence-status)
 * so a still-blocking live state is never masked. The blocking GATE is
 * unaffected: it uses live `convergence.evaluate()`, never this display value.
 */
function latestDecisionForPhase(
  hitches: HitchRepository,
  hitchIds: string[],
  liveDecisionByHitch: ReadonlyMap<string, string>,
): string | null {
  let latest:
    | { createdAt: string; decisionId: string; decision: string; hitchId: string }
    | null = null;
  for (const hid of hitchIds) {
    // Ignore advisory severity-audit rows for DISPLAY: they are not convergence
    // decisions and must never mask a blocking live state. The newest
    // NON-advisory row is the genuine latest decision.
    const decisions = hitches
      .listDecisions(hid)
      .filter((d) => !isAdvisorySeverityRecord(d));
    if (decisions.length === 0) continue;
    // listDecisions returns records in ASC order; last item is newest
    const newest = decisions[decisions.length - 1]!;
    if (
      latest === null ||
      newest.createdAt > latest.createdAt ||
      (newest.createdAt === latest.createdAt &&
        newest.decisionId > latest.decisionId)
    ) {
      latest = {
        createdAt: newest.createdAt,
        decisionId: newest.decisionId,
        decision: newest.decision,
        hitchId: hid,
      };
    }
  }
  if (latest === null) return null;
  const live = liveDecisionByHitch.get(latest.hitchId);
  if (live === "closed" || live === "cancel") return live;
  return latest.decision;
}

export function rollupCourse(opts: {
  db: Database.Database;
  courseId: string;
}): CourseRollup {
  const phases = new PhaseRepository(opts.db);
  const hitches = new HitchRepository(opts.db);
  const convergence = new ConvergenceService(new HitchRepository(opts.db));
  const tree = phases.tree(opts.courseId);
  const allPhases = phases.listForCourse(opts.courseId);
  const flat: PhaseRollup[] = [];
  const counts: Record<PhaseStatus, number> = {
    pending: 0,
    in_progress: 0,
    closed: 0,
    blocked: 0,
  };
  let totalP0 = 0,
    totalP1 = 0;
  const hitchUsages: DbHitchTokenUsage[] = [];
  const walk = (
    nodes: ReturnType<PhaseRepository["tree"]>,
    depth: number,
  ): void => {
    for (const n of nodes) {
      const hitchIds = phases.hitchIdsFor(n.phase.phaseId);
      let p0 = 0,
        p1 = 0;
      for (const hid of hitchIds) {
        const c = openCounts(opts.db, hid);
        p0 += c.p0;
        p1 += c.p1;
        hitchUsages.push(hitchTokenUsage(opts.db, hid));
      }
      const hitchConvergences = hitchIds.map((hitchId) =>
        convergence.evaluate(hitchId),
      );
      const liveDecisionByHitch = new Map<string, string>(
        hitchIds.map((hid, i) => [hid, hitchConvergences[i]!.decision]),
      );
      counts[n.phase.status] += 1;
      totalP0 += p0;
      totalP1 += p1;
      flat.push({
        phaseId: n.phase.phaseId,
        title: n.phase.title,
        declaredStatus: n.phase.status,
        hitchIds,
        derivedOpenP0: p0,
        derivedOpenP1: p1,
        depth,
        latestDecision: latestDecisionForPhase(
          hitches,
          hitchIds,
          liveDecisionByHitch,
        ),
        note: phaseNote(n.phase),
        readyToClose: derivePhaseReadiness({
          hitchConvergences,
          derivedOpenP0: p0,
          derivedOpenP1: p1,
        }),
      });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  // Tree integrity guard (fail-closed): if the tree walk did not reach all
  // phases, there is a cycle or orphaned parent — throw rather than
  // under-reporting open P0/P1.
  if (flat.length !== allPhases.length) {
    throw new Error(
      `course ${opts.courseId} phase tree is inconsistent (cycle or orphan parent)`,
    );
  }
  return {
    courseId: opts.courseId,
    phases: flat,
    openP0: totalP0,
    openP1: totalP1,
    phaseCountsByStatus: counts,
    tokenTotals: sumHitchTokenUsage(hitchUsages),
  };
}
