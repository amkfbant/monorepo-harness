import type { OrchestrationOutcome } from "../hitch/orchestrator-types.js";
import type { HitchConvergenceDecision } from "../hitch/types.js";
import type { CourseRollup } from "./rollup.js";

export type CoursePhaseActionKind =
  | "skip_closed"
  | "skip_blocked"
  | "container"
  | "needs_link"
  | "drive"
  | "blocked_hitch"
  | "ready_to_close"
  | "report_only"
  | "blocked_subtree"
  | "not_driven"
  | "partially_driven";

export type CoursePhaseAction =
  | { kind: "skip_closed" }
  | { kind: "skip_blocked" }
  | { kind: "container" }
  | { kind: "needs_link" }
  | { kind: "drive"; hitchIds: string[] }
  | {
      kind: "blocked_hitch";
      hitchId: string;
      decision: HitchConvergenceDecision;
    }
  | { kind: "ready_to_close" }
  | { kind: "report_only" };

export type CourseStopReason = "completed" | "budget_exhausted";

export interface DrivenHitch {
  hitchId: string;
  outcome: OrchestrationOutcome;
  stepCount: number;
}

export interface PhaseOutcome {
  phaseId: string;
  action: CoursePhaseActionKind;
  drivenHitches?: DrivenHitch[];
  blockedHitch?: { hitchId: string; decision: string };
  readyToClose?: boolean;
  note?: string;
}

export interface CourseOrchestrationResult {
  courseId: string;
  stopReason: CourseStopReason;
  phaseOutcomes: PhaseOutcome[];
  drivenHitches: DrivenHitch[];
  rollupAfter: CourseRollup;
  followUps: string[];
}
