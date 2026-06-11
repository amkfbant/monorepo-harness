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

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-db-v20-"));
  return join(dir, ".harness", "harness.sqlite");
}

/** Build a DB at exactly v19 (pre-rename). */
function v19OnlyDb(): Database.Database {
  const db = openDb(freshDbPath());
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const m of MIGRATIONS.filter((migration) => migration.version < 20)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(m.version, m.name, "2026-06-11T00:00:00Z");
  }
  return db;
}

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function indexNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("schema v20 hitch rename", () => {
  it("renames goal_* tables to hitch_* and removes all goal_* tables", () => {
    const db = v19OnlyDb();
    try {
      expect(currentSchemaVersion(db)).toBe(19);

      // Seed a goal_sessions row before migration
      db.prepare(
        `INSERT INTO goal_sessions (
           goal_id, title, status, scope_json, close_conditions_json,
           policy_json, max_iterations, max_review_cycles, max_reruns,
           max_total_new_findings, created_by, created_source, created_at,
           updated_at
         )
         VALUES ('goal-1', 'Test Goal', 'open', '{}', '[]', '{}', 3, 3, 2, 12,
           'test', 'cli', 't', 't')`,
      ).run();

      // Seed a workspace with goal_id link
      db.prepare(
        `INSERT INTO workspaces (
           workspace_id, agent, repo_path, branch, worktree_path,
           goal_id, status, created_at, updated_at, last_active_at
         )
         VALUES ('ws-1', 'alice', '/r', 'agent/alice', '/r/a',
           'goal-1', 'active', 't', 't', 't')`,
      ).run();

      // Seed a workspace checkpoint with goal_id link
      db.prepare(
        `INSERT INTO workspace_checkpoints (
           checkpoint_id, workspace_id, goal_id, dirty_count, created_at, created_by
         )
         VALUES ('wcp-1', 'ws-1', 'goal-1', 0, 't', 'test')`,
      ).run();

      const result = runMigrations(db);
      expect(result.applied).toContain(20);
      expect(currentSchemaVersion(db)).toBe(20);

      const tables = tableNames(db);

      // No goal_* tables remain
      const goalTables = tables.filter((t) => t.startsWith("goal_"));
      expect(goalTables).toEqual([]);

      // All 6 hitch_* tables exist
      const hitchTables = tables.filter((t) => t.startsWith("hitch_"));
      expect(hitchTables.sort()).toEqual([
        "hitch_attempts",
        "hitch_close_checks",
        "hitch_convergence_decisions",
        "hitch_findings",
        "hitch_review_cycles",
        "hitch_sessions",
      ]);

      // Seeded row is present under new name
      const sessionCount = (
        db
          .prepare("SELECT count(*) AS n FROM hitch_sessions")
          .get() as { n: number }
      ).n;
      expect(sessionCount).toBe(1);

      // hitch_id column is accessible (not goal_id)
      const row = db
        .prepare("SELECT hitch_id FROM hitch_sessions WHERE hitch_id = 'goal-1'")
        .get() as { hitch_id: string } | undefined;
      expect(row?.hitch_id).toBe("goal-1");

      // FK check passes
      const fkViolations = db.pragma("foreign_key_check") as unknown[];
      expect(fkViolations).toEqual([]);

      // No goal_* indexes remain, exactly 10 hitch_* indexes exist
      const allIndexes = indexNames(db);
      const goalIndexes = allIndexes.filter((n) => n.startsWith("goal_"));
      const hitchIndexes = allIndexes.filter((n) => n.startsWith("hitch_"));
      expect(goalIndexes).toEqual([]);
      expect(hitchIndexes.sort()).toEqual([
        "hitch_attempts_goal_idx",
        "hitch_attempts_operation_idx",
        "hitch_attempts_run_idx",
        "hitch_close_checks_goal_idx",
        "hitch_convergence_decisions_goal_idx",
        "hitch_findings_goal_status_idx",
        "hitch_findings_stable_idx",
        "hitch_review_cycles_unique_idx",
        "hitch_sessions_project_idx",
        "hitch_sessions_status_idx",
      ]);
    } finally {
      db.close();
    }
  });

  it("is idempotent: running runMigrations twice does not throw", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);
      expect(() => runMigrations(db)).not.toThrow();
      expect(currentSchemaVersion(db)).toBe(20);
    } finally {
      db.close();
    }
  });

  it("workspaces and workspace_checkpoints have hitch_id after migration", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);

      // Insert workspace using hitch_id column
      db.prepare(
        `INSERT INTO workspaces (
           workspace_id, agent, repo_path, branch, worktree_path,
           hitch_id, status, created_at, updated_at, last_active_at
         )
         VALUES ('ws-2', 'bob', '/r2', 'agent/bob', '/r2/b',
           'hitch-42', 'active', 't', 't', 't')`,
      ).run();

      const ws = db
        .prepare("SELECT hitch_id FROM workspaces WHERE workspace_id = 'ws-2'")
        .get() as { hitch_id: string | null } | undefined;
      expect(ws?.hitch_id).toBe("hitch-42");

      // Insert checkpoint using hitch_id column
      db.prepare(
        `INSERT INTO workspace_checkpoints (
           checkpoint_id, workspace_id, hitch_id, dirty_count, created_at, created_by
         )
         VALUES ('wcp-2', 'ws-2', 'hitch-42', 0, 't', 'test')`,
      ).run();

      const cp = db
        .prepare(
          "SELECT hitch_id FROM workspace_checkpoints WHERE checkpoint_id = 'wcp-2'",
        )
        .get() as { hitch_id: string | null } | undefined;
      expect(cp?.hitch_id).toBe("hitch-42");

      // goal_id column must NOT exist on workspaces
      expect(() =>
        db
          .prepare("SELECT goal_id FROM workspaces WHERE workspace_id = 'ws-2'")
          .get(),
      ).toThrow();

      // goal_id column must NOT exist on workspace_checkpoints
      expect(() =>
        db
          .prepare(
            "SELECT goal_id FROM workspace_checkpoints WHERE checkpoint_id = 'wcp-2'",
          )
          .get(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
