import { ConvergenceService } from "../hitch/convergence.js";
import type { HitchOrchestrationResult } from "../hitch/orchestrator-types.js";
import { DomainLockBusyError, findTransientLeaseCause, LeaseGuardFailedError, LeaseLostError, heartbeatIntervalMs, leaseDurationMs } from "../workspace/db-domain-lock.js";
import { normalizeCourseMaxDrivenHitches, normalizeCourseMaxStepsPerHitch } from "./course-normalize.js";
import type { CoursePhaseAction, DrivenHitch, PhaseOutcome } from "./orchestrator-types.js";
import { type CourseRollup, type PhaseRollup } from "./rollup.js";
import { CourseOrchestrateError, type RunCourseOrchestrationInput, type PlanCourseOrchestrationInput } from "./course-orchestrator-types.js";

/**
 * `CourseOrchestrator` のフリーヘルパー（lease error 判定・input 正規化・phase outcome
 * 整形など。#125 A15: course-orchestrator.ts から behaviour-zero 抽出）。class からのみ
 * 使用。型は ./course-orchestrator-types から import。
 */
export function isCourseLeaseLostError(e: unknown): boolean {
  const cause = findTransientLeaseCause(e);
  return cause instanceof LeaseLostError || cause instanceof LeaseGuardFailedError;
}

export function isCourseLeaseBusyError(e: unknown): boolean {
  return findTransientLeaseCause(e) instanceof DomainLockBusyError;
}

export function courseLeaseLostError(e: unknown): CourseOrchestrateError {
  const cause = findTransientLeaseCause(e) ?? e;
  return new CourseOrchestrateError(
    "lease_lost",
    cause instanceof Error ? cause.message : "course orchestration lease lost",
    {
      causeName: cause instanceof Error ? cause.name : typeof cause,
    },
  );
}

export function courseLeaseBusyError(e: unknown): CourseOrchestrateError {
  const cause = findTransientLeaseCause(e);
  if (!(cause instanceof DomainLockBusyError)) {
    return new CourseOrchestrateError(
      "lease_busy",
      e instanceof Error ? e.message : "course orchestration lease is busy",
    );
  }
  return new CourseOrchestrateError("lease_busy", cause.message, {
    domainKey: cause.domainKey,
    holder: cause.holder,
  });
}

export function courseLeaseHeartbeatIntervalMs(): number {
  return Math.max(
    1,
    Math.min(heartbeatIntervalMs(), Math.floor(leaseDurationMs() / 2)),
  );
}

export function normalizeRunInput(
  input: RunCourseOrchestrationInput,
): RunCourseOrchestrationInput {
  return {
    ...input,
    maxDrivenHitches: normalizeCourseMaxDrivenHitches(input.maxDrivenHitches),
    maxStepsPerHitch: normalizeCourseMaxStepsPerHitch(input.maxStepsPerHitch),
  };
}

export function normalizePlanInput(
  input: PlanCourseOrchestrationInput,
): PlanCourseOrchestrationInput {
  return {
    ...input,
    maxDrivenHitches: normalizeCourseMaxDrivenHitches(input.maxDrivenHitches),
    maxStepsPerHitch: normalizeCourseMaxStepsPerHitch(input.maxStepsPerHitch),
  };
}

export function isLeafPhase(phases: PhaseRollup[], index: number): boolean {
  const next = phases[index + 1];
  return next === undefined || next.depth <= phases[index]!.depth;
}

export function outcomeForAction(
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

export function phaseStatusSkipOutcome(
  phaseId: string,
  phaseDriven: DrivenHitch[],
  status: "blocked" | "closed",
): PhaseOutcome {
  return {
    phaseId,
    action: status === "blocked" ? "skip_blocked" : "skip_closed",
    drivenHitches: phaseDriven,
  };
}

export function toDrivenHitch(result: HitchOrchestrationResult): DrivenHitch {
  return {
    hitchId: result.hitchId,
    outcome: result.outcome,
    stepCount: result.steps.length,
  };
}

export function hasOutcomeFor(outcomes: PhaseOutcome[], phaseId: string): boolean {
  return outcomes.some((outcome) => outcome.phaseId === phaseId);
}

export function followUpsFor(
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
