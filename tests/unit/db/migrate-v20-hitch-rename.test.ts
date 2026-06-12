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
      expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);

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
        "hitch_attempts_hitch_idx",
        "hitch_attempts_operation_idx",
        "hitch_attempts_run_idx",
        "hitch_close_checks_hitch_idx",
        "hitch_convergence_decisions_hitch_idx",
        "hitch_findings_hitch_status_idx",
        "hitch_findings_stable_idx",
        "hitch_review_cycles_unique_idx",
        "hitch_sessions_project_idx",
        "hitch_sessions_status_idx",
      ]);

      // Data-preservation: seeded workspace row keeps its hitch_id value
      const wsRow = db
        .prepare("SELECT hitch_id FROM workspaces WHERE workspace_id = 'ws-1'")
        .get() as { hitch_id: string } | undefined;
      expect(wsRow?.hitch_id).toBe("goal-1");

      // Data-preservation: seeded workspace_checkpoint row keeps its hitch_id value
      const wcpRow = db
        .prepare(
          "SELECT hitch_id FROM workspace_checkpoints WHERE checkpoint_id = 'wcp-1'",
        )
        .get() as { hitch_id: string } | undefined;
      expect(wcpRow?.hitch_id).toBe("goal-1");

      // Behavioural: hitch_findings_stable_idx is UNIQUE and partial
      // (duplicate_of IS NULL). Inserting two non-duplicate rows with the same
      // (hitch_id, stable_key) should throw; inserting with duplicate_of set
      // should be allowed.
      db.prepare(
        `INSERT INTO hitch_findings (
           finding_id, hitch_id, stable_key, duplicate_of,
           source, severity, category, scope_status, lifecycle_status,
           summary, first_seen_at, last_seen_at
         ) VALUES
           ('f-1', 'goal-1', 'key-A', NULL,
            'review', 'P1', 'correctness', 'in_scope', 'open',
            'First', 't', 't')`,
      ).run();

      // Second insert with same (hitch_id, stable_key) + duplicate_of IS NULL → must throw
      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_findings (
               finding_id, hitch_id, stable_key, duplicate_of,
               source, severity, category, scope_status, lifecycle_status,
               summary, first_seen_at, last_seen_at
             ) VALUES
               ('f-2', 'goal-1', 'key-A', NULL,
                'review', 'P1', 'correctness', 'in_scope', 'open',
                'Duplicate attempt', 't', 't')`,
          )
          .run(),
      ).toThrow();

      // Insert with duplicate_of set (partial index excludes it) → must not throw
      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_findings (
               finding_id, hitch_id, stable_key, duplicate_of,
               source, severity, category, scope_status, lifecycle_status,
               summary, first_seen_at, last_seen_at
             ) VALUES
               ('f-3', 'goal-1', 'key-A', 'f-1',
                'review', 'P1', 'correctness', 'in_scope', 'duplicate',
                'Known dup', 't', 't')`,
          )
          .run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("is idempotent: running runMigrations twice does not throw", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);
      expect(() => runMigrations(db)).not.toThrow();
      expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
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
