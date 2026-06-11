import { hostname } from "node:os";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrations.js";
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
  findActiveDomainLock,
} from "../../src/workspace/db-domain-lock.js";

function fakeRunners(): OrchestratorRunners {
  return {
    coder: async () => ({ runId: "run-1", runStatus: "needs_review" }),
    review: async () => ({ runId: "run-1", decision: "approved" }),
    classify: async () => ({ resolved: true }),
    defer: async () => ({ deferred: 0 }),
    closeAndPr: async () => ({ prUrl: "https://example.invalid/pr/1", draft: true }),
  };
}

function seedDrivableHitch(db: Database.Database, hitchId: string): void {
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
  hitches.upsertFinding({
    hitchId,
    severity: "P1",
    source: "human",
    category: "correctness",
    summary: "needs fix",
    scopeStatus: "in_scope",
  });
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

    expect(result.stopReason).toBe("budget_exhausted");
    expect(calls).toEqual(["h-one"]);
    expect(result.drivenHitches.map((h) => h.hitchId)).toEqual(["h-one"]);
    expect(result.phaseOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phaseId: "phase-two", note: "not_driven" }),
      ]),
    );
    expect(phases.require(p2.phaseId).status).toBe("pending");
    expect(findActiveDomainLock(db, `course:${courseId}`)).toBeNull();
    expect(latestReleaseReason(db, courseId)).toBe("budget_exhausted");
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

    expect(result.stopReason).toBe("budget_exhausted");
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

  it("does not include closed hitches in ready phase follow-ups", async () => {
    const courseId = newCourse(db, "course-ready-closed");
    const phases = new PhaseRepository(db);
    const phase = phases.add({ courseId, phaseId: "phase-ready-closed", title: "Ready", position: 1, createdBy: "test", createdSource: "cli" });
    seedCloseReadyHitch(db, "h-ready-open");
    seedCloseReadyHitch(db, "h-ready-closed");
    phases.linkHitch(phase.phaseId, "h-ready-open");
    phases.linkHitch(phase.phaseId, "h-ready-closed");
    new HitchRepository(db).updateStatus("h-ready-closed", "closed", "done");

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
