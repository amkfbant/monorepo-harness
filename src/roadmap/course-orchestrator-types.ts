import type Database from "better-sqlite3";
import type { HitchOrchestrator } from "../hitch/orchestrator.js";
import type { OrchestratorRunners } from "../hitch/orchestrator-types.js";
import type { CourseStopReason, DrivenHitch, PhaseOutcome } from "./orchestrator-types.js";
import type { PhaseLeaseGuard } from "./phase-repository.js";

/**
 * `CourseOrchestrator` の共有型・エラー・stop reason 定数（#125 A15: cli/roadmap
 * course-orchestrator.ts から behaviour-zero 抽出）。class とフリーヘルパーの双方が
 * 参照するため leaf モジュールに分離（循環回避）。挙動は元ファイル由来で不変。
 */
export type CourseOrchestrateErrorCode =
  | "course_not_active"
  | "lease_busy"
  | "lease_lost"
  | "schema_version_skew";

export class CourseOrchestrateError extends Error {
  constructor(
    public readonly code: CourseOrchestrateErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CourseOrchestrateError";
  }
}

export interface CourseOrchestratorDeps {
  db: Database.Database;
  makeHitchOrchestrator(hitchId: string): HitchOrchestrator;
  /**
   * Build the runners for a hitch. The optional `signal` (#132) is aborted when
   * the course loses its lease mid-drive; production runners thread it to the
   * codex runner so the in-flight codex process is SIGKILLed (fail-closed).
   */
  makeRunners(
    hitchId: string,
    signal?: AbortSignal,
  ): OrchestratorRunners | Promise<OrchestratorRunners>;
}

export interface RunCourseOrchestrationInput {
  courseId: string;
  maxDrivenHitches: number;
  maxStepsPerHitch: number;
  createdBy: string;
}

export interface PlanCourseOrchestrationInput {
  courseId: string;
  maxDrivenHitches: number;
  maxStepsPerHitch: number;
}

export interface WalkCourseInput {
  courseId: string;
  maxDrivenHitches: number;
  maxStepsPerHitch: number;
  createdBy?: string;
}

export interface WalkCourseOptions {
  driveHitch?: (input: {
    hitchId: string;
    maxStepsPerHitch: number;
    createdBy: string;
  }) => Promise<DrivenHitch & { finalDecision: string }>;
  transitionPhaseStatus: boolean;
  beforeDriveHitch?: () => void;
  beforeStatusWrite?: () => void;
  statusWriteLeaseGuard?: () => PhaseLeaseGuard;
}

export interface WalkCourseResult {
  stopReason: CourseStopReason;
  phaseOutcomes: PhaseOutcome[];
  drivenHitches: DrivenHitch[];
}

export const COURSE_STOP_REASON = {
  completed: "completed",
  budgetReached: "budget_reached",
} as const satisfies Record<string, CourseStopReason>;

