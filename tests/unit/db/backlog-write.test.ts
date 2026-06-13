import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb, DbError } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { StateConflictError } from "../../../src/db/errors.js";
import {
  BacklogRepository,
  getItemWithRuns,
} from "../../../src/db/repositories/backlog.js";

/**
 * Phase 7-8 — backlog write repository: id allocation, the guarded status
 * transition, and run linking.
 */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-bl-write-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

const DAY = "20260522";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    domain: "apps/web",
    title: "t",
    goal: "g",
    priority: "medium" as const,
    tags: [] as string[],
    createdAt: "2026-05-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("BacklogRepository", () => {
  it("listItemsWithRuns returns full backlog items with linked runs", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    const item = repo.insertItem(
      baseInput({
        domain: "apps/web",
        title: "full",
        goal: "ship the full item",
        priority: "high",
        tags: ["bug", "db"],
      }),
      DAY,
      0,
    );
    repo.linkRun({ itemId: item.id, runId: "run-20260522-web-a" });
    repo.linkRun({ itemId: item.id, runId: "run-20260522-web-b" });

    const rows = repo.listItemsWithRuns();

    expect(rows).toEqual([
      expect.objectContaining({
        id: item.id,
        domain: "apps/web",
        title: "full",
        goal: "ship the full item",
        status: "doing",
        priority: "high",
        tags: ["bug", "db"],
        createdAt: "2026-05-22T00:00:00.000Z",
        linkedRuns: ["run-20260522-web-a", "run-20260522-web-b"],
        sourceMode: "db-first",
      }),
    ]);
    db.close();
  });

  it("listItemsWithRuns filters by status, project, and repo", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO projects (project_id, repo_id) VALUES ('demo', 'demo-repo')",
    ).run();
    const repo = new BacklogRepository(db);
    const scoped = repo.insertItem(
      baseInput({ title: "scoped", projectId: "demo" }),
      DAY,
      0,
    );
    repo.insertItem(baseInput({ title: "other" }), DAY, 0);

    expect(
      repo
        .listItemsWithRuns({
          status: "open",
          projectId: "demo",
          repoId: "demo-repo",
        })
        .map((i) => i.id),
    ).toEqual([scoped.id]);
    expect(repo.listItemsWithRuns({ status: "done" })).toEqual([]);
    db.close();
  });

  it("insertItem creates a db-first row with an allocated id", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    const item = repo.insertItem(baseInput(), DAY, 0);
    expect(item.id).toBe(`item-${DAY}-001`);
    expect(item.status).toBe("open");
    expect(item.sourceMode).toBe("db-first");
    const row = db
      .prepare(
        "SELECT db_revision, export_status, source_mode FROM backlog_items WHERE item_id = ?",
      )
      .get(item.id) as Record<string, unknown>;
    expect(row.db_revision).toBe(1);
    expect(row.export_status).toBe("dirty");
    expect(row.source_mode).toBe("db-first");
    db.close();
  });

  it("insertItem allocates sequential ids within a day", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    const a = repo.insertItem(baseInput(), DAY, 0);
    const b = repo.insertItem(baseInput(), DAY, 0);
    expect(a.id).toBe(`item-${DAY}-001`);
    expect(b.id).toBe(`item-${DAY}-002`);
    db.close();
  });

  it("insertItem starts above the filesystem floor", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    // a legacy file at item-<day>-005 must not be overwritten
    const item = repo.insertItem(baseInput(), DAY, 5);
    expect(item.id).toBe(`item-${DAY}-006`);
    db.close();
  });

  it("insertItem derives repo_id from the item's project", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO projects (project_id, repo_id) VALUES ('demo', 'demo-repo')",
    ).run();
    const repo = new BacklogRepository(db);
    const item = repo.insertItem(baseInput({ projectId: "demo" }), DAY, 0);
    const row = db
      .prepare("SELECT repo_id, project_id FROM backlog_items WHERE item_id = ?")
      .get(item.id) as { repo_id: string | null; project_id: string | null };
    expect(row.project_id).toBe("demo");
    expect(row.repo_id).toBe("demo-repo");
    db.close();
  });

  it("maxDaySequence returns the highest sequence for a day", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    expect(repo.maxDaySequence(DAY)).toBe(0);
    repo.insertItem(baseInput(), DAY, 0);
    repo.insertItem(baseInput(), DAY, 0);
    expect(repo.maxDaySequence(DAY)).toBe(2);
    expect(repo.maxDaySequence("20260101")).toBe(0);
    db.close();
  });

  it("updateItemStatus moves the item and bumps the revision", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    const item = repo.insertItem(baseInput(), DAY, 0);
    const res = repo.updateItemStatus({
      itemId: item.id,
      expectedStatuses: ["open", "doing", "deferred"],
      nextStatus: "done",
    });
    expect(res).toEqual({ changed: true, status: "done" });
    const row = db
      .prepare(
        "SELECT status, db_revision, export_status FROM backlog_items WHERE item_id = ?",
      )
      .get(item.id) as Record<string, unknown>;
    expect(row.status).toBe("done");
    expect(row.db_revision).toBe(2);
    expect(row.export_status).toBe("dirty");
    db.close();
  });

  it("updateItemStatus is an idempotent no-op into the same status", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    const item = repo.insertItem(baseInput(), DAY, 0);
    repo.updateItemStatus({
      itemId: item.id,
      expectedStatuses: ["open", "doing", "deferred"],
      nextStatus: "done",
    });
    const again = repo.updateItemStatus({
      itemId: item.id,
      expectedStatuses: ["open", "doing", "deferred"],
      nextStatus: "done",
    });
    expect(again).toEqual({ changed: false, status: "done" });
    const rev = (
      db
        .prepare("SELECT db_revision FROM backlog_items WHERE item_id = ?")
        .get(item.id) as { db_revision: number }
    ).db_revision;
    // the no-op must not bump the revision
    expect(rev).toBe(2);
    db.close();
  });

  it("updateItemStatus rejects an invalid transition with StateConflictError", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    const item = repo.insertItem(baseInput(), DAY, 0);
    repo.updateItemStatus({
      itemId: item.id,
      expectedStatuses: ["open", "doing", "deferred"],
      nextStatus: "done",
    });
    // deferring a done item: done is not in the expected set
    expect(() =>
      repo.updateItemStatus({
        itemId: item.id,
        expectedStatuses: ["open", "doing"],
        nextStatus: "deferred",
      }),
    ).toThrow(StateConflictError);
    db.close();
  });

  it("updateItemStatus throws DbError for a missing item", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    expect(() =>
      repo.updateItemStatus({
        itemId: "item-20260522-999",
        expectedStatuses: ["open"],
        nextStatus: "done",
      }),
    ).toThrow(DbError);
    db.close();
  });

  it("linkRun links a run and moves the item to doing", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    const item = repo.insertItem(baseInput(), DAY, 0);
    const res = repo.linkRun({ itemId: item.id, runId: "run-x-001" });
    expect(res.changed).toBe(true);
    const withRuns = getItemWithRuns(db, item.id);
    expect(withRuns?.status).toBe("doing");
    expect(withRuns?.linkedRuns).toEqual(["run-x-001"]);
    db.close();
  });

  it("linkRun is idempotent on a re-linked run", () => {
    const db = freshDb();
    const repo = new BacklogRepository(db);
    const item = repo.insertItem(baseInput(), DAY, 0);
    repo.linkRun({ itemId: item.id, runId: "run-x-001" });
    const again = repo.linkRun({ itemId: item.id, runId: "run-x-001" });
    // link already present and the item is already doing → nothing moved
    expect(again.changed).toBe(false);
    const withRuns = getItemWithRuns(db, item.id);
    expect(withRuns?.linkedRuns).toEqual(["run-x-001"]);
    db.close();
  });

  it("getItem returns null for an unknown item", () => {
    const db = freshDb();
    expect(new BacklogRepository(db).getItem("item-20260522-999")).toBeNull();
    db.close();
  });
});
