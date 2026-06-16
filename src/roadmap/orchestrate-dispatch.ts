import { allowedByConvergence } from "../hitch/mutation-gate.js";
import type {
  HitchConvergenceDecision,
  HitchConvergenceResult,
} from "../hitch/types.js";
import type { CoursePhaseAction } from "./orchestrator-types.js";
import type { PhaseStatus } from "./types.js";

// At the course layer, a linked hitch whose convergence decision is one of
// these blocks the phase and isolates its subtree (no auto-progress this pass).
// `needs_classification` is treated differently across the three layers, all
// deterministic and fail-closed:
//   - MCP per-step gate (mutation-gate.ts): does not permit an autonomous step.
//   - hitch loop (HitchOrchestrator): auto-classifies / auto-defers via the
//     runner dispatch and keeps going.
//   - course dispatch (here): stops and isolates the subtree, leaving
//     classification to an operator rather than auto-resolving across phases.
// See the three-layer table in docs/specs/hitch-convergence.md.
//
// Exported (codex#254-P2): the course-orchestrator re-uses this SAME set for the
// POST-drive convergence re-check, so the pre-drive gate and the post-drive
// subtree-isolation share one source of truth (no drift between the two).
export const BLOCKED_DECISIONS = new Set<HitchConvergenceDecision>([
  "escalate",
  "diverging",
  "budget_exhausted",
  "needs_classification",
]);

export interface CoursePhaseDispatchInput {
  declaredStatus: PhaseStatus;
  isLeaf: boolean;
  hitches: { hitchId: string; convergence: HitchConvergenceResult }[];
  derivedOpenP0: number;
  derivedOpenP1: number;
}

/**
 * Deterministic per-phase dispatch. Inputs are the phase's declared status and
 * each linked hitch's live convergence only. The source of truth for
 * drivability is allowedByConvergence.
 */
export function decideCoursePhaseAction(
  input: CoursePhaseDispatchInput,
): CoursePhaseAction {
  if (input.declaredStatus === "closed") return { kind: "skip_closed" };
  if (input.declaredStatus === "blocked") return { kind: "skip_blocked" };

  if (input.hitches.length === 0) {
    return input.isLeaf ? { kind: "needs_link" } : { kind: "container" };
  }

  // blocked_hitch has priority because it triggers subtree isolation.
  for (const h of input.hitches) {
    if (BLOCKED_DECISIONS.has(h.convergence.decision)) {
      return {
        kind: "blocked_hitch",
        hitchId: h.hitchId,
        decision: h.convergence.decision,
      };
    }
  }

  const drivable = input.hitches.filter((h) =>
    allowedByConvergence("hitch.orchestrate", h.convergence),
  );
  if (drivable.length > 0) {
    return { kind: "drive", hitchIds: drivable.map((h) => h.hitchId) };
  }

  const allReady = input.hitches.every(
    (h) =>
      h.convergence.decision === "close_ready" ||
      h.convergence.decision === "closed",
  );
  if (allReady && input.derivedOpenP0 === 0 && input.derivedOpenP1 === 0) {
    return { kind: "ready_to_close" };
  }

  return { kind: "report_only" };
}
