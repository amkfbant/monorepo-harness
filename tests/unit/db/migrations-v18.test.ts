import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import {
  MIGRATIONS,
  currentSchemaVersion,
  runMigrations,
} from "../../../src/db/migrations.js";
import { SCHEMA_VERSION } from "../../../src/db/schema.js";

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-db-v18-"));
  return join(dir, ".harness", "harness.sqlite");
}

function v17OnlyDb(): Database.Database {
  const db = openDb(freshDbPath());
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const m of MIGRATIONS.filter((migration) => migration.version < 18)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(m.version, m.name, "2026-06-07T00:00:00Z");
  }
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS p FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

function seedWorkspace(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO workspaces (
       workspace_id, agent, repo_path, branch, worktree_path,
       status, created_at, updated_at, last_active_at
     )
     VALUES (?, 'alice', '/r', 'agent/alice', '/r/a', 'active', 't', 't', 't')`,
  ).run(id);
}

describe("schema v18 workspace checkpoints", () => {
  it("adds the workspace_checkpoints table on top of v17 (additive)", () => {
    const db = v17OnlyDb();
    try {
      expect(currentSchemaVersion(db)).toBe(17);
      const result = runMigrations(db);
      expect(result.applied).toEqual([
        18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41,
      ]);
      expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(tableExists(db, "workspace_checkpoints")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("cascade-deletes checkpoints when their workspace is removed", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);
      seedWorkspace(db, "ws-1");
      db.prepare(
        `INSERT INTO workspace_checkpoints (
           checkpoint_id, workspace_id, note, dirty_count, created_at, created_by
         )
         VALUES ('wcp-1', 'ws-1', 'note', 0, 't', 'cli')`,
      ).run();
      db.prepare(`DELETE FROM workspaces WHERE workspace_id = 'ws-1'`).run();
      const remaining = db
        .prepare(`SELECT count(*) AS n FROM workspace_checkpoints`)
        .get() as { n: number };
      expect(remaining.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects a negative dirty_count (CHECK constraint)", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);
      seedWorkspace(db, "ws-1");
      expect(() =>
        db
          .prepare(
            `INSERT INTO workspace_checkpoints (
               checkpoint_id, workspace_id, dirty_count, created_at, created_by
             )
             VALUES ('wcp-neg', 'ws-1', -1, 't', 'cli')`,
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it("rejects a checkpoint for a non-existent workspace (FK)", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);
      expect(() =>
        db
          .prepare(
            `INSERT INTO workspace_checkpoints (
               checkpoint_id, workspace_id, dirty_count, created_at, created_by
             )
             VALUES ('wcp-x', 'ws-missing', 0, 't', 'cli')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });
});
