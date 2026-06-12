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
  const dir = mkdtempSync(join(tmpdir(), "harness-db-v16-"));
  return join(dir, ".harness", "harness.sqlite");
}

function v15OnlyDb(): Database.Database {
  const db = openDb(freshDbPath());
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const m of MIGRATIONS.filter((migration) => migration.version < 16)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(m.version, m.name, "2026-05-26T00:00:00Z");
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

describe("schema v16 goal convergence", () => {
  it("adds the goal convergence tables on top of v15", () => {
    const db = v15OnlyDb();
    try {
      expect(currentSchemaVersion(db)).toBe(15);
      const result = runMigrations(db);
      expect(result.applied).toEqual([
        16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      ]);
      expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
      for (const table of [
        "hitch_sessions",
        "hitch_attempts",
        "hitch_review_cycles",
        "hitch_findings",
        "hitch_close_checks",
        "hitch_convergence_decisions",
      ]) {
        expect(tableExists(db, table)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("enforces unique active finding stable keys per goal", () => {
    const db = openDb(freshDbPath());
    try {
      runMigrations(db);
      db.prepare(
        `INSERT INTO hitch_sessions (
           hitch_id, title, status, scope_json, close_conditions_json,
           policy_json, max_iterations, max_review_cycles, max_reruns,
           max_total_new_findings, created_by, created_source, created_at,
           updated_at
         )
         VALUES ('goal-a', 'Goal', 'open', '{}', '[]', '{}', 3, 3, 2, 12,
           'test', 'cli', 't', 't')`,
      ).run();
      const insert = db.prepare(
        `INSERT INTO hitch_findings (
           finding_id, hitch_id, stable_key, source, severity, category,
           scope_status, lifecycle_status, summary, first_seen_at,
           last_seen_at
         )
         VALUES (?, 'goal-a', 'stable', 'review', 'P1', 'correctness',
           'in_scope', 'open', 'same', 't', 't')`,
      );
      insert.run("finding-a");
      expect(() => insert.run("finding-b")).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });
});
