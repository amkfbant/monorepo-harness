import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb, DbError } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { StateConflictError, SourceModeError } from "../../../src/db/errors.js";
import { RunRepository } from "../../../src/db/repositories/runs.js";
import {
  findOperation,
  recordOperation,
} from "../../../src/db/repositories/operations.js";
import {
  bumpRevision,
  readSourceMode,
  assertSourceMode,
} from "../../../src/db/scopes.js";

/**
 * Phase 7-1 — write repository skeleton: the guarded status transition,
 * the operation-id ledger, revision bumping and the source_mode guard.
 */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-run-write-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function insertRun(
  db: Database.Database,
  runId: string,
  status: string,
  sourceMode = "db-first",
): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, updated_at, source_mode, db_revision)
     VALUES (?, 'demo', 'apps/web', 'domain-coding', 'main', ?,
       '2026-05-22T00:00:00Z', ?, 1)`,
  ).run(runId, status, sourceMode);
}

function eventCount(db: Database.Database, runId: string): number {
  return (
    db
      .prepare("SELECT count(*) AS n FROM run_events WHERE run_id = ?")
      .get(runId) as { n: number }
  ).n;
}

function revision(db: Database.Database, runId: string): number {
  return (
    db
      .prepare("SELECT db_revision AS r FROM runs WHERE run_id = ?")
      .get(runId) as { r: number }
  ).r;
}

function exportStatus(db: Database.Database, runId: string): string {
  return (
    db
      .prepare("SELECT export_status AS s FROM runs WHERE run_id = ?")
      .get(runId) as { s: string }
  ).s;
}

describe("RunRepository.updateRunStatus", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("transitions when the current status is expected", () => {
    insertRun(db, "run-a", "needs_review");
    const repo = new RunRepository(db);
    const res = repo.updateRunStatus({
      runId: "run-a",
      expectedStatuses: ["needs_review"],
      nextStatus: "approved",
      eventType: "review_approved",
      actor: "alice",
    });
    expect(res).toEqual({ changed: true, status: "approved" });
    expect(repo.getRun("run-a")?.status).toBe("approved");
    expect(revision(db, "run-a")).toBe(2); // 1 → bumped
    expect(eventCount(db, "run-a")).toBe(1);
    // the write moved the DB ahead of its files
    expect(exportStatus(db, "run-a")).toBe("dirty");
    const ev = db
      .prepare("SELECT type, payload_json FROM run_events WHERE run_id = 'run-a'")
      .get() as { type: string; payload_json: string };
    expect(ev.type).toBe("review_approved");
    expect(JSON.parse(ev.payload_json)).toMatchObject({
      previousStatus: "needs_review",
      newStatus: "approved",
      actor: "alice",
    });
  });

  it("throws StateConflictError when the status does not match", () => {
    insertRun(db, "run-b", "approved");
    const repo = new RunRepository(db);
    expect(() =>
      repo.updateRunStatus({
        runId: "run-b",
        expectedStatuses: ["needs_review"],
        nextStatus: "rejected",
        eventType: "review_rejected",
      }),
    ).toThrow(StateConflictError);
    // the failed transition left no event and no revision bump
    expect(eventCount(db, "run-b")).toBe(0);
    expect(revision(db, "run-b")).toBe(1);
    expect(repo.getRun("run-b")?.status).toBe("approved");
  });

  it("throws DbError for a missing run", () => {
    const repo = new RunRepository(db);
    expect(() =>
      repo.updateRunStatus({
        runId: "nope",
        expectedStatuses: ["needs_review"],
        nextStatus: "approved",
        eventType: "review_approved",
      }),
    ).toThrow(DbError);
  });

  it("is an idempotent no-op when the operation id replays", () => {
    insertRun(db, "run-c", "needs_review");
    const repo = new RunRepository(db);
    const first = repo.updateRunStatus({
      runId: "run-c",
      expectedStatuses: ["needs_review"],
      nextStatus: "approved",
      eventType: "review_approved",
      operationId: "op-1",
    });
    expect(first.changed).toBe(true);
    const revAfterFirst = revision(db, "run-c");
    // replay: same operation id — even though the run is no longer in
    // needs_review, the ledger short-circuits before the guard.
    const second = repo.updateRunStatus({
      runId: "run-c",
      expectedStatuses: ["needs_review"],
      nextStatus: "approved",
      eventType: "review_approved",
      operationId: "op-1",
    });
    expect(second).toEqual({ changed: false, status: "approved" });
    expect(eventCount(db, "run-c")).toBe(1); // no second event
    expect(revision(db, "run-c")).toBe(revAfterFirst); // no second bump
  });

  it("rejects an operation id reused for a different run", () => {
    insertRun(db, "run-d", "needs_review");
    insertRun(db, "run-e", "needs_review");
    const repo = new RunRepository(db);
    repo.updateRunStatus({
      runId: "run-d",
      expectedStatuses: ["needs_review"],
      nextStatus: "approved",
      eventType: "review_approved",
      operationId: "op-shared",
    });
    // same id, different run — a reused operation id, not a replay.
    expect(() =>
      repo.updateRunStatus({
        runId: "run-e",
        expectedStatuses: ["needs_review"],
        nextStatus: "approved",
        eventType: "review_approved",
        operationId: "op-shared",
      }),
    ).toThrow(DbError);
    // run-e was not silently skipped — it stayed in needs_review
    expect(repo.getRun("run-e")?.status).toBe("needs_review");
  });

  it("appends events at MAX(seq)+1 after a pre-existing event", () => {
    insertRun(db, "run-f", "needs_review");
    // a run created with one lifecycle event already at seq 0
    db.prepare(
      `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
       VALUES ('run-f', 0, 'run_started', '2026-05-22T00:00:00Z', '{}')`,
    ).run();
    const repo = new RunRepository(db);
    repo.updateRunStatus({
      runId: "run-f",
      expectedStatuses: ["needs_review"],
      nextStatus: "approved",
      eventType: "review_approved",
    });
    const seqs = (
      db
        .prepare("SELECT seq FROM run_events WHERE run_id = 'run-f' ORDER BY seq")
        .all() as { seq: number }[]
    ).map((r) => r.seq);
    expect(seqs).toEqual([0, 1]);
  });

  it("rejects a duplicate (run_id, seq) event row", () => {
    insertRun(db, "run-g", "needs_review");
    const insert = db.prepare(
      `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
       VALUES ('run-g', 0, 'run_started', '2026-05-22T00:00:00Z', '{}')`,
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE/);
  });
});

describe("operations ledger", () => {
  it("records and finds an operation; missing id returns undefined", () => {
    const db = freshDb();
    expect(findOperation(db, "op-x")).toBeUndefined();
    recordOperation(db, {
      operationId: "op-x",
      command: "pr_create",
      scopeType: "run",
      scopeId: "run-a",
      result: { url: "https://example/pr/1" },
    });
    const found = findOperation(db, "op-x");
    expect(found?.command).toBe("pr_create");
    expect(found?.result).toEqual({ url: "https://example/pr/1" });
    db.close();
  });
});

describe("bumpRevision", () => {
  it("increments db_revision and returns the new value", () => {
    const db = freshDb();
    insertRun(db, "run-r", "needs_review");
    expect(bumpRevision(db, "run", "run-r")).toBe(2);
    expect(bumpRevision(db, "run", "run-r")).toBe(3);
    db.close();
  });

  it("throws DbError for a missing row", () => {
    const db = freshDb();
    expect(() => bumpRevision(db, "run", "nope")).toThrow(DbError);
    db.close();
  });
});

describe("source_mode guard", () => {
  it("reads source_mode and asserts the expected mode", () => {
    const db = freshDb();
    insertRun(db, "run-db", "needs_review", "db-first");
    insertRun(db, "run-legacy", "needs_review", "legacy-file");
    expect(readSourceMode(db, "run", "run-db")).toBe("db-first");
    expect(readSourceMode(db, "run", "missing")).toBeUndefined();
    expect(() =>
      assertSourceMode(db, "run", "run-db", "db-first"),
    ).not.toThrow();
    expect(() =>
      assertSourceMode(db, "run", "run-legacy", "db-first"),
    ).toThrow(SourceModeError);
    expect(() => assertSourceMode(db, "run", "missing", "db-first")).toThrow(
      DbError,
    );
    db.close();
  });
});
