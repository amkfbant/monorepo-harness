import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function insertLegacyPhase(
  conn: Database.Database,
  input: {
    courseId: string;
    phaseId: string;
    scope: unknown;
    closeConditions: unknown;
  },
): void {
  conn
    .prepare(
      `INSERT INTO phases (
         phase_id, course_id, parent_phase_id, title, position, status,
         scope_json, close_conditions_json, created_by, created_source,
         created_at, updated_at
       )
       VALUES (?, ?, NULL, 'Legacy SP-3', 0, 'pending', ?, ?, 't', 'cli', ?, ?)`,
    )
    .run(
      input.phaseId,
      input.courseId,
      JSON.stringify(input.scope),
      JSON.stringify(input.closeConditions),
      "2026-06-17T00:00:00.000Z",
      "2026-06-17T00:00:00.000Z",
    );
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
      scope: {
        targetFiles: ["src/**"],
        targetSummary: "SP-3 approval",
      },
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
        "22bba06de89b2a7f74dc15747c8bc4f83e537b5936c7209657c2fb3fed7b2fa6",
    });
    expect(reviewStateVersion(conn, p.phaseId)).toBe(1);
  });

  it("specHash does not collide across scalar scope/close boundaries", () => {
    const c = courses.create({
      title: "Roadmap",
      projectId: "demo",
      createdBy: "t",
      createdSource: "cli",
    });
    const mk = (scope: unknown, close: unknown): string => {
      const phaseId = `phase-${String(scope)}-${String(close)}`;
      insertLegacyPhase(conn, {
        courseId: c.courseId,
        phaseId,
        scope,
        closeConditions: close,
      });
      const approved = phases.recordSpecApproval(phaseId, {
        approvedBy: "operator",
        now: "2026-06-17T00:00:00.000Z",
      });
      return (
        (approved.reviewState as { specApproval: { specHash: string } })
          .specApproval.specHash
      );
    };
    // Concatenating canonical JSON without a separator would hash both of these
    // to "123"; the structured tuple keeps them distinct.
    expect(mk(1, 23)).not.toBe(mk(12, 3));
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

  it("normalizes a real concurrent write-lock (SQLITE_BUSY) to a typed conflict error", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-cas-busy-"));
    const file = join(dir, "harness.sqlite");
    const writer = new Database(file);
    writer.pragma("journal_mode = WAL");
    writer.pragma("foreign_keys = ON");
    writer.pragma("busy_timeout = 50"); // fail fast instead of waiting 5s
    runMigrations(writer);
    const blocker = new Database(file);
    blocker.pragma("busy_timeout = 50");
    try {
      const writerCourses = new CourseRepository(writer);
      const writerPhases = new PhaseRepository(writer);
      const c = writerCourses.create({
        title: "Roadmap",
        projectId: "demo",
        createdBy: "t",
        createdSource: "cli",
      });
      const p = writerPhases.add({
        courseId: c.courseId,
        title: "SP-3",
        createdBy: "t",
        createdSource: "cli",
      });

      // Hold an exclusive write lock on a second connection so the writer's
      // BEGIN IMMEDIATE cannot acquire it and surfaces SQLITE_BUSY rather than
      // a CAS miss. The bounded retry must normalize it to a typed error.
      blocker.exec("BEGIN IMMEDIATE");
      blocker
        .prepare("UPDATE phases SET updated_at = ? WHERE phase_id = ?")
        .run("2026-06-17T00:00:09.000Z", p.phaseId);

      let error: unknown;
      try {
        writerPhases.setNote(p.phaseId, "blocked", "2026-06-17T00:00:00.000Z");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ReviewStateConflictError);
      expect((error as ReviewStateConflictError).phaseId).toBe(p.phaseId);

      blocker.exec("ROLLBACK");
    } finally {
      writer.close();
      blocker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
