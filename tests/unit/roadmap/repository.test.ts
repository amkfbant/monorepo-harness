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

  it("rejects a parent from a different course (fail-closed)", () => {
    const c1 = courses.create({ title: "C1", createdBy: "t", createdSource: "cli" });
    const c2 = courses.create({ title: "C2", createdBy: "t", createdSource: "cli" });
    const p1 = phases.add({ courseId: c1.courseId, title: "P1", createdBy: "t", createdSource: "cli" });
    expect(() => phases.add({ courseId: c2.courseId, parentPhaseId: p1.phaseId, title: "X", createdBy: "t", createdSource: "cli" })).toThrow(/different course|parent/i);
  });

  it("rejects adding a phase to a non-existent course (no parent) with a clean not-found error", () => {
    expect(() => phases.add({ courseId: "course-does-not-exist", title: "x", createdBy: "t", createdSource: "t" })).toThrow(/course .* not found/);
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
