import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations, currentSchemaVersion } from "../../../src/db/migrations.js";
import {
  MIGRATION_V1_STATEMENTS,
  SCHEMA_VERSION,
  V2_TABLE_NAMES,
} from "../../../src/db/schema.js";

/**
 * Phase 7-1 — schema v2.
 *
 * v2 adds `source_mode` + export bookkeeping to the four runtime tables
 * and creates the export / operations / PR / cleanup tables. The key
 * behaviour is the v1 → v2 upgrade: rows imported by Phase 6 must land as
 * `legacy-file`.
 */

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-db-v2-"));
  return join(dir, ".harness", "harness.sqlite");
}

const EXPORT_COLUMNS = [
  "source_mode",
  "db_revision",
  "last_export_revision",
  "export_status",
  "last_exported_at",
  "last_export_error",
];

const RUNTIME_TABLES = [
  "runs",
  "backlog_items",
  "knowledge_candidates",
  "knowledge_entries",
];

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

/** A DB at schema v1 only — v1 DDL applied, stamped version 1. */
function v1OnlyDb(): Database.Database {
  const db = openDb(freshDbPath());
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const stmt of MIGRATION_V1_STATEMENTS) db.prepare(stmt).run();
  db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'read-model-v1', ?)",
  ).run(new Date().toISOString());
  return db;
}

describe("schema v2", () => {
  it("adds source_mode and export columns to every runtime table", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    for (const table of RUNTIME_TABLES) {
      const cols = columnNames(db, table);
      for (const c of EXPORT_COLUMNS) {
        expect(cols.has(c), `${table}.${c}`).toBe(true);
      }
    }
    db.close();
  });

  it("creates the v2 tables", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    for (const t of V2_TABLE_NAMES) expect(tables.has(t), t).toBe(true);
    db.close();
  });

  it("upgrades a v1 DB and defaults existing rows to legacy-file", () => {
    const db = v1OnlyDb();
    expect(currentSchemaVersion(db)).toBe(1);
    // a run imported under Phase 6 (v1 columns only)
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, updated_at)
       VALUES ('run-legacy', 'demo', 'apps/web', 'domain-coding', 'main',
         'needs_review', '2026-05-22T00:00:00Z')`,
    ).run();

    const r = runMigrations(db);
    expect(r.applied).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
    ]);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const row = db
      .prepare(
        `SELECT source_mode, db_revision, export_status
         FROM runs WHERE run_id = 'run-legacy'`,
      )
      .get() as {
      source_mode: string;
      db_revision: number;
      export_status: string;
    };
    expect(row.source_mode).toBe("legacy-file");
    expect(row.db_revision).toBe(0);
    expect(row.export_status).toBe("synced");
    db.close();
  });

  it("migrations are idempotent on an up-to-date DB", () => {
    const db = openDb(freshDbPath());
    const first = runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(currentSchemaVersion(db)).toBe(first.version);
    db.close();
  });
});
