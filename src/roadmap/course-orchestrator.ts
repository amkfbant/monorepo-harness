import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ConvergenceService } from "../hitch/convergence.js";
import {
  assertHitchCanStartMutation,
  HitchMutationGateError,
} from "../hitch/mutation-gate.js";
import type { HitchOrchestrator } from "../hitch/orchestrator.js";
import type {
  HitchOrchestrationResult,
  OrchestratorRunners,
} from "../hitch/orchestrator-types.js";
import { HitchRepository } from "../hitch/repository.js";
import {
  acquireDomainLock,
  DomainLockBusyError,
  findTransientLeaseCause,
  LeaseGuardFailedError,
  LeaseLostError,
  heartbeatIntervalMs,
  leaseDurationMs,
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
import type { PhaseLeaseGuard } from "./phase-repository.js";
import {
  openCounts,
  rollupCourse,
  type CourseRollup,
  type PhaseRollup,
} from "./rollup.js";

export type CourseOrchestrateErrorCode =
  | "course_not_active"
  | "lease_busy"
  | "lease_lost";

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
  makeRunners(hitchId: string): OrchestratorRunners | Promise<OrchestratorRunners>;
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

interface WalkCourseInput {
  courseId: string;
  maxDrivenHitches: number;
  maxStepsPerHitch: number;
  createdBy?: string;
}

interface WalkCourseOptions {
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

interface WalkCourseResult {
  stopReason: CourseOrchestrationResult["stopReason"];
  phaseOutcomes: PhaseOutcome[];
  drivenHitches: DrivenHitch[];
}

export class CourseOrchestrator {
  constructor(private readonly deps: CourseOrchestratorDeps) {}

  async plan(input: PlanCourseOrchestrationInput): Promise<PhaseOutcome[]> {
    const normalizedInput = normalizePlanInput(input);
    const courses = new CourseRepository(this.deps.db);
    const course = courses.require(normalizedInput.courseId);
    if (course.status !== "active") {
      throw new CourseOrchestrateError(
        "course_not_active",
        `course ${normalizedInput.courseId} is not active (${course.status})`,
        { courseId: normalizedInput.courseId, status: course.status },
      );
    }

    const result = await this.walkCourse(normalizedInput, {
      transitionPhaseStatus: false,
    });
    return result.phaseOutcomes;
  }

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

    const leaseRunId = `course-orch-${randomUUID()}`;
    let lease: DomainLockHandle;
    try {
      lease = acquireDomainLock(this.deps.db, {
        domainKey: `course:${normalizedInput.courseId}`,
        repoId: course.repoId ?? course.projectId ?? course.courseId,
        domain: "course-orchestrate",
        runId: leaseRunId,
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
      const result = await this.runWithLease(normalizedInput, lease, leaseRunId);
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
    lease: DomainLockHandle,
    leaseRunId: string,
  ): Promise<CourseOrchestrationResult> {
    let result: WalkCourseResult;
    try {
      result = await this.walkCourse(input, {
        transitionPhaseStatus: true,
        beforeDriveHitch: () => lease.heartbeat(),
        beforeStatusWrite: () => lease.assertHeld(),
        statusWriteLeaseGuard: () => ({
          lockId: lease.lockId,
          holderRunId: leaseRunId,
          nowMs: Date.now(),
        }),
        driveHitch: async ({ hitchId, maxStepsPerHitch, createdBy }) => {
          return await this.runWithLeaseHeartbeat(lease, async () => {
            const runners = await this.deps.makeRunners(hitchId);
            const hitchResult = await this.deps.makeHitchOrchestrator(hitchId).run({
              hitchId,
              runners,
              maxSteps: maxStepsPerHitch,
              stopAtCloseReady: true,
              createdBy,
            });
            return {
              ...toDrivenHitch(hitchResult),
              finalDecision: hitchResult.finalDecision,
            };
          });
        },
      });
    } catch (e) {
      if (isCourseLeaseLostError(e)) throw courseLeaseLostError(e);
      if (isCourseLeaseBusyError(e)) throw courseLeaseBusyError(e);
      throw e;
    }
    return this.finalize(
      input.courseId,
      result.stopReason,
      result.phaseOutcomes,
      result.drivenHitches,
    );
  }

  private async runWithLeaseHeartbeat<T>(
    lease: DomainLockHandle,
    drive: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let leaseLost = false;
    let leaseLostError: unknown;

    const stopTimer = (): void => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };

    timer = setInterval(() => {
      try {
        lease.heartbeat();
      } catch (e) {
        leaseLost = true;
        leaseLostError = e;
        stopTimer();
      }
    }, courseLeaseHeartbeatIntervalMs());
    timer.unref?.();

    let driveResult!: T;
    let driveRejected = false;
    let driveError: unknown;
    try {
      driveResult = await drive();
    } catch (e) {
      driveRejected = true;
      driveError = e;
    } finally {
      stopTimer();
    }

    // Do not race away from an in-flight hitch drive on course-lease loss.
    // The hitch/run layer's domain lock and heartbeat still prevent same-domain
    // concurrent execution; force-aborting Codex via AbortSignal is future work.
    if (leaseLost) throw courseLeaseLostError(leaseLostError);
    if (isCourseLeaseLostError(driveError)) {
      throw courseLeaseLostError(driveError);
    }
    if (isCourseLeaseBusyError(driveError)) {
      throw courseLeaseBusyError(driveError);
    }
    if (driveRejected) throw driveError;
    return driveResult;
  }

  private async walkCourse(
    input: WalkCourseInput,
    options: WalkCourseOptions,
  ): Promise<WalkCourseResult> {
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
          action: "blocked_subtree",
          note: "blocked_subtree",
        });
        continue;
      }

      const action = this.actionForPhase(rollup, i, phases, convergence);
      if (action.kind !== "drive") {
        phaseOutcomes.push(outcomeForAction(phase.phaseId, action));
        if (action.kind === "blocked_hitch") subtreeBlocked = true;
        continue;
      }

      const phaseDriven: DrivenHitch[] = [];
      let reportOnly = false;
      for (let j = 0; j < action.hitchIds.length; j++) {
        if (drivenHitches.length >= input.maxDrivenHitches) {
          phaseOutcomes.push({
            phaseId: phase.phaseId,
            action:
              phaseDriven.length === 0 ? "not_driven" : "partially_driven",
            drivenHitches: phaseDriven,
            note:
              phaseDriven.length === 0
                ? "not_driven"
                : "partially_driven_budget_exhausted",
          });
          this.recordNotDriven(rollup.phases, i + 1, phaseOutcomes);
          return {
            stopReason: "budget_exhausted",
            phaseOutcomes,
            drivenHitches,
          };
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

        const hitchId = action.hitchIds[j]!;
        if (options.driveHitch !== undefined) {
          options.beforeDriveHitch?.();
          const gate = this.checkDriveGate(
            hitches,
            convergence,
            hitchId,
            input.createdBy ?? "planner",
          );
          if (gate.kind === "blocked_hitch") {
            phaseOutcomes.push({
              phaseId: phase.phaseId,
              action: "blocked_hitch",
              drivenHitches: phaseDriven,
              blockedHitch: {
                hitchId,
                decision: gate.decision,
              },
            });
            subtreeBlocked = true;
            break;
          }
          if (gate.kind === "report_only") {
            reportOnly = true;
            continue;
          }
        }

        if (
          !this.transitionPhaseBeforeFirstDrive({
            phases,
            phaseId: phase.phaseId,
            phaseDriven,
            options,
            phaseOutcomes,
          })
        ) {
          break;
        }

        const driven =
          options.driveHitch === undefined
            ? {
                hitchId,
                outcome: "close_ready" as const,
                stepCount: 0,
                finalDecision: "planned",
              }
            : await options.driveHitch({
                hitchId,
                maxStepsPerHitch: input.maxStepsPerHitch,
                createdBy: input.createdBy ?? "planner",
              });
        const drivenHitch: DrivenHitch = {
          hitchId: driven.hitchId,
          outcome: driven.outcome,
          stepCount: driven.stepCount,
        };
        if (options.driveHitch !== undefined) {
          phaseDriven.push(drivenHitch);
          drivenHitches.push(drivenHitch);
        } else {
          drivenHitches.push(drivenHitch);
        }

        if (options.driveHitch !== undefined && driven.outcome === "escalated") {
          phaseOutcomes.push({
            phaseId: phase.phaseId,
            action: "blocked_hitch",
            drivenHitches: phaseDriven,
            blockedHitch: {
              hitchId,
              decision: driven.finalDecision,
            },
          });
          subtreeBlocked = true;
          break;
        }
      }

      if (!subtreeBlocked && !hasOutcomeFor(phaseOutcomes, phase.phaseId)) {
        phaseOutcomes.push({
          phaseId: phase.phaseId,
          action: phaseDriven.length === 0 && reportOnly ? "report_only" : "drive",
          drivenHitches: phaseDriven,
          ...(reportOnly ? { note: "report_only" } : {}),
        });
      }
    }

    return {
      stopReason: "completed",
      phaseOutcomes,
      drivenHitches,
    };
  }

  private transitionPhaseBeforeFirstDrive(input: {
    phases: PhaseRepository;
    phaseId: string;
    phaseDriven: DrivenHitch[];
    options: WalkCourseOptions;
    phaseOutcomes: PhaseOutcome[];
  }): boolean {
    if (!input.options.transitionPhaseStatus || input.phaseDriven.length > 0) {
      return true;
    }

    const currentPhase = input.phases.require(input.phaseId);
    if (currentPhase.status === "blocked" || currentPhase.status === "closed") {
      this.recordPhaseStatusSkip(input, currentPhase.status);
      return false;
    }
    if (currentPhase.status !== "pending") return true;

    input.options.beforeStatusWrite?.();
    const leaseGuard = input.options.statusWriteLeaseGuard?.();
    const transitioned = input.phases.transitionStatus(
      input.phaseId,
      ["pending"],
      "in_progress",
      leaseGuard === undefined ? undefined : { leaseGuard },
    );
    if (transitioned) return true;

    const rereadPhase = input.phases.require(input.phaseId);
    if (rereadPhase.status === "blocked" || rereadPhase.status === "closed") {
      this.recordPhaseStatusSkip(input, rereadPhase.status);
      return false;
    }
    if (rereadPhase.status === "in_progress") {
      const rereadLeaseGuard =
        input.options.statusWriteLeaseGuard?.() ?? leaseGuard;
      if (rereadLeaseGuard !== undefined) {
        input.phases.assertLeaseGuardHeld(rereadLeaseGuard);
      }
    }
    return true;
  }

  private recordPhaseStatusSkip(
    input: {
      phaseId: string;
      phaseDriven: DrivenHitch[];
      phaseOutcomes: PhaseOutcome[];
    },
    status: "blocked" | "closed",
  ): void {
    input.phaseOutcomes.push({
      phaseId: input.phaseId,
      action: status === "blocked" ? "skip_blocked" : "skip_closed",
      drivenHitches: input.phaseDriven,
    });
  }

  private actionForPhase(
    rollup: CourseRollup,
    index: number,
    phases: PhaseRepository,
    convergence: ConvergenceService,
  ): CoursePhaseAction {
    const phaseSnapshot = rollup.phases[index]!;
    const phase = phases.require(phaseSnapshot.phaseId);
    const hitchIds = phases.hitchIdsFor(phase.phaseId);
    let derivedOpenP0 = 0;
    let derivedOpenP1 = 0;
    for (const hitchId of hitchIds) {
      const counts = openCounts(this.deps.db, hitchId);
      derivedOpenP0 += counts.p0;
      derivedOpenP1 += counts.p1;
    }
    return decideCoursePhaseAction({
      declaredStatus: phase.status,
      isLeaf: isLeafPhase(rollup.phases, index),
      hitches: hitchIds.map((hitchId) => ({
        hitchId,
        convergence: convergence.evaluate(hitchId),
      })),
      derivedOpenP0,
      derivedOpenP1,
    });
  }

  private checkDriveGate(
    hitches: HitchRepository,
    convergence: ConvergenceService,
    hitchId: string,
    createdBy: string,
  ):
    | { kind: "drive" }
    | { kind: "blocked_hitch"; decision: string }
    | { kind: "report_only" } {
    try {
      assertHitchCanStartMutation({
        repository: hitches,
        hitchId,
        mutationKind: "hitch.orchestrate",
        syncCreatedBy: createdBy,
      });
      return { kind: "drive" };
    } catch (e) {
      if (!(e instanceof HitchMutationGateError)) throw e;
      const reevaluated = convergence.evaluate(hitchId);
      if (
        reevaluated.decision === "escalate" ||
        reevaluated.decision === "diverging" ||
        reevaluated.decision === "budget_exhausted" ||
        reevaluated.decision === "needs_classification"
      ) {
        return { kind: "blocked_hitch", decision: reevaluated.decision };
      }
      return { kind: "report_only" };
    }
  }

  private recordNotDriven(
    phases: PhaseRollup[],
    startIndex: number,
    outcomes: PhaseOutcome[],
  ): void {
    for (let i = startIndex; i < phases.length; i++) {
      outcomes.push({
        phaseId: phases[i]!.phaseId,
        action: "not_driven",
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

function isCourseLeaseLostError(e: unknown): boolean {
  const cause = findTransientLeaseCause(e);
  return cause instanceof LeaseLostError || cause instanceof LeaseGuardFailedError;
}

function isCourseLeaseBusyError(e: unknown): boolean {
  return findTransientLeaseCause(e) instanceof DomainLockBusyError;
}

function courseLeaseLostError(e: unknown): CourseOrchestrateError {
  const cause = findTransientLeaseCause(e) ?? e;
  return new CourseOrchestrateError(
    "lease_lost",
    cause instanceof Error ? cause.message : "course orchestration lease lost",
    {
      causeName: cause instanceof Error ? cause.name : typeof cause,
    },
  );
}

function courseLeaseBusyError(e: unknown): CourseOrchestrateError {
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

function courseLeaseHeartbeatIntervalMs(): number {
  return Math.max(
    1,
    Math.min(heartbeatIntervalMs(), Math.floor(leaseDurationMs() / 2)),
  );
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

function normalizePlanInput(
  input: PlanCourseOrchestrationInput,
): PlanCourseOrchestrationInput {
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
