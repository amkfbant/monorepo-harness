import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ConvergenceService } from "../hitch/convergence.js";
import type { HitchOrchestrator } from "../hitch/orchestrator.js";
import type {
  HitchOrchestrationResult,
  OrchestratorRunners,
} from "../hitch/orchestrator-types.js";
import { HitchRepository } from "../hitch/repository.js";
import {
  acquireDomainLock,
  DomainLockBusyError,
  type DomainLockHandle,
} from "../workspace/db-domain-lock.js";
import { CourseRepository } from "./course-repository.js";
import { decideCoursePhaseAction } from "./orchestrate-dispatch.js";
import type {
  CourseOrchestrationResult,
  CoursePhaseAction,
  DrivenHitch,
  PhaseOutcome,
} from "./orchestrator-types.js";
import { PhaseRepository } from "./phase-repository.js";
import { rollupCourse, type CourseRollup, type PhaseRollup } from "./rollup.js";

export type CourseOrchestrateErrorCode = "course_not_active" | "lease_busy";

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
  makeRunners(hitchId: string): OrchestratorRunners;
}

export interface RunCourseOrchestrationInput {
  courseId: string;
  maxDrivenHitches: number;
  maxStepsPerHitch: number;
  createdBy: string;
}

export class CourseOrchestrator {
  constructor(private readonly deps: CourseOrchestratorDeps) {}

  async run(
    input: RunCourseOrchestrationInput,
  ): Promise<CourseOrchestrationResult> {
    const normalizedInput = normalizeRunInput(input);
    const courses = new CourseRepository(this.deps.db);
    const course = courses.require(normalizedInput.courseId);
    if (course.status !== "active") {
      throw new CourseOrchestrateError(
        "course_not_active",
        `course ${normalizedInput.courseId} is not active (${course.status})`,
        { courseId: normalizedInput.courseId, status: course.status },
      );
    }

    let lease: DomainLockHandle;
    try {
      lease = acquireDomainLock(this.deps.db, {
        domainKey: `course:${normalizedInput.courseId}`,
        repoId: course.repoId ?? course.projectId ?? course.courseId,
        domain: "course-orchestrate",
        runId: `course-orch-${randomUUID()}`,
        pid: process.pid,
        hostname: hostname(),
      });
    } catch (e) {
      if (e instanceof DomainLockBusyError) {
        throw new CourseOrchestrateError(
          "lease_busy",
          `course ${normalizedInput.courseId} orchestration lease is busy`,
          {
            courseId: normalizedInput.courseId,
            domainKey: e.domainKey,
            holder: e.holder,
          },
        );
      }
      throw e;
    }

    let releaseReason = "aborted";
    try {
      const result = await this.runWithLease(normalizedInput);
      releaseReason =
        result.stopReason === "budget_exhausted"
          ? "budget_exhausted"
          : "normal";
      return result;
    } finally {
      lease.release({
        reason: releaseReason,
        releasedBy: normalizedInput.createdBy,
      });
    }
  }

  private async runWithLease(
    input: RunCourseOrchestrationInput,
  ): Promise<CourseOrchestrationResult> {
    const rollup = rollupCourse({
      db: this.deps.db,
      courseId: input.courseId,
    });
    const phases = new PhaseRepository(this.deps.db);
    const hitches = new HitchRepository(this.deps.db);
    const convergence = new ConvergenceService(hitches);
    const phaseOutcomes: PhaseOutcome[] = [];
    const drivenHitches: DrivenHitch[] = [];
    let subtreeBlocked = false;

    for (let i = 0; i < rollup.phases.length; i++) {
      const phase = rollup.phases[i]!;
      if (phase.depth === 0) subtreeBlocked = false;
      if (subtreeBlocked) {
        phaseOutcomes.push({
          phaseId: phase.phaseId,
          action: "report_only",
          note: "blocked_subtree",
        });
        continue;
      }

      const action = this.actionForPhase(rollup, i, convergence);
      if (action.kind !== "drive") {
        phaseOutcomes.push(outcomeForAction(phase.phaseId, action));
        if (action.kind === "blocked_hitch") subtreeBlocked = true;
        continue;
      }

      const phaseDriven: DrivenHitch[] = [];
      for (let j = 0; j < action.hitchIds.length; j++) {
        if (drivenHitches.length >= input.maxDrivenHitches) {
          phaseOutcomes.push({
            phaseId: phase.phaseId,
            action: "drive",
            drivenHitches: phaseDriven,
            note: "not_driven",
          });
          this.recordNotDriven(rollup.phases, i + 1, phaseOutcomes);
          return this.finalize(
            input.courseId,
            "budget_exhausted",
            phaseOutcomes,
            drivenHitches,
          );
        }

        const currentPhase = phases.require(phase.phaseId);
        if (
          currentPhase.status === "blocked" ||
          currentPhase.status === "closed"
        ) {
          phaseOutcomes.push({
            phaseId: phase.phaseId,
            action: currentPhase.status === "blocked" ? "skip_blocked" : "skip_closed",
            drivenHitches: phaseDriven,
          });
          break;
        }

        if (phaseDriven.length === 0 && currentPhase.status === "pending") {
          const transitioned = phases.transitionStatus(
            phase.phaseId,
            ["pending"],
            "in_progress",
          );
          if (!transitioned) {
            const rereadPhase = phases.require(phase.phaseId);
            if (
              rereadPhase.status === "blocked" ||
              rereadPhase.status === "closed"
            ) {
              phaseOutcomes.push({
                phaseId: phase.phaseId,
                action:
                  rereadPhase.status === "blocked"
                    ? "skip_blocked"
                    : "skip_closed",
                drivenHitches: phaseDriven,
              });
              break;
            }
          }
        }

        const hitchId = action.hitchIds[j]!;
        const result = await this.deps.makeHitchOrchestrator(hitchId).run({
          hitchId,
          runners: this.deps.makeRunners(hitchId),
          maxSteps: input.maxStepsPerHitch,
          stopAtCloseReady: true,
          createdBy: input.createdBy,
        });
        const driven = toDrivenHitch(result);
        phaseDriven.push(driven);
        drivenHitches.push(driven);

        if (result.outcome === "escalated") {
          phaseOutcomes.push({
            phaseId: phase.phaseId,
            action: "blocked_hitch",
            drivenHitches: phaseDriven,
            blockedHitch: {
              hitchId,
              decision: result.finalDecision,
            },
          });
          subtreeBlocked = true;
          break;
        }
      }

      if (!subtreeBlocked && !hasOutcomeFor(phaseOutcomes, phase.phaseId)) {
        phaseOutcomes.push({
          phaseId: phase.phaseId,
          action: "drive",
          drivenHitches: phaseDriven,
        });
      }
    }

    return this.finalize(
      input.courseId,
      "completed",
      phaseOutcomes,
      drivenHitches,
    );
  }

  private actionForPhase(
    rollup: CourseRollup,
    index: number,
    convergence: ConvergenceService,
  ): CoursePhaseAction {
    const phase = rollup.phases[index]!;
    return decideCoursePhaseAction({
      declaredStatus: phase.declaredStatus,
      isLeaf: isLeafPhase(rollup.phases, index),
      hitches: phase.hitchIds.map((hitchId) => ({
        hitchId,
        convergence: convergence.evaluate(hitchId),
      })),
      derivedOpenP0: phase.derivedOpenP0,
      derivedOpenP1: phase.derivedOpenP1,
    });
  }

  private recordNotDriven(
    phases: PhaseRollup[],
    startIndex: number,
    outcomes: PhaseOutcome[],
  ): void {
    for (let i = startIndex; i < phases.length; i++) {
      outcomes.push({
        phaseId: phases[i]!.phaseId,
        action: "report_only",
        note: "not_driven",
      });
    }
  }

  private finalize(
    courseId: string,
    stopReason: CourseOrchestrationResult["stopReason"],
    phaseOutcomes: PhaseOutcome[],
    drivenHitches: DrivenHitch[],
  ): CourseOrchestrationResult {
    const rollupAfter = rollupCourse({ db: this.deps.db, courseId });
    return {
      courseId,
      stopReason,
      phaseOutcomes,
      drivenHitches,
      rollupAfter,
      followUps: followUpsFor(
        rollupAfter,
        new ConvergenceService(new HitchRepository(this.deps.db)),
      ),
    };
  }
}

function normalizeRunInput(
  input: RunCourseOrchestrationInput,
): RunCourseOrchestrationInput {
  return {
    ...input,
    maxDrivenHitches: normalizePositiveInt(
      input.maxDrivenHitches,
      3,
      10,
    ),
    maxStepsPerHitch: normalizePositiveInt(input.maxStepsPerHitch, 20, 50),
  };
}

function normalizePositiveInt(
  value: number,
  defaultValue: number,
  maxValue: number,
): number {
  if (!Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(maxValue, Math.max(1, Math.trunc(value)));
}

function isLeafPhase(phases: PhaseRollup[], index: number): boolean {
  const next = phases[index + 1];
  return next === undefined || next.depth <= phases[index]!.depth;
}

function outcomeForAction(
  phaseId: string,
  action: CoursePhaseAction,
): PhaseOutcome {
  if (action.kind === "blocked_hitch") {
    return {
      phaseId,
      action: action.kind,
      blockedHitch: {
        hitchId: action.hitchId,
        decision: action.decision,
      },
    };
  }
  if (action.kind === "ready_to_close") {
    return { phaseId, action: action.kind, readyToClose: true };
  }
  return { phaseId, action: action.kind };
}

function toDrivenHitch(result: HitchOrchestrationResult): DrivenHitch {
  return {
    hitchId: result.hitchId,
    outcome: result.outcome,
    stepCount: result.steps.length,
  };
}

function hasOutcomeFor(outcomes: PhaseOutcome[], phaseId: string): boolean {
  return outcomes.some((outcome) => outcome.phaseId === phaseId);
}

function followUpsFor(
  rollup: CourseRollup,
  convergence: ConvergenceService,
): string[] {
  const followUps: string[] = [];
  for (let i = 0; i < rollup.phases.length; i++) {
    const phase = rollup.phases[i]!;
    if (phase.readyToClose) {
      for (const hitchId of phase.hitchIds) {
        if (convergence.evaluate(hitchId).decision === "closed") continue;
        followUps.push(`hitch orchestrate ${hitchId}`);
      }
    }
    if (
      phase.hitchIds.length === 0 &&
      phase.declaredStatus !== "blocked" &&
      phase.declaredStatus !== "closed" &&
      isLeafPhase(rollup.phases, i)
    ) {
      followUps.push(`phase ${phase.phaseId} needs_link`);
    }
  }
  return followUps;
}
