import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../src/db/migrations.js";
import { ConvergenceService } from "../../src/hitch/convergence.js";
import { evaluateHitchMutationGate } from "../../src/hitch/mutation-gate.js";
import type { RunOrchestrationInput } from "../../src/hitch/orchestrator.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import type {
  HitchOrchestrationResult,
  OrchestrationOutcome,
  OrchestratorRunners,
} from "../../src/hitch/orchestrator-types.js";
import {
  CourseOrchestrateError,
  CourseOrchestrator,
} from "../../src/roadmap/course-orchestrator.js";
import { CourseRepository } from "../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../src/roadmap/phase-repository.js";
import {
  acquireDomainLock,
  type AcquireDomainLockOpts,
  DomainLockBusyError,
  type DomainLockHandle,
  findActiveDomainLock,
  LeaseLostError,
} from "../../src/workspace/db-domain-lock.js";

const domainLockHook = vi.hoisted(
  (): {
    wrapAcquire?: (
      handle: DomainLockHandle,
      opts: AcquireDomainLockOpts,
    ) => DomainLockHandle;
  } => ({}),
);

vi.mock("../../src/workspace/db-domain-lock.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/workspace/db-domain-lock.js")>();
  return {
    ...actual,
    acquireDomainLock: ((
      db: Parameters<typeof actual.acquireDomainLock>[0],
      opts: Parameters<typeof actual.acquireDomainLock>[1],
    ) => {
      const handle = actual.acquireDomainLock(db, opts);
      return domainLockHook.wrapAcquire?.(handle, opts) ?? handle;
    }) satisfies typeof actual.acquireDomainLock,
  };
});

function fakeRunners(): OrchestratorRunners {
  return {
    coder: async () => ({ runId: "run-1", runStatus: "needs_review" }),
    review: async () => ({ runId: "run-1", decision: "approved" }),
    closeCheck: async () => ({ runId: "run-1", checked: 1, passed: 1, failed: 0 }),
    classify: async () => ({ resolved: true }),
    defer: async () => ({ deferred: 0 }),
    closeAndPr: async () => ({ prUrl: "https://example.invalid/pr/1", draft: true }),
  };
}

function seedDrivableHitch(db: Database.Database, hitchId: string): string {
  const hitches = new HitchRepository(db);
  hitches.createSession({
    hitchId,
    title: hitchId,
    projectId: "demo",
    scope: {},
    closeConditions: [],
    createdBy: "test",
    createdSource: "cli",
  });
  const { finding } = hitches.upsertFinding({
    hitchId,
    severity: "P1",
    source: "human",
    category: "correctness",
    summary: "needs fix",
    scopeStatus: "in_scope",
  });
  return finding.findingId;
}

function seedDrivableHitchThatClosesAfterFix(
  db: Database.Database,
  hitchId: string,
): string {
  const hitches = new HitchRepository(db);
  hitches.createSession({
    hitchId,
    title: hitchId,
    projectId: "demo",
    scope: {},
    closeConditions: [{ id: "manual-pass", kind: "manual", required: true }],
    createdBy: "test",
    createdSource: "cli",
  });
  hitches.recordCloseCheck({
    hitchId,
    conditionId: "manual-pass",
    status: "passed",
    checkedBy: "test",
    checkedAt: "2026-06-12T00:01:00.000Z",
  });
  const { finding } = hitches.upsertFinding({
    hitchId,
    severity: "P1",
    source: "human",
    category: "correctness",
    summary: "needs fix",
    scopeStatus: "in_scope",
  });
  return finding.findingId;
}

function seedCloseReadyHitch(db: Database.Database, hitchId: string): void {
  const hitches = new HitchRepository(db);
  hitches.createSession({
    hitchId,
    title: hitchId,
    projectId: "demo",
    scope: {},
    closeConditions: [{ id: "manual-pass", kind: "manual", required: true }],
    createdBy: "test",
    createdSource: "cli",
  });
  hitches.recordCloseCheck({
    hitchId,
    conditionId: "manual-pass",
    status: "passed",
    checkedBy: "test",
  });
}

function seedBudgetExhaustedHitch(
  db: Database.Database,
  hitchId: string,
): void {
  const hitches = new HitchRepository(db);
  hitches.createSession({
    hitchId,
    title: hitchId,
    projectId: "demo",
    scope: {},
    closeConditions: [
      { id: "typecheck", kind: "command", required: true, command: "npm test" },
    ],
    maxIterations: 1,
    createdBy: "test",
    createdSource: "cli",
  });
  hitches.createAttempt({ hitchId, attemptType: "implement" });
  hitches.createAttempt({ hitchId, attemptType: "validate" });
}

function newCourse(db: Database.Database, courseId: string): string {
  return new CourseRepository(db).create({
    courseId,
    title: courseId,
    projectId: "demo",
    repoId: "repo-demo",
    createdBy: "test",
    createdSource: "cli",
  }).courseId;
}

function latestReleaseReason(
  db: Database.Database,
  courseId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT release_reason FROM domain_locks
        WHERE domain_key = ?
        ORDER BY lock_id DESC
        LIMIT 1`,
    )
    .get(`course:${courseId}`) as { release_reason: string | null } | undefined;
  return row?.release_reason ?? null;
}

function makeOrchestrator(
  db: Database.Database,
  outcomes: Record<string, OrchestrationOutcome>,
  calls: string[] = [],
  runInputs: RunOrchestrationInput[] = [],
  onRun?: (
    hitchId: string,
    input: RunOrchestrationInput,
  ) => void | Promise<void>,
): CourseOrchestrator {
  return new CourseOrchestrator({
    db,
    makeHitchOrchestrator: (hitchId) =>
      ({
        run: async (
          runInput: RunOrchestrationInput,
        ): Promise<HitchOrchestrationResult> => {
          calls.push(hitchId);
          runInputs.push(runInput);
          await onRun?.(hitchId, runInput);
          return {
            hitchId,
            outcome: outcomes[hitchId] ?? "close_ready",
            steps: [{ step: 1, decision: "needs_fix", action: "coder", detail: "fake" }],
            finalDecision: "needs_fix",
          };
        },
      }) as never,
    makeRunners: () => fakeRunners(),
  });
}

describe("CourseOrchestrator", () => {
  let db: Database.Database;

  beforeEach(() => {
    domainLockHook.wrapAcquire = undefined;
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("refuses a paused course before acquiring a lease", async () => {
    const courseId = newCourse(db, "course-paused");
    new CourseRepository(db).setStatus(courseId, "paused");

    await expect(
      makeOrchestrator(db, {}).run({
        courseId,
        maxDrivenHitches: 3,
        maxStepsPerHitch: 2,
        createdBy: "test",
      }),
    ).rejects.toMatchObject({
      name: "CourseOrchestrateError",
      code: "course_not_active",
    } satisfies Partial<CourseOrchestrateError>);
  });

  it("refuses when the course lease is already held", async () => {
    const courseId = newCourse(db, "course-lease-busy");
    const lock = acquireDomainLock(db, {
      domainKey: `course:${courseId}`,
      repoId: "repo-demo",
      domain: "course-orchestrate",
      runId: "holder",
      pid: process.pid,
      hostname: hostname(),
    });

    try {
      await expect(
        makeOrchestrator(db, {}).run({
          courseId,
          maxDrivenHitches: 3,
          maxStepsPerHitch: 2,
          createdBy: "test",
        }),
      ).rejects.toMatchObject({
        name: "CourseOrchestrateError",
        code: "lease_busy",
      } satisfies Partial<CourseOrchestrateError>);
    } finally {
      lock.release({ reason: "test-cleanup", releasedBy: "test" });
    }
  });

  it("heartbeats the course lease before each hitch drive", async () => {
    const previousLeaseMs = process.env.HARNESS_LOCK_LEASE_MS;
    process.env.HARNESS_LOCK_LEASE_MS = "10";
    try {
      const courseId = newCourse(db, "course-heartbeat");
      const phases = new PhaseRepository(db);
      const p1 = phases.add({ courseId, phaseId: "phase-heartbeat-one", title: "One", position: 1, createdBy: "test", createdSource: "cli" });
      const p2 = phases.add({ courseId, phaseId: "phase-heartbeat-two", title: "Two", position: 2, createdBy: "test", createdSource: "cli" });
      seedDrivableHitch(db, "h-heartbeat-one");
      seedDrivableHitch(db, "h-heartbeat-two");
      phases.linkHitch(p1.phaseId, "h-heartbeat-one");
      phases.linkHitch(p2.phaseId, "h-heartbeat-two");
      const calls: string[] = [];

      await makeOrchestrator(db, {}, calls, [], async (hitchId) => {
        if (hitchId === "h-heartbeat-one") {
          await delay(25);
          return;
        }
        expect(() =>
          acquireDomainLock(db, {
            domainKey: `course:${courseId}`,
            repoId: "repo-demo",
            domain: "course-orchestrate",
            runId: "contender",
            pid: process.pid,
            hostname: hostname(),
          }),
        ).toThrow(DomainLockBusyError);
      }).run({
        courseId,
        maxDrivenHitches: 2,
        maxStepsPerHitch: 2,
        createdBy: "test",
      });

      expect(calls).toEqual(["h-heartbeat-one", "h-heartbeat-two"]);
    } finally {
      if (previousLeaseMs === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
      else process.env.HARNESS_LOCK_LEASE_MS = previousLeaseMs;
    }
  });

  it("keeps heartbeating the course lease during a long hitch drive", async () => {
    const previousLeaseMs = process.env.HARNESS_LOCK_LEASE_MS;
    const previousHeartbeatMs = process.env.HARNESS_LOCK_HEARTBEAT_MS;
    process.env.HARNESS_LOCK_LEASE_MS = "40";
    process.env.HARNESS_LOCK_HEARTBEAT_MS = "10";
    try {
      const courseId = newCourse(db, "course-long-drive-heartbeat");
      const domainKey = `course:${courseId}`;
      const phases = new PhaseRepository(db);
      const phase = phases.add({ courseId, phaseId: "phase-long-drive-heartbeat", title: "Long", position: 1, createdBy: "test", createdSource: "cli" });
      seedDrivableHitch(db, "h-long-drive-heartbeat");
      phases.linkHitch(phase.phaseId, "h-long-drive-heartbeat");
      const calls: string[] = [];
      let heartbeatCalls = 0;
      let heartbeatCallsAtDriveStart = 0;

      domainLockHook.wrapAcquire = (handle, opts) => {
        if (opts.domainKey !== domainKey) return handle;
        return {
          ...handle,
          heartbeat(now?: Date): void {
            heartbeatCalls += 1;
            handle.heartbeat(now);
          },
        };
      };

      await makeOrchestrator(db, {}, calls, [], async () => {
        heartbeatCallsAtDriveStart = heartbeatCalls;
        await delay(65);
        expect(heartbeatCalls).toBeGreaterThan(heartbeatCallsAtDriveStart);
        expect(() =>
          acquireDomainLock(db, {
            domainKey,
            repoId: "repo-demo",
            domain: "course-orchestrate",
            runId: "contender-during-drive",
            pid: process.pid,
            hostname: hostname(),
          }),
        ).toThrow(DomainLockBusyError);
      }).run({
        courseId,
        maxDrivenHitches: 1,
        maxStepsPerHitch: 50,
        createdBy: "test",
      });

      expect(calls).toEqual(["h-long-drive-heartbeat"]);
      expect(heartbeatCallsAtDriveStart).toBeGreaterThanOrEqual(1);
      expect(heartbeatCalls).toBeGreaterThan(2);
    } finally {
      if (previousLeaseMs === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
      else process.env.HARNESS_LOCK_LEASE_MS = previousLeaseMs;
      if (previousHeartbeatMs === undefined) delete process.env.HARNESS_LOCK_HEARTBEAT_MS;
      else process.env.HARNESS_LOCK_HEARTBEAT_MS = previousHeartbeatMs;
    }
  });

  it("aborts the in-flight drive via AbortSignal on lease loss; a signal-aware drive returns promptly (#132)", async () => {
    const previousLeaseMs = process.env.HARNESS_LOCK_LEASE_MS;
    const previousHeartbeatMs = process.env.HARNESS_LOCK_HEARTBEAT_MS;
    process.env.HARNESS_LOCK_LEASE_MS = "100";
    process.env.HARNESS_LOCK_HEARTBEAT_MS = "10";
    try {
      const courseId = newCourse(db, "course-abort-inflight");
      const domainKey = `course:${courseId}`;
      const phases = new PhaseRepository(db);
      const phase = phases.add({ courseId, phaseId: "phase-abort-inflight", title: "Abort", position: 1, createdBy: "test", createdSource: "cli" });
      seedDrivableHitch(db, "h-abort-inflight");
      phases.linkHitch(phase.phaseId, "h-abort-inflight");

      let heartbeatCalls = 0;
      const leaseLost = new LeaseLostError(domainKey, 1);
      domainLockHook.wrapAcquire = (handle, opts) => {
        if (opts.domainKey !== domainKey) return handle;
        return {
          ...handle,
          heartbeat(now?: Date): void {
            heartbeatCalls += 1;
            if (heartbeatCalls === 2) throw leaseLost;
            handle.heartbeat(now);
          },
        };
      };

      let makeRunnersSignal: AbortSignal | undefined;
      let driveSignalAbortedReason: unknown;
      let driveReturnedPromptly = false;

      const orchestrator = new CourseOrchestrator({
        db,
        makeHitchOrchestrator: () =>
          ({
            run: async (runInput: RunOrchestrationInput): Promise<HitchOrchestrationResult> => {
              // A signal-aware drive: wait for the lease-loss abort instead of
              // running to completion, then propagate the abort cause (as the
              // real hitch orchestrator does).
              const startedAt = Date.now();
              await new Promise<void>((resolve) => {
                if (runInput.signal?.aborted === true) return resolve();
                runInput.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              driveReturnedPromptly = Date.now() - startedAt < 5000;
              driveSignalAbortedReason = runInput.signal?.reason;
              throw runInput.signal?.reason ?? new Error("aborted without reason");
            },
          }) as never,
        makeRunners: (_hitchId, signal) => {
          makeRunnersSignal = signal;
          return fakeRunners();
        },
      });

      await expect(
        orchestrator.run({
          courseId,
          maxDrivenHitches: 1,
          maxStepsPerHitch: 50,
          createdBy: "test",
        }),
      ).rejects.toMatchObject({
        name: "CourseOrchestrateError",
        code: "lease_lost",
      } satisfies Partial<CourseOrchestrateError>);

      // The signal reached makeRunners AND the hitch drive, and was aborted with
      // the lease error as its reason on lease loss.
      expect(makeRunnersSignal).toBeInstanceOf(AbortSignal);
      expect(makeRunnersSignal?.aborted).toBe(true);
      expect(driveSignalAbortedReason).toBe(leaseLost);
      expect(driveReturnedPromptly).toBe(true);
      // Lease released; no orphan lock left behind.
      expect(findActiveDomainLock(db, domainKey)).toBeNull();
    } finally {
      if (previousLeaseMs === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
      else process.env.HARNESS_LOCK_LEASE_MS = previousLeaseMs;
      if (previousHeartbeatMs === undefined) delete process.env.HARNESS_LOCK_HEARTBEAT_MS;
      else process.env.HARNESS_LOCK_HEARTBEAT_MS = previousHeartbeatMs;
    }
  });

  it("aborts fail-closed when a drive-time course lease heartbeat reports LeaseLostError", async () => {
    const previousLeaseMs = process.env.HARNESS_LOCK_LEASE_MS;
    const previousHeartbeatMs = process.env.HARNESS_LOCK_HEARTBEAT_MS;
    process.env.HARNESS_LOCK_LEASE_MS = "100";
    process.env.HARNESS_LOCK_HEARTBEAT_MS = "10";
    try {
      const courseId = newCourse(db, "course-drive-time-lease-lost");
      const domainKey = `course:${courseId}`;
      const phases = new PhaseRepository(db);
      const phase = phases.add({ courseId, phaseId: "phase-drive-time-lease-lost", title: "Lost", position: 1, createdBy: "test", createdSource: "cli" });
      const nextPhase = phases.add({ courseId, phaseId: "phase-drive-time-after-lost", title: "After lost", position: 2, createdBy: "test", createdSource: "cli" });
      seedDrivableHitch(db, "h-drive-time-lease-lost");
      seedDrivableHitch(db, "h-drive-time-after-lost");
      phases.linkHitch(phase.phaseId, "h-drive-time-lease-lost");
      phases.linkHitch(nextPhase.phaseId, "h-drive-time-after-lost");
      const calls: string[] = [];
      let heartbeatCalls = 0;
      let firstDriveCompleted = false;
      let afterLeaseLostDriveCount = 0;

      domainLockHook.wrapAcquire = (handle, opts) => {
        if (opts.domainKey !== domainKey) return handle;
        return {
          ...handle,
          heartbeat(now?: Date): void {
            heartbeatCalls += 1;
            if (heartbeatCalls === 2) {
              throw new LeaseLostError(opts.domainKey, handle.lockId);
            }
            handle.heartbeat(now);
          },
        };
      };

      await expect(
        makeOrchestrator(db, {}, calls, [], async (hitchId) => {
          if (hitchId === "h-drive-time-lease-lost") {
            await delay(80);
            firstDriveCompleted = true;
            return;
          }
          afterLeaseLostDriveCount += 1;
        }).run({
          courseId,
          maxDrivenHitches: 2,
          maxStepsPerHitch: 50,
          createdBy: "test",
        }),
      ).rejects.toMatchObject({
        name: "CourseOrchestrateError",
        code: "lease_lost",
      } satisfies Partial<CourseOrchestrateError>);

      expect(calls).toEqual(["h-drive-time-lease-lost"]);
      expect(firstDriveCompleted).toBe(true);
      expect(afterLeaseLostDriveCount).toBe(0);
      expect(heartbeatCalls).toBe(2);
      expect(findActiveDomainLock(db, domainKey)).toBeNull();
      expect(latestReleaseReason(db, courseId)).toBe("aborted");
      await delay(90);
      expect(calls).toEqual(["h-drive-time-lease-lost"]);
      expect(afterLeaseLostDriveCount).toBe(0);
      expect(heartbeatCalls).toBe(2);
    } finally {
      if (previousLeaseMs === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
      else process.env.HARNESS_LOCK_LEASE_MS = previousLeaseMs;
      if (previousHeartbeatMs === undefined) delete process.env.HARNESS_LOCK_HEARTBEAT_MS;
      else process.env.HARNESS_LOCK_HEARTBEAT_MS = previousHeartbeatMs;
    }
  });

  it("aborts fail-closed when the course lease heartbeat reports LeaseLostError", async () => {
    const courseId = newCourse(db, "course-lease-lost");
    const domainKey = `course:${courseId}`;
    const phases = new PhaseRepository(db);
    const p1 = phases.add({ courseId, phaseId: "phase-lease-lost-one", title: "One", position: 1, createdBy: "test", createdSource: "cli" });
    const p2 = phases.add({ courseId, phaseId: "phase-lease-lost-two", title: "Two", position: 2, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-lease-lost-one");
    seedDrivableHitch(db, "h-lease-lost-two");
    phases.linkHitch(p1.phaseId, "h-lease-lost-one");
    phases.linkHitch(p2.phaseId, "h-lease-lost-two");
    const calls: string[] = [];
    let heartbeatCalls = 0;
    let releaseCalls = 0;
    let releaseReason: string | undefined;

    domainLockHook.wrapAcquire = (handle, opts) => {
      if (opts.domainKey !== domainKey) return handle;
      return {
        ...handle,
        heartbeat(now?: Date): void {
          heartbeatCalls += 1;
          if (heartbeatCalls === 2) {
            throw new LeaseLostError(opts.domainKey, handle.lockId);
          }
          handle.heartbeat(now);
        },
        release(rel?: { reason?: string; releasedBy?: string }, now?: Date): void {
          releaseCalls += 1;
          releaseReason = rel?.reason;
          handle.release(rel, now);
        },
      };
    };

    await expect(
      makeOrchestrator(db, {}, calls).run({
        courseId,
        maxDrivenHitches: 3,
        maxStepsPerHitch: 2,
        createdBy: "test",
      }),
    ).rejects.toMatchObject({
      name: "CourseOrchestrateError",
      code: "lease_lost",
    } satisfies Partial<CourseOrchestrateError>);

    expect(calls).toEqual(["h-lease-lost-one"]);
    expect(heartbeatCalls).toBe(2);
    expect(releaseCalls).toBe(1);
    expect(releaseReason).toBe("aborted");
    expect(findActiveDomainLock(db, domainKey)).toBeNull();
    expect(latestReleaseReason(db, courseId)).toBe("aborted");
  });

  it("fences phase status writes with the held course lease", async () => {
    const previousLeaseMs = process.env.HARNESS_LOCK_LEASE_MS;
    process.env.HARNESS_LOCK_LEASE_MS = "10";
    try {
      const courseId = newCourse(db, "course-status-write-fence");
      const domainKey = `course:${courseId}`;
      const phases = new PhaseRepository(db);
      const phase = phases.add({ courseId, phaseId: "phase-status-write-fence", title: "Fence", position: 1, createdBy: "test", createdSource: "cli" });
      seedDrivableHitch(db, "h-status-write-fence");
      phases.linkHitch(phase.phaseId, "h-status-write-fence");
      const calls: string[] = [];
      let stole = false;

      domainLockHook.wrapAcquire = (handle, opts) => {
        if (opts.domainKey !== domainKey) return handle;
        return {
          ...handle,
          assertHeld(now?: Date): void {
            if (!stole) {
              handle.assertHeld(now);
              stole = true;
              acquireDomainLock(db, {
                domainKey,
                repoId: "repo-demo",
                domain: "course-orchestrate",
                runId: "course-orch-contender",
                pid: process.pid,
                hostname: hostname(),
                // HARNESS_LOCK_LEASE_MS is 10ms here so the original course
                // lease expires fast enough to be stolen. Acquire the contender
                // far in the future so its own (10ms) lease is still active when
                // the final assertion runs — otherwise a slow CI runner can let
                // the contender lock expire before then (flaky `undefined`).
                now: new Date(Date.now() + 600_000),
              });
              return;
            }
            handle.assertHeld(now);
          },
        };
      };

      await expect(
        makeOrchestrator(db, {}, calls).run({
          courseId,
          maxDrivenHitches: 1,
          maxStepsPerHitch: 2,
          createdBy: "test",
        }),
      ).rejects.toMatchObject({
        name: "CourseOrchestrateError",
        code: "lease_lost",
      } satisfies Partial<CourseOrchestrateError>);

      expect(calls).toEqual([]);
      expect(phases.require(phase.phaseId).status).toBe("pending");
      expect(findActiveDomainLock(db, domainKey)?.holderRunId).toBe(
        "course-orch-contender",
      );
    } finally {
      if (previousLeaseMs === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
      else process.env.HARNESS_LOCK_LEASE_MS = previousLeaseMs;
    }
  });

  it("rechecks the hitch mutation gate immediately before driving", async () => {
    const courseId = newCourse(db, "course-gate-drift");
    const domainKey = `course:${courseId}`;
    const phases = new PhaseRepository(db);
    const phase = phases.add({ courseId, phaseId: "phase-gate-drift", title: "Drift", position: 1, createdBy: "test", createdSource: "cli" });
    const findingId = seedDrivableHitch(db, "h-gate-drift");
    phases.linkHitch(phase.phaseId, "h-gate-drift");
    domainLockHook.wrapAcquire = (handle, opts) => {
      if (opts.domainKey !== domainKey) return handle;
      return {
        ...handle,
        heartbeat(now?: Date): void {
          handle.heartbeat(now);
          new HitchRepository(db).classifyFinding({
            findingId,
            scopeStatus: "unknown",
            reason: "test drift",
          });
        },
      };
    };
    const calls: string[] = [];

    const result = await makeOrchestrator(db, {}, calls).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(calls).toEqual([]);
    expect(result.phaseOutcomes).toContainEqual(
      expect.objectContaining({
        phaseId: "phase-gate-drift",
        action: "blocked_hitch",
        blockedHitch: {
          hitchId: "h-gate-drift",
          decision: "needs_classification",
        },
      }),
    );
    expect(result.drivenHitches).toEqual([]);
    expect(phases.require(phase.phaseId).status).toBe("pending");
  });

  it("keeps a phase pending when every dispatch-drivable hitch drifts to report-only at the per-hitch gate", async () => {
    const courseId = newCourse(db, "course-report-only-drift");
    const domainKey = `course:${courseId}`;
    const phases = new PhaseRepository(db);
    const phase = phases.add({ courseId, phaseId: "phase-report-only-drift", title: "Report drift", position: 1, createdBy: "test", createdSource: "cli" });
    const findingIds = [
      seedDrivableHitchThatClosesAfterFix(db, "h-report-drift-one"),
      seedDrivableHitchThatClosesAfterFix(db, "h-report-drift-two"),
    ];
    phases.linkHitch(phase.phaseId, "h-report-drift-one");
    phases.linkHitch(phase.phaseId, "h-report-drift-two");
    let heartbeatCount = 0;
    domainLockHook.wrapAcquire = (handle, opts) => {
      if (opts.domainKey !== domainKey) return handle;
      return {
        ...handle,
        heartbeat(now?: Date): void {
          handle.heartbeat(now);
          const findingId = findingIds[heartbeatCount];
          heartbeatCount += 1;
          if (findingId !== undefined) {
            new HitchRepository(db).markFindingFixed({
              findingId,
              fixedAt: `2026-06-12T00:00:0${heartbeatCount}.000Z`,
            });
          }
        },
      };
    };
    const calls: string[] = [];

    const result = await makeOrchestrator(db, {}, calls).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(calls).toEqual([]);
    expect(result.drivenHitches).toEqual([]);
    expect(result.phaseOutcomes).toContainEqual(
      expect.objectContaining({
        phaseId: "phase-report-only-drift",
        action: "report_only",
        note: "report_only",
        drivenHitches: [],
      }),
    );
    expect(phases.require(phase.phaseId).status).toBe("pending");
  });

  it("isolates an escalated top-level subtree and continues the next subtree", async () => {
    const courseId = newCourse(db, "course-subtrees");
    const phases = new PhaseRepository(db);
    const rootA = phases.add({ courseId, phaseId: "phase-a", title: "A", position: 1, createdBy: "test", createdSource: "cli" });
    const childA = phases.add({ courseId, parentPhaseId: rootA.phaseId, phaseId: "phase-a-child", title: "A child", position: 1, createdBy: "test", createdSource: "cli" });
    const rootB = phases.add({ courseId, phaseId: "phase-b", title: "B", position: 2, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-a");
    seedDrivableHitch(db, "h-a-child");
    seedDrivableHitch(db, "h-b");
    phases.linkHitch(rootA.phaseId, "h-a");
    phases.linkHitch(childA.phaseId, "h-a-child");
    phases.linkHitch(rootB.phaseId, "h-b");
    const calls: string[] = [];

    const result = await makeOrchestrator(
      db,
      { "h-a": "escalated", "h-b": "close_ready" },
      calls,
    ).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(result.stopReason).toBe("completed");
    expect(calls).toEqual(["h-a", "h-b"]);
    expect(result.phaseOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phaseId: "phase-a",
          action: "blocked_hitch",
          blockedHitch: expect.objectContaining({ hitchId: "h-a" }),
        }),
        expect.objectContaining({
          phaseId: "phase-a-child",
          note: "blocked_subtree",
        }),
        expect.objectContaining({
          phaseId: "phase-b",
          action: "drive",
          drivenHitches: [expect.objectContaining({ hitchId: "h-b" })],
        }),
      ]),
    );
    expect(findActiveDomainLock(db, `course:${courseId}`)).toBeNull();
    expect(latestReleaseReason(db, courseId)).toBe("normal");
  });

  it("stops at maxDrivenHitches and records the remaining phases as not driven", async () => {
    const courseId = newCourse(db, "course-budget");
    const phases = new PhaseRepository(db);
    const p1 = phases.add({ courseId, phaseId: "phase-one", title: "One", position: 1, createdBy: "test", createdSource: "cli" });
    const p2 = phases.add({ courseId, phaseId: "phase-two", title: "Two", position: 2, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-one");
    seedDrivableHitch(db, "h-two");
    phases.linkHitch(p1.phaseId, "h-one");
    phases.linkHitch(p2.phaseId, "h-two");
    const calls: string[] = [];

    const result = await makeOrchestrator(db, {}, calls).run({
      courseId,
      maxDrivenHitches: 1,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(result.stopReason).toBe("budget_reached");
    expect(calls).toEqual(["h-one"]);
    expect(result.drivenHitches.map((h) => h.hitchId)).toEqual(["h-one"]);
    expect(result.phaseOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phaseId: "phase-two", note: "not_driven" }),
      ]),
    );
    expect(phases.require(p2.phaseId).status).toBe("pending");
    expect(findActiveDomainLock(db, `course:${courseId}`)).toBeNull();
    expect(latestReleaseReason(db, courseId)).toBe("budget_reached");
  });

  it("labels a phase as partially driven when budget is reached mid-phase", async () => {
    const courseId = newCourse(db, "course-budget-mid-phase");
    const phases = new PhaseRepository(db);
    const phase = phases.add({ courseId, phaseId: "phase-mid-budget", title: "One", position: 1, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-mid-one");
    seedDrivableHitch(db, "h-mid-two");
    phases.linkHitch(phase.phaseId, "h-mid-one");
    phases.linkHitch(phase.phaseId, "h-mid-two");
    const calls: string[] = [];

    const result = await makeOrchestrator(db, {}, calls).run({
      courseId,
      maxDrivenHitches: 1,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(result.stopReason).toBe("budget_reached");
    expect(calls).toEqual(["h-mid-one"]);
    expect(result.phaseOutcomes).toEqual([
      expect.objectContaining({
        phaseId: phase.phaseId,
        action: "partially_driven",
        note: "partially_driven_budget_reached",
        drivenHitches: [expect.objectContaining({ hitchId: "h-mid-one" })],
      }),
    ]);
  });

  it("keeps hitch budget_exhausted separate from course budget_reached", async () => {
    const courseBudgetId = newCourse(db, "course-budget-boundary");
    const phases = new PhaseRepository(db);
    const budgetPhaseOne = phases.add({ courseId: courseBudgetId, phaseId: "phase-budget-boundary-one", title: "One", position: 1, createdBy: "test", createdSource: "cli" });
    const budgetPhaseTwo = phases.add({ courseId: courseBudgetId, phaseId: "phase-budget-boundary-two", title: "Two", position: 2, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-course-budget-one");
    seedDrivableHitch(db, "h-course-budget-two");
    phases.linkHitch(budgetPhaseOne.phaseId, "h-course-budget-one");
    phases.linkHitch(budgetPhaseTwo.phaseId, "h-course-budget-two");

    const courseBudgetResult = await makeOrchestrator(db, {}).run({
      courseId: courseBudgetId,
      maxDrivenHitches: 1,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(courseBudgetResult.stopReason).toBe("budget_reached");

    const hitchBudgetId = "h-hitch-budget-dead-end";
    seedBudgetExhaustedHitch(db, hitchBudgetId);
    const hitches = new HitchRepository(db);
    const convergence = new ConvergenceService(hitches).evaluate(hitchBudgetId);
    expect(convergence.decision).toBe("budget_exhausted");

    const gate = evaluateHitchMutationGate({
      repository: hitches,
      hitchId: hitchBudgetId,
      mutationKind: "hitch.orchestrate",
    });
    expect(gate).toMatchObject({
      allowed: false,
      code: "hitch_budget_exhausted",
      convergence: { decision: "budget_exhausted" },
    });

    const blockedCourseId = newCourse(db, "course-hitch-budget-blocked");
    const blockedPhase = phases.add({ courseId: blockedCourseId, phaseId: "phase-hitch-budget-blocked", title: "Blocked", position: 1, createdBy: "test", createdSource: "cli" });
    phases.linkHitch(blockedPhase.phaseId, hitchBudgetId);
    const calls: string[] = [];

    const blockedResult = await makeOrchestrator(db, {}, calls).run({
      courseId: blockedCourseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(blockedResult.stopReason).toBe("completed");
    expect(calls).toEqual([]);
    expect(blockedResult.phaseOutcomes).toEqual([
      expect.objectContaining({
        phaseId: blockedPhase.phaseId,
        action: "blocked_hitch",
        blockedHitch: {
          hitchId: hitchBudgetId,
          decision: "budget_exhausted",
        },
      }),
    ]);
  });

  it("resumes an in-progress phase idempotently and skips close-ready hitches", async () => {
    const courseId = newCourse(db, "course-resume");
    const phases = new PhaseRepository(db);
    const active = phases.add({ courseId, phaseId: "phase-active", title: "Active", position: 1, createdBy: "test", createdSource: "cli" });
    const ready = phases.add({ courseId, phaseId: "phase-ready", title: "Ready", position: 2, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-active");
    seedCloseReadyHitch(db, "h-ready");
    phases.linkHitch(active.phaseId, "h-active");
    phases.linkHitch(ready.phaseId, "h-ready");
    phases.setStatus(active.phaseId, "in_progress");
    const calls: string[] = [];

    const result = await makeOrchestrator(db, {}, calls).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(calls).toEqual(["h-active"]);
    expect(phases.require(active.phaseId).status).toBe("in_progress");
    expect(result.phaseOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phaseId: "phase-ready", action: "ready_to_close" }),
      ]),
    );
    expect(result.followUps).toContain("hitch orchestrate h-ready");
  });

  it("releases the course lease as aborted when the hitch driver throws", async () => {
    const courseId = newCourse(db, "course-driver-throws");
    const phases = new PhaseRepository(db);
    const phase = phases.add({ courseId, phaseId: "phase-throws", title: "Throws", position: 1, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-throws");
    phases.linkHitch(phase.phaseId, "h-throws");

    await expect(
      makeOrchestrator(db, {}, [], [], () => {
        throw new Error("driver failed");
      }).run({
        courseId,
        maxDrivenHitches: 3,
        maxStepsPerHitch: 2,
        createdBy: "test",
      }),
    ).rejects.toThrow("driver failed");

    expect(findActiveDomainLock(db, `course:${courseId}`)).toBeNull();
    expect(latestReleaseReason(db, courseId)).toBe("aborted");
  });

  it("does not drive remaining hitches after an operator blocks the phase", async () => {
    const courseId = newCourse(db, "course-phase-intervention");
    const phases = new PhaseRepository(db);
    const phase = phases.add({ courseId, phaseId: "phase-multi", title: "Multi", position: 1, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-first");
    seedDrivableHitch(db, "h-second");
    phases.linkHitch(phase.phaseId, "h-first");
    phases.linkHitch(phase.phaseId, "h-second");
    const calls: string[] = [];

    const result = await makeOrchestrator(db, {}, calls, [], (hitchId) => {
      if (hitchId === "h-first") phases.setStatus(phase.phaseId, "blocked");
    }).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(result.stopReason).toBe("completed");
    expect(calls).toEqual(["h-first"]);
    expect(phases.require(phase.phaseId).status).toBe("blocked");
    expect(result.phaseOutcomes).toContainEqual(
      expect.objectContaining({
        phaseId: "phase-multi",
        action: "skip_blocked",
        drivenHitches: [expect.objectContaining({ hitchId: "h-first" })],
      }),
    );
  });

  it("uses live phase status and hitch links when later phases are reached", async () => {
    const courseId = newCourse(db, "course-live-later-phase");
    const phases = new PhaseRepository(db);
    const first = phases.add({ courseId, phaseId: "phase-live-first", title: "First", position: 1, createdBy: "test", createdSource: "cli" });
    const later = phases.add({ courseId, phaseId: "phase-live-later", title: "Later", position: 2, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-live-first");
    seedDrivableHitch(db, "h-live-later");
    phases.linkHitch(first.phaseId, "h-live-first");
    const calls: string[] = [];

    const result = await makeOrchestrator(db, {}, calls, [], (hitchId) => {
      if (hitchId !== "h-live-first") return;
      phases.linkHitch(later.phaseId, "h-live-later");
      phases.setStatus(later.phaseId, "blocked");
    }).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(calls).toEqual(["h-live-first"]);
    expect(result.phaseOutcomes).toContainEqual(
      expect.objectContaining({
        phaseId: "phase-live-later",
        action: "skip_blocked",
      }),
    );
  });

  it("uses live hitch links when a later phase is reached", async () => {
    const courseId = newCourse(db, "course-live-link");
    const phases = new PhaseRepository(db);
    const first = phases.add({ courseId, phaseId: "phase-link-first", title: "First", position: 1, createdBy: "test", createdSource: "cli" });
    const later = phases.add({ courseId, phaseId: "phase-link-later", title: "Later", position: 2, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-link-first");
    seedCloseReadyHitch(db, "h-link-later");
    phases.linkHitch(first.phaseId, "h-link-first");

    const result = await makeOrchestrator(db, {}, [], [], (hitchId) => {
      if (hitchId === "h-link-first") {
        phases.linkHitch(later.phaseId, "h-link-later");
      }
    }).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(result.phaseOutcomes).toContainEqual(
      expect.objectContaining({
        phaseId: "phase-link-later",
        action: "ready_to_close",
      }),
    );
  });

  it("uses live derived open counts before reporting a later phase ready to close", async () => {
    const courseId = newCourse(db, "course-live-counts");
    const phases = new PhaseRepository(db);
    const first = phases.add({ courseId, phaseId: "phase-count-first", title: "First", position: 1, createdBy: "test", createdSource: "cli" });
    const later = phases.add({ courseId, phaseId: "phase-count-later", title: "Later", position: 2, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-count-first");
    const findingId = seedDrivableHitchThatClosesAfterFix(db, "h-count-later");
    phases.linkHitch(first.phaseId, "h-count-first");
    phases.linkHitch(later.phaseId, "h-count-later");

    const result = await makeOrchestrator(db, {}, [], [], (hitchId) => {
      if (hitchId === "h-count-first") {
        const hitches = new HitchRepository(db);
        hitches.markFindingFixed({ findingId });
        hitches.recordCloseCheck({
          hitchId: "h-count-later",
          conditionId: "manual-pass",
          status: "passed",
          checkedBy: "test",
        });
      }
    }).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(result.phaseOutcomes).toContainEqual(
      expect.objectContaining({
        phaseId: "phase-count-later",
        action: "ready_to_close",
      }),
    );
  });

  it("keeps the pass-start phase tree fixed when a phase is added mid-pass", async () => {
    const courseId = newCourse(db, "course-fixed-tree");
    const phases = new PhaseRepository(db);
    const first = phases.add({ courseId, phaseId: "phase-fixed-first", title: "First", position: 1, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-fixed-first");
    phases.linkHitch(first.phaseId, "h-fixed-first");

    const result = await makeOrchestrator(db, {}, [], [], (hitchId) => {
      if (hitchId !== "h-fixed-first") return;
      phases.add({
        courseId,
        phaseId: "phase-added-mid-pass",
        title: "Added mid-pass",
        position: 2,
        createdBy: "test",
        createdSource: "cli",
      });
    }).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(result.phaseOutcomes.map((outcome) => outcome.phaseId)).toEqual([
      "phase-fixed-first",
    ]);
    expect(result.rollupAfter.phases.map((phase) => phase.phaseId)).toContain(
      "phase-added-mid-pass",
    );
  });

  it("normalizes budgets and passes close-ready halt to hitch drivers", async () => {
    const courseId = newCourse(db, "course-normalized-budgets");
    const phases = new PhaseRepository(db);
    for (let i = 1; i <= 4; i++) {
      const phase = phases.add({ courseId, phaseId: `phase-${i}`, title: `Phase ${i}`, position: i, createdBy: "test", createdSource: "cli" });
      const hitchId = `h-${i}`;
      seedDrivableHitch(db, hitchId);
      phases.linkHitch(phase.phaseId, hitchId);
    }
    const calls: string[] = [];
    const runInputs: RunOrchestrationInput[] = [];

    const result = await makeOrchestrator(db, {}, calls, runInputs).run({
      courseId,
      maxDrivenHitches: Number.NaN,
      maxStepsPerHitch: Number.NaN,
      createdBy: "test",
    });

    expect(result.stopReason).toBe("budget_reached");
    expect(calls).toEqual(["h-1", "h-2", "h-3"]);
    expect(runInputs.map((input) => input.maxSteps)).toEqual([20, 20, 20]);
    expect(runInputs.every((input) => input.stopAtCloseReady === true)).toBe(true);

    const cappedCourseId = newCourse(db, "course-capped-budgets");
    for (let i = 1; i <= 11; i++) {
      const phase = phases.add({ courseId: cappedCourseId, phaseId: `capped-phase-${i}`, title: `Capped ${i}`, position: i, createdBy: "test", createdSource: "cli" });
      const hitchId = `capped-h-${i}`;
      seedDrivableHitch(db, hitchId);
      phases.linkHitch(phase.phaseId, hitchId);
    }
    const cappedCalls: string[] = [];
    const cappedRunInputs: RunOrchestrationInput[] = [];

    await makeOrchestrator(db, {}, cappedCalls, cappedRunInputs).run({
      courseId: cappedCourseId,
      maxDrivenHitches: 99,
      maxStepsPerHitch: 99,
      createdBy: "test",
    });

    expect(cappedCalls).toHaveLength(10);
    expect(cappedRunInputs.map((input) => input.maxSteps)).toEqual(
      Array(10).fill(50),
    );
  });

  it("defaults non-positive direct run and plan budgets instead of clamping them to one", async () => {
    const courseId = newCourse(db, "course-non-positive-budgets");
    const phases = new PhaseRepository(db);
    for (let i = 1; i <= 4; i++) {
      const phase = phases.add({ courseId, phaseId: `non-positive-phase-${i}`, title: `Phase ${i}`, position: i, createdBy: "test", createdSource: "cli" });
      const hitchId = `non-positive-h-${i}`;
      seedDrivableHitch(db, hitchId);
      phases.linkHitch(phase.phaseId, hitchId);
    }

    const calls: string[] = [];
    const runInputs: RunOrchestrationInput[] = [];
    const result = await makeOrchestrator(db, {}, calls, runInputs).run({
      courseId,
      maxDrivenHitches: 0,
      maxStepsPerHitch: -5,
      createdBy: "test",
    });

    expect(result.stopReason).toBe("budget_reached");
    expect(calls).toEqual([
      "non-positive-h-1",
      "non-positive-h-2",
      "non-positive-h-3",
    ]);
    expect(runInputs.map((input) => input.maxSteps)).toEqual([20, 20, 20]);

    const planCourseId = newCourse(db, "course-non-positive-plan-budgets");
    for (let i = 1; i <= 4; i++) {
      const phase = phases.add({ courseId: planCourseId, phaseId: `non-positive-plan-phase-${i}`, title: `Plan ${i}`, position: i, createdBy: "test", createdSource: "cli" });
      const hitchId = `non-positive-plan-h-${i}`;
      seedDrivableHitch(db, hitchId);
      phases.linkHitch(phase.phaseId, hitchId);
    }

    const plan = await makeOrchestrator(db, {}).plan({
      courseId: planCourseId,
      maxDrivenHitches: -1,
      maxStepsPerHitch: 0,
    });

    expect(plan.map((outcome) => outcome.phaseId)).toEqual([
      "non-positive-plan-phase-1",
      "non-positive-plan-phase-2",
      "non-positive-plan-phase-3",
      "non-positive-plan-phase-4",
    ]);
    expect(plan.map((outcome) => outcome.action)).toEqual([
      "drive",
      "drive",
      "drive",
      "not_driven",
    ]);
  });

  it("passes course-createdBy lineage through to hitch orchestrator runs", async () => {
    const courseId = newCourse(db, "course-created-by-lineage");
    const phases = new PhaseRepository(db);
    const phase = phases.add({ courseId, phaseId: "phase-created-by-lineage", title: "Lineage", position: 1, createdBy: "test", createdSource: "cli" });
    seedDrivableHitch(db, "h-created-by-lineage");
    phases.linkHitch(phase.phaseId, "h-created-by-lineage");
    const runInputs: RunOrchestrationInput[] = [];
    const createdBy = `course-orchestrate:${courseId}`;

    await makeOrchestrator(db, {}, [], runInputs).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy,
    });

    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]).toMatchObject({
      hitchId: "h-created-by-lineage",
      createdBy,
    });
  });

  it("does not include closed hitches in ready phase follow-ups", async () => {
    const courseId = newCourse(db, "course-ready-closed");
    const phases = new PhaseRepository(db);
    const phase = phases.add({ courseId, phaseId: "phase-ready-closed", title: "Ready", position: 1, createdBy: "test", createdSource: "cli" });
    seedCloseReadyHitch(db, "h-ready-open");
    seedCloseReadyHitch(db, "h-ready-closed");
    phases.linkHitch(phase.phaseId, "h-ready-open");
    phases.linkHitch(phase.phaseId, "h-ready-closed");
    new HitchRepository(db).updateStatus("h-ready-closed", "closed", "done", {
      createdBy: "test",
    });

    const result = await makeOrchestrator(db, {}).run({
      courseId,
      maxDrivenHitches: 3,
      maxStepsPerHitch: 2,
      createdBy: "test",
    });

    expect(result.phaseOutcomes).toContainEqual(
      expect.objectContaining({
        phaseId: "phase-ready-closed",
        action: "ready_to_close",
      }),
    );
    expect(result.followUps).toContain("hitch orchestrate h-ready-open");
    expect(result.followUps).not.toContain("hitch orchestrate h-ready-closed");
  });
});
