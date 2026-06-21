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
  const dir = mkdtempSync(join(tmpdir(), "harness-db-v17-"));
  return join(dir, ".harness", "harness.sqlite");
}

function v16OnlyDb(): Database.Database {
  const db = openDb(freshDbPath());
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const m of MIGRATIONS.filter((migration) => migration.version < 17)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(m.version, m.name, "2026-06-07T00:00:00Z");
  }
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name) as { present: number } | undefined;
  return row !== undefined;
}

describe("schema v17 agent workspaces", () => {
  it("adds the workspaces table on top of v16 (additive)", () => {
    const db = v16OnlyDb();
    try {
      expect(currentSchemaVersion(db)).toBe(16);
      const result = runMigrations(db);
      expect(result.applied).toEqual([
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37,
      ]);
      expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(tableExists(db, "workspaces")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("enforces one workspace row per (repo_path, agent)", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);
      const insert = db.prepare(
        `INSERT INTO workspaces (
           workspace_id, agent, repo_path, branch, worktree_path,
           status, created_at, updated_at, last_active_at
         )
         VALUES (?, 'alice', '/repo', 'agent/alice', '/repo.agents/alice',
           'active', 't', 't', 't')`,
      );
      insert.run("ws-1");
      expect(() => insert.run("ws-2")).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("rejects an invalid status (CHECK constraint)", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);
      expect(() =>
        db
          .prepare(
            `INSERT INTO workspaces (
               workspace_id, agent, repo_path, branch, worktree_path,
               status, created_at, updated_at, last_active_at
             )
             VALUES ('ws-x', 'a', '/r', 'agent/a', '/r/a', 'bogus', 't', 't', 't')`,
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
