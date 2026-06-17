import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewStateConflictError } from "../../../src/roadmap/errors.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";

function db() {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  return d;
}

function reviewStateVersion(conn: Database.Database, phaseId: string): number {
  return (
    conn
      .prepare("SELECT review_state_version FROM phases WHERE phase_id = ?")
      .get(phaseId) as { review_state_version: number }
  ).review_state_version;
}

describe("PhaseRepository review_state CAS writes (SP-3)", () => {
  let conn: Database.Database;
  let courses: CourseRepository;
  let phases: PhaseRepository;

  beforeEach(() => {
    conn = db();
    courses = new CourseRepository(conn);
    phases = new PhaseRepository(conn);
  });

  it("recordSpecApproval writes a namespaced approval and bumps review_state_version", () => {
    const c = courses.create({
      title: "Roadmap",
      projectId: "demo",
      createdBy: "t",
      createdSource: "cli",
    });
    const p = phases.add({
      courseId: c.courseId,
      title: "SP-3",
      scope: { z: 1, a: { y: 2, x: 1 } },
      closeConditions: [{ kind: "command", command: "npm run typecheck" }],
      createdBy: "t",
      createdSource: "cli",
    });

    const updated = phases.recordSpecApproval(p.phaseId, {
      approvedBy: "operator",
      reason: "accepted after review",
      now: "2026-06-17T00:00:00.000Z",
    });

    const rs = updated.reviewState as Record<string, unknown>;
    expect(rs.specApproval).toEqual({
      approvedBy: "operator",
      approvedAt: "2026-06-17T00:00:00.000Z",
      reason: "accepted after review",
      specHash:
        "1f9efad7778266f4d1b9431526ba61600b630688556fbfe50477185429a2547d",
    });
    expect(reviewStateVersion(conn, p.phaseId)).toBe(1);
  });

  it("updateReviewState retries a stale CAS miss and preserves both writers' keys", () => {
    const c = courses.create({
      title: "Roadmap",
      projectId: "demo",
      createdBy: "t",
      createdSource: "cli",
    });
    const p = phases.add({
      courseId: c.courseId,
      title: "SP-3",
      createdBy: "t",
      createdSource: "cli",
    });
    phases.setNote(p.phaseId, "original");
    let calls = 0;

    const updated = phases.updateReviewState(
      p.phaseId,
      (state) => {
        calls += 1;
        if (calls === 1) {
          conn
            .prepare(
              `UPDATE phases
                  SET review_state_json = ?,
                      review_state_version = review_state_version + 1
                WHERE phase_id = ?`,
            )
            .run(JSON.stringify({ ...state, concurrent: "kept" }), p.phaseId);
        }
        return { ...state, note: "after retry" };
      },
      { now: "2026-06-17T00:00:00.000Z", maxAttempts: 2 },
    );

    const rs = updated.reviewState as Record<string, unknown>;
    expect(calls).toBe(2);
    expect(rs).toMatchObject({ note: "after retry", concurrent: "kept" });
    expect(reviewStateVersion(conn, p.phaseId)).toBe(3);
  });

  it("updateReviewState throws a typed conflict error after the retry budget", () => {
    const c = courses.create({
      title: "Roadmap",
      projectId: "demo",
      createdBy: "t",
      createdSource: "cli",
    });
    const p = phases.add({
      courseId: c.courseId,
      title: "SP-3",
      createdBy: "t",
      createdSource: "cli",
    });

    let error: unknown;
    try {
      phases.updateReviewState(
        p.phaseId,
        (state) => {
          conn
            .prepare(
              `UPDATE phases
                  SET review_state_json = ?,
                      review_state_version = review_state_version + 1
                WHERE phase_id = ?`,
            )
            .run(JSON.stringify({ ...state, concurrent: "kept" }), p.phaseId);
          return { ...state, note: "never wins" };
        },
        { maxAttempts: 2 },
      );
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ReviewStateConflictError);
    expect((error as ReviewStateConflictError).phaseId).toBe(p.phaseId);
    expect((error as ReviewStateConflictError).attempts).toBe(2);
    expect((error as ReviewStateConflictError).latestVersion).toBe(2);
    expect(phases.require(p.phaseId).reviewState).toEqual({ concurrent: "kept" });
  });

  it("setNote uses the CAS path and preserves an existing specApproval key", () => {
    const c = courses.create({
      title: "Roadmap",
      projectId: "demo",
      createdBy: "t",
      createdSource: "cli",
    });
    const p = phases.add({
      courseId: c.courseId,
      title: "SP-3",
      createdBy: "t",
      createdSource: "cli",
    });
    phases.recordSpecApproval(p.phaseId, {
      approvedBy: "operator",
      reason: "accepted",
      now: "2026-06-17T00:00:00.000Z",
    });

    const updated = phases.setNote(
      p.phaseId,
      "force-closed after PR #999 merged",
      "2026-06-17T00:00:01.000Z",
    );

    const rs = updated.reviewState as Record<string, unknown>;
    expect(rs.note).toBe("force-closed after PR #999 merged");
    expect(rs.specApproval).toMatchObject({ approvedBy: "operator" });
    expect(reviewStateVersion(conn, p.phaseId)).toBe(2);
  });
});
