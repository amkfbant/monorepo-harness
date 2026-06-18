import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";
import {
  acquireDomainLock,
  LeaseGuardFailedError,
} from "../../../src/workspace/db-domain-lock.js";

function db() {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  return d;
}

describe("Course/Phase repositories (SP-1)", () => {
  let conn: Database.Database;
  let courses: CourseRepository;
  let phases: PhaseRepository;
  beforeEach(() => { conn = db(); courses = new CourseRepository(conn); phases = new PhaseRepository(conn); });

  it("creates a course and a phase tree, listing children ordered by position", () => {
    const c = courses.create({ title: "Roadmap", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const big = phases.add({ courseId: c.courseId, title: "大 A", createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, parentPhaseId: big.phaseId, title: "サブ B", position: 1, createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, parentPhaseId: big.phaseId, title: "サブ A", position: 0, createdBy: "t", createdSource: "cli" });
    const tree = phases.tree(c.courseId);
    expect(tree.map((n) => n.phase.title)).toEqual(["大 A"]);
    expect(tree[0]!.children.map((n) => n.phase.title)).toEqual(["サブ A", "サブ B"]);
  });

  it("auto-assigns omitted positions in creation order for flat lists and trees", () => {
    const c = courses.create({ title: "Roadmap", projectId: "demo", createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, phaseId: "phase-c", title: "First", createdBy: "t", createdSource: "cli", now: "2026-06-12T00:00:00.000Z" });
    phases.add({ courseId: c.courseId, phaseId: "phase-a", title: "Second", createdBy: "t", createdSource: "cli", now: "2026-06-12T00:00:01.000Z" });
    phases.add({ courseId: c.courseId, phaseId: "phase-b", title: "Third", createdBy: "t", createdSource: "cli", now: "2026-06-12T00:00:02.000Z" });

    expect(phases.listForCourse(c.courseId).map((p) => [p.title, p.position])).toEqual([
      ["First", 0],
      ["Second", 1],
      ["Third", 2],
    ]);
    expect(phases.tree(c.courseId).map((n) => n.phase.title)).toEqual(["First", "Second", "Third"]);
  });

  it("setNote stores an operator audit note on the phase (#171b)", () => {
    const c = courses.create({ title: "Roadmap", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    expect(phases.require(p.phaseId).reviewState).toBeNull();
    phases.setNote(p.phaseId, "force-closed: PR #999 merged");
    const updated = phases.require(p.phaseId);
    expect((updated.reviewState as { note?: string }).note).toBe("force-closed: PR #999 merged");
  });

  it("setNote preserves other review_state keys (immutable merge — #171b)", () => {
    const c = courses.create({ title: "Roadmap", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    // seed an unrelated review_state key that a future feature might own
    conn
      .prepare("UPDATE phases SET review_state_json = ? WHERE phase_id = ?")
      .run(JSON.stringify({ reviewRuleResolution: "strict" }), p.phaseId);
    phases.setNote(p.phaseId, "takeover note");
    const rs = phases.require(p.phaseId).reviewState as Record<string, unknown>;
    expect(rs.reviewRuleResolution).toBe("strict");
    expect(rs.note).toBe("takeover note");
  });

  it("keeps explicit positions while auto-assigning omitted positions after the sibling max", () => {
    const c = courses.create({ title: "Roadmap", projectId: "demo", createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, phaseId: "phase-explicit-high", title: "Explicit high", position: 5, createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, phaseId: "phase-auto", title: "Auto", createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, phaseId: "phase-explicit-low", title: "Explicit low", position: 2, createdBy: "t", createdSource: "cli" });

    expect(phases.listForCourse(c.courseId).map((p) => [p.title, p.position])).toEqual([
      ["Explicit low", 2],
      ["Explicit high", 5],
      ["Auto", 6],
    ]);
  });

  it("auto-assigns omitted positions independently for each parent", () => {
    const c = courses.create({ title: "Roadmap", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const parentA = phases.add({ courseId: c.courseId, phaseId: "phase-parent-a", title: "Parent A", createdBy: "t", createdSource: "cli" });
    const parentB = phases.add({ courseId: c.courseId, phaseId: "phase-parent-b", title: "Parent B", createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, parentPhaseId: parentA.phaseId, phaseId: "phase-a-child-1", title: "A child 1", createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, parentPhaseId: parentA.phaseId, phaseId: "phase-a-child-2", title: "A child 2", createdBy: "t", createdSource: "cli" });
    phases.add({ courseId: c.courseId, parentPhaseId: parentB.phaseId, phaseId: "phase-b-child-1", title: "B child 1", createdBy: "t", createdSource: "cli" });

    const tree = phases.tree(c.courseId);
    expect(tree[0]!.children.map((n) => [n.phase.title, n.phase.position])).toEqual([
      ["A child 1", 0],
      ["A child 2", 1],
    ]);
    expect(tree[1]!.children.map((n) => [n.phase.title, n.phase.position])).toEqual([
      ["B child 1", 0],
    ]);
  });

  it("orders legacy same-position rows by created_at, then phase_id for ties", () => {
    const c = courses.create({ courseId: "course-legacy", title: "Roadmap", projectId: "demo", createdBy: "t", createdSource: "cli" });
    conn.prepare(
      `INSERT INTO phases (phase_id, course_id, parent_phase_id, title, position, status, created_by, created_source, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 0, 'pending', 't', 'cli', ?, ?)`,
    ).run("phase-c", c.courseId, "First", "2026-06-12T00:00:00.000Z", "2026-06-12T00:00:00.000Z");
    conn.prepare(
      `INSERT INTO phases (phase_id, course_id, parent_phase_id, title, position, status, created_by, created_source, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 0, 'pending', 't', 'cli', ?, ?)`,
    ).run("phase-b", c.courseId, "Tie B", "2026-06-12T00:00:01.000Z", "2026-06-12T00:00:01.000Z");
    conn.prepare(
      `INSERT INTO phases (phase_id, course_id, parent_phase_id, title, position, status, created_by, created_source, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 0, 'pending', 't', 'cli', ?, ?)`,
    ).run("phase-a", c.courseId, "Tie A", "2026-06-12T00:00:01.000Z", "2026-06-12T00:00:01.000Z");

    expect(phases.listForCourse(c.courseId).map((p) => p.title)).toEqual(["First", "Tie A", "Tie B"]);
    expect(phases.tree(c.courseId).map((n) => n.phase.title)).toEqual(["First", "Tie A", "Tie B"]);
  });

  it("rejects a parent from a different course (fail-closed)", () => {
    const c1 = courses.create({ title: "C1", createdBy: "t", createdSource: "cli" });
    const c2 = courses.create({ title: "C2", createdBy: "t", createdSource: "cli" });
    const p1 = phases.add({ courseId: c1.courseId, title: "P1", createdBy: "t", createdSource: "cli" });
    expect(() => phases.add({ courseId: c2.courseId, parentPhaseId: p1.phaseId, title: "X", createdBy: "t", createdSource: "cli" })).toThrow(/different course|parent/i);
  });

  it("rejects adding a phase to a non-existent course (no parent) with a clean not-found error", () => {
    expect(() => phases.add({ courseId: "course-does-not-exist", title: "x", createdBy: "t", createdSource: "t" })).toThrow(/course .* not found/);
  });

  it("validates phase spec at add and leaves no row on invalid close conditions", () => {
    const c = courses.create({ title: "C", createdBy: "t", createdSource: "cli" });
    expect(() =>
      phases.add({
        courseId: c.courseId,
        title: "Invalid spec",
        scope: { targetFiles: ["src/**"] },
        closeConditions: [
          {
            id: "deploy",
            kind: "operation_status",
            required: true,
            metadata: {},
          },
        ],
        createdBy: "t",
        createdSource: "cli",
      }),
    ).toThrow(/operation_status_missing_operation_id/);
    expect(phases.listForCourse(c.courseId)).toEqual([]);
  });

  it("updates phase spec through validator and shared widening/loosening gates", () => {
    const c = courses.create({ title: "C", createdBy: "t", createdSource: "cli" });
    const p = phases.add({
      courseId: c.courseId,
      title: "Spec",
      scope: { targetFiles: ["src/**"] },
      closeConditions: [
        {
          id: "typecheck",
          kind: "command",
          required: true,
          command: "npm run typecheck",
        },
      ],
      createdBy: "t",
      createdSource: "cli",
    });

    expect(() =>
      phases.updateSpec({
        phaseId: p.phaseId,
        scope: { targetFiles: ["src/**", "tests/**"] },
      }),
    ).toThrow(/scope widen/i);
    expect(() =>
      phases.updateSpec({
        phaseId: p.phaseId,
        closeConditions: [],
      }),
    ).toThrow(/gate loosen/i);
    expect(() =>
      phases.updateSpec({
        phaseId: p.phaseId,
        closeConditions: [
          {
            id: "deploy",
            kind: "operation_status",
            required: true,
            metadata: {},
          },
        ],
        allowGateLoosen: true,
      }),
    ).toThrow(/operation_status_missing_operation_id/);

    const updated = phases.updateSpec({
      phaseId: p.phaseId,
      scope: { targetFiles: ["src/**"], notes: "validated update" },
      closeConditions: [
        {
          id: "typecheck",
          kind: "command",
          required: true,
          command: "npm run typecheck",
        },
        {
          id: "review",
          kind: "review_consensus",
          required: true,
          description: "review consensus approved",
        },
      ],
      now: "2026-06-18T00:00:00.000Z",
    });
    expect(updated.scope).toEqual({
      targetFiles: ["src/**"],
      notes: "validated update",
    });
    expect((updated.closeConditions as Array<{ id: string }>).map((cc) => cc.id)).toEqual([
      "typecheck",
      "review",
    ]);
    expect(updated.updatedAt).toBe("2026-06-18T00:00:00.000Z");
  });

  it("links a hitch to a phase and rejects a second link (schema PK + repo guard)", () => {
    const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    conn.prepare(`INSERT INTO hitch_sessions (hitch_id,project_id,title,status,scope_json,close_conditions_json,policy_json,max_iterations,max_review_cycles,max_reruns,max_total_new_findings,created_by,created_source,created_at,updated_at) VALUES ('h1','demo','H','open','{}','[]','{}',3,3,2,12,'t','cli','t','t')`).run();
    phases.linkHitch(p.phaseId, "h1");
    expect(phases.hitchIdsFor(p.phaseId)).toEqual(["h1"]);
    const p2 = phases.add({ courseId: c.courseId, title: "P2", createdBy: "t", createdSource: "cli" });
    expect(() => phases.linkHitch(p2.phaseId, "h1")).toThrow(/already linked|UNIQUE|PRIMARY/i);
  });

  it("returns whether unlinkHitch removed an existing phase link", () => {
    const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    conn.prepare(`INSERT INTO hitch_sessions (hitch_id,project_id,title,status,scope_json,close_conditions_json,policy_json,max_iterations,max_review_cycles,max_reruns,max_total_new_findings,created_by,created_source,created_at,updated_at) VALUES ('h-unlink','demo','H','open','{}','[]','{}',3,3,2,12,'t','cli','t','t')`).run();
    phases.linkHitch(p.phaseId, "h-unlink");

    expect(phases.unlinkHitch("h-unlink")).toBe(true);
    expect(phases.unlinkHitch("h-unlink")).toBe(false);
    expect(phases.hitchIdsFor(p.phaseId)).toEqual([]);
  });

  it("rejects linking a hitch whose project differs from the course's project (no cross-project leak)", () => {
    const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    conn.prepare(`INSERT INTO hitch_sessions (hitch_id,project_id,title,status,scope_json,close_conditions_json,policy_json,max_iterations,max_review_cycles,max_reruns,max_total_new_findings,created_by,created_source,created_at,updated_at) VALUES ('h2','other','H','open','{}','[]','{}',3,3,2,12,'t','cli','t','t')`).run();
    expect(() => phases.linkHitch(p.phaseId, "h2")).toThrow(/project/i);
  });

  it("transitionStatus performs CAS: succeeds only from an allowed prior status", () => {
    const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });

    // pending -> in_progress allowed
    expect(phases.transitionStatus(p.phaseId, ["pending"], "in_progress")).toBe(true);
    expect(phases.require(p.phaseId).status).toBe("in_progress");

    // a second pending->in_progress is a no-op (current status is in_progress, not in the from-set)
    expect(phases.transitionStatus(p.phaseId, ["pending"], "in_progress")).toBe(false);
    expect(phases.require(p.phaseId).status).toBe("in_progress");

    // operator blocks it; driver's pending->in_progress must NOT override (current=blocked)
    phases.setStatus(p.phaseId, "blocked");
    expect(phases.transitionStatus(p.phaseId, ["pending"], "in_progress")).toBe(false);
    expect(phases.require(p.phaseId).status).toBe("blocked");
  });

  it("transitionStatus with an empty from-set is a no-op (returns false)", () => {
    const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });

    expect(phases.transitionStatus(p.phaseId, [], "in_progress")).toBe(false);
    expect(phases.require(p.phaseId).status).toBe("pending");
  });

  it("transitionStatus returns false for an unknown phase (no throw)", () => {
    expect(phases.transitionStatus("phase-does-not-exist", ["pending"], "in_progress")).toBe(false);
  });

  it("transitionStatus folds a held lease guard into the phase CAS", () => {
    const c = courses.create({ title: "C", projectId: "demo", repoId: "repo-demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    const lease = acquireDomainLock(conn, {
      domainKey: `course:${c.courseId}`,
      repoId: "repo-demo",
      domain: "course-orchestrate",
      runId: "course-run-held",
      pid: process.pid,
      hostname: "test-host",
      now: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(phases.transitionStatus(p.phaseId, ["pending"], "in_progress", {
      now: "2026-06-12T00:00:01.000Z",
      leaseGuard: {
        lockId: lease.lockId,
        holderRunId: "course-run-held",
        nowMs: Date.parse("2026-06-12T00:00:01.000Z"),
      },
    })).toBe(true);
    expect(phases.require(p.phaseId).status).toBe("in_progress");
  });

  it("transitionStatus does not write when the lease guard was stolen after a prior assert", () => {
    const previousLeaseMs = process.env.HARNESS_LOCK_LEASE_MS;
    process.env.HARNESS_LOCK_LEASE_MS = "10";
    try {
      const c = courses.create({ title: "C", projectId: "demo", repoId: "repo-demo", createdBy: "t", createdSource: "cli" });
      const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
      const oldLease = acquireDomainLock(conn, {
        domainKey: `course:${c.courseId}`,
        repoId: "repo-demo",
        domain: "course-orchestrate",
        runId: "course-run-old",
        pid: process.pid,
        hostname: "test-host",
        now: new Date("2026-06-12T00:00:00.000Z"),
      });
      oldLease.assertHeld(new Date("2026-06-12T00:00:00.001Z"));
      acquireDomainLock(conn, {
        domainKey: `course:${c.courseId}`,
        repoId: "repo-demo",
        domain: "course-orchestrate",
        runId: "course-run-new",
        pid: process.pid,
        hostname: "test-host",
        now: new Date("2026-06-12T00:00:01.000Z"),
      });

      expect(() => phases.transitionStatus(p.phaseId, ["pending"], "in_progress", {
        now: "2026-06-12T00:00:01.001Z",
        leaseGuard: {
          lockId: oldLease.lockId,
          holderRunId: "course-run-old",
          nowMs: Date.parse("2026-06-12T00:00:01.001Z"),
        },
      })).toThrow(LeaseGuardFailedError);
      expect(phases.require(p.phaseId).status).toBe("pending");
    } finally {
      if (previousLeaseMs === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
      else process.env.HARNESS_LOCK_LEASE_MS = previousLeaseMs;
    }
  });

  it("transitionStatus returns false for a CAS miss when the lease guard is still held", () => {
    const c = courses.create({ title: "C", projectId: "demo", repoId: "repo-demo", createdBy: "t", createdSource: "cli" });
    const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });
    phases.setStatus(p.phaseId, "in_progress");
    const lease = acquireDomainLock(conn, {
      domainKey: `course:${c.courseId}`,
      repoId: "repo-demo",
      domain: "course-orchestrate",
      runId: "course-run-held-cas-miss",
      pid: process.pid,
      hostname: "test-host",
      now: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(phases.transitionStatus(p.phaseId, ["pending"], "in_progress", {
      now: "2026-06-12T00:00:01.000Z",
      leaseGuard: {
        lockId: lease.lockId,
        holderRunId: "course-run-held-cas-miss",
        nowMs: Date.parse("2026-06-12T00:00:01.000Z"),
      },
    })).toBe(false);
    expect(phases.require(p.phaseId).status).toBe("in_progress");
  });
});
