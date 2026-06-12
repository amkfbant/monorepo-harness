import type Database from "better-sqlite3";
import { ConvergenceService } from "../hitch/convergence.js";
import {
  HitchRepository,
  OPEN_FINDING_LIFECYCLES,
} from "../hitch/repository.js";
import { PhaseRepository } from "./phase-repository.js";
import { derivePhaseReadiness } from "./ready-to-close.js";
import type { PhaseStatus } from "./types.js";

export interface PhaseRollup {
  phaseId: string;
  title: string;
  declaredStatus: PhaseStatus;
  hitchIds: string[];
  derivedOpenP0: number;
  derivedOpenP1: number;
  depth: number;
  latestDecision: string | null;
  readyToClose: boolean;
}

export interface CourseRollup {
  courseId: string;
  phases: PhaseRollup[]; // flattened, in tree pre-order
  openP0: number;
  openP1: number;
  phaseCountsByStatus: Record<PhaseStatus, number>;
}

/** Live open in-scope P0/P1 for a hitch — SQL aggregate over hitch_findings.
 * Uses the same active lifecycle set as hitch convergence. Uses a direct COUNT
 * aggregate — no row-fetch LIMIT. */
function openCounts(
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

/** Latest convergence decision across all hitches of a phase, or null if none. */
function latestDecisionForPhase(
  hitches: HitchRepository,
  hitchIds: string[],
): string | null {
  let latest: { createdAt: string; decision: string } | null = null;
  for (const hid of hitchIds) {
    const decisions = hitches.listDecisions(hid);
    if (decisions.length === 0) continue;
    // listDecisions returns records in ASC order; last item is newest
    const newest = decisions[decisions.length - 1]!;
    if (latest === null || newest.createdAt >= latest.createdAt) {
      latest = { createdAt: newest.createdAt, decision: newest.decision };
    }
  }
  return latest !== null ? latest.decision : null;
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
      }
      const hitchConvergences = hitchIds.map((hitchId) =>
        convergence.evaluate(hitchId),
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
        latestDecision: latestDecisionForPhase(hitches, hitchIds),
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
  };
}
