import type Database from "better-sqlite3";
import { HitchRepository } from "../hitch/repository.js";
import { PhaseRepository } from "./phase-repository.js";
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
}

export interface CourseRollup {
  courseId: string;
  phases: PhaseRollup[]; // flattened, in tree pre-order
  openP0: number;
  openP1: number;
  phaseCountsByStatus: Record<PhaseStatus, number>;
}

/** Live open in-scope P0/P1 for a hitch — read from hitch_findings, never a snapshot.
 * NOTE: listFindings defaults to limit 200; pass an explicit large limit so a
 * hitch with >200 findings cannot silently hide open P0/P1 (the SP-1 invariant). */
function openCounts(
  hitches: HitchRepository,
  hitchId: string,
): { p0: number; p1: number } {
  const open = hitches.listFindings({
    hitchId,
    scopeStatus: "in_scope",
    lifecycleStatus: "open",
    limit: 100_000,
  });
  return {
    p0: open.filter((f) => f.severity === "P0").length,
    p1: open.filter((f) => f.severity === "P1").length,
  };
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
        const c = openCounts(hitches, hid);
        p0 += c.p0;
        p1 += c.p1;
      }
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
