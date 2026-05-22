import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { runFullImport } from "../../src/db/import-files.js";
import { checkConsistency } from "../../src/db/consistency.js";
import { StateConflictError } from "../../src/db/errors.js";
import { RunRepository } from "../../src/db/repositories/runs.js";
import { BacklogRepository } from "../../src/db/repositories/backlog.js";
import { KnowledgeRepository } from "../../src/db/repositories/knowledge.js";
import { exportBacklogItem } from "../../src/db/export-files.js";

/**
 * Phase 7-12 — fixture matrix + crash / concurrency scenarios.
 *
 * Exercises the Phase 7 migration risks as a group: legacy-file and
 * db-first rows coexisting, optimistic-concurrency guards rejecting a
 * stale second writer, operation-id replay, and a failed export staying
 * canonical in the DB while surfacing as drift.
 */

function freshDb(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "harness-p7-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { root, db };
}

function seedRun(
  db: Database.Database,
  runId: string,
  status: string,
  sourceMode: string,
): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch, status,
       updated_at, source_mode, db_revision)
     VALUES (?, 'r', 'apps/x', 'domain-coding', 'main', ?,
       '2026-05-22T00:00:00Z', ?, 1)`,
  ).run(runId, status, sourceMode);
}

function seedBacklog(
  db: Database.Database,
  itemId: string,
  status: string,
  sourceMode: string,
): void {
  db.prepare(
    `INSERT INTO backlog_items (item_id, domain, title, goal, status, priority,
       tags_json, created_at, source_mode, db_revision)
     VALUES (?, 'd', 't', 'g', ?, 'medium', '[]', '2026-05-22T00:00:00Z', ?, 1)`,
  ).run(itemId, status, sourceMode);
}

describe("Phase 7 — migration matrix", () => {
  it("legacy-file and db-first rows coexist; --reset preserves db-first", () => {
    const { root, db } = freshDb();
    mkdirSync(join(root, "runs"), { recursive: true });
    mkdirSync(join(root, "backlog", "open"), { recursive: true });
    seedRun(db, "run-db1", "approved", "db-first");
    seedRun(db, "run-legacy1", "approved", "legacy-file");
    seedBacklog(db, "item-20260522-001", "open", "db-first");
    seedBacklog(db, "item-20260522-002", "open", "legacy-file");

    // a reset full import (as every read-only scoped command performs)
    runFullImport(db, { harnessRoot: root, reset: true });

    // db-first rows survive the reset; legacy-file rows (no backing file)
    // are dropped
    const runs = db
      .prepare("SELECT run_id, source_mode FROM runs ORDER BY run_id")
      .all() as { run_id: string; source_mode: string }[];
    expect(runs).toEqual([
      { run_id: "run-db1", source_mode: "db-first" },
    ]);
    const items = db
      .prepare("SELECT item_id, source_mode FROM backlog_items")
      .all() as { item_id: string; source_mode: string }[];
    expect(items).toEqual([
      { item_id: "item-20260522-001", source_mode: "db-first" },
    ]);
    db.close();
  });
});

describe("Phase 7 — concurrency guards", () => {
  it("a stale second run-status writer is a StateConflictError", () => {
    const { db } = freshDb();
    seedRun(db, "run-x", "needs_review", "db-first");
    const repo = new RunRepository(db);
    // first writer moves needs_review → approved
    repo.updateRunStatus({
      runId: "run-x",
      expectedStatuses: ["needs_review"],
      nextStatus: "approved",
      eventType: "review_processed",
    });
    // a second writer that still expects needs_review loses the race
    expect(() =>
      repo.updateRunStatus({
        runId: "run-x",
        expectedStatuses: ["needs_review"],
        nextStatus: "rejected",
        eventType: "review_processed",
      }),
    ).toThrow(StateConflictError);
    db.close();
  });

  it("an operation-id replay is an idempotent no-op", () => {
    const { db } = freshDb();
    seedRun(db, "run-x", "needs_review", "db-first");
    const repo = new RunRepository(db);
    const first = repo.updateRunStatus({
      runId: "run-x",
      expectedStatuses: ["needs_review"],
      nextStatus: "approved",
      eventType: "review_processed",
      operationId: "op-1",
    });
    expect(first.changed).toBe(true);
    // the same operation id replays as a no-op, not a second transition
    const replay = repo.updateRunStatus({
      runId: "run-x",
      expectedStatuses: ["needs_review"],
      nextStatus: "approved",
      eventType: "review_processed",
      operationId: "op-1",
    });
    expect(replay.changed).toBe(false);
    expect(replay.status).toBe("approved");
    db.close();
  });

  it("a stale backlog-status writer is a StateConflictError", () => {
    const { db } = freshDb();
    seedBacklog(db, "item-20260522-001", "open", "db-first");
    const repo = new BacklogRepository(db);
    repo.updateItemStatus({
      itemId: "item-20260522-001",
      expectedStatuses: ["open", "doing", "deferred"],
      nextStatus: "done",
    });
    // deferring the now-done item — done is not an expected source status
    expect(() =>
      repo.updateItemStatus({
        itemId: "item-20260522-001",
        expectedStatuses: ["open", "doing"],
        nextStatus: "deferred",
      }),
    ).toThrow(StateConflictError);
    db.close();
  });

  it("a conflicting knowledge decision is a StateConflictError", () => {
    const { db } = freshDb();
    const repo = new KnowledgeRepository(db);
    repo.syncCandidate({
      candidateId: "run-x:0",
      runId: "run-x",
      projectId: null,
      repoId: null,
      domain: "apps/x",
      kind: "policy_improvement",
      title: "t",
      body: "c",
      createdAt: "2026-05-22T00:00:00Z",
    });
    repo.setCandidateDecision({
      candidateId: "run-x:0",
      decision: "promoted",
      reviewer: "kn",
      reason: null,
      decidedAt: "2026-05-22T01:00:00Z",
    });
    expect(() =>
      repo.setCandidateDecision({
        candidateId: "run-x:0",
        decision: "rejected",
        reviewer: "kn",
        reason: "x",
        decidedAt: "2026-05-22T02:00:00Z",
      }),
    ).toThrow(StateConflictError);
    db.close();
  });
});

describe("Phase 7 — failed export stays canonical", () => {
  it("a failed export keeps the DB canonical and surfaces as drift", () => {
    const { root, db } = freshDb();
    seedBacklog(db, "item-20260522-001", "open", "db-first");
    // block the export: backlog/open is a file, so the dir cannot be made
    mkdirSync(join(root, "backlog"), { recursive: true });
    writeFileSync(join(root, "backlog", "open"), "blocker\n");

    const result = exportBacklogItem(db, "item-20260522-001", {
      backlogDir: join(root, "backlog"),
    });
    expect(result.status).toBe("failed");
    // the DB row is still the canonical record
    const row = db
      .prepare("SELECT status, export_status FROM backlog_items WHERE item_id = ?")
      .get("item-20260522-001") as { status: string; export_status: string };
    expect(row.status).toBe("open");
    expect(row.export_status).toBe("failed");
    db.close();

    // the failure is recorded in the DB — the blocker is no longer needed
    rmSync(join(root, "backlog", "open"));
    // check-consistency reports the failed export as drift
    const ro = openDb(join(root, ".harness", "harness.sqlite"));
    const report = checkConsistency({ db: ro, harnessRoot: root });
    ro.close();
    expect(
      report.items.some(
        (i) => i.kind === "export:backlog" && i.status === "drift",
      ),
    ).toBe(true);
  });
});
