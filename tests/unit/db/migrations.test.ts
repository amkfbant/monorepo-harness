import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import {
  MIGRATIONS,
  runMigrations,
  currentSchemaVersion,
  readSchemaVersion,
} from "../../../src/db/migrations.js";
import {
  ALL_TABLE_NAMES,
  CURRENT_TABLE_NAMES,
  DROPPED_TABLE_NAMES,
  SCHEMA_VERSION,
} from "../../../src/db/schema.js";

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-db-"));
  return join(dir, ".harness", "harness.sqlite");
}

function tableNames(dbPath: string): Set<string> {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  } finally {
    db.close();
  }
}

function hasSchemaObject(
  db: Database.Database,
  type: "table" | "index",
  name: string,
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name) !== undefined
  );
}

function applyMigrationsBefore(db: Database.Database, version: number): void {
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const m of MIGRATIONS.filter((migration) => migration.version < version)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(m.version, m.name, new Date().toISOString());
  }
}

describe("runMigrations", () => {
  it("creates the latest schema with every table on a fresh DB", () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const r = runMigrations(db);
    db.close();
    expect(r.version).toBe(SCHEMA_VERSION);
    expect(r.applied).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26,
    ]);
    const tables = tableNames(dbPath);
    expect(tables.has("schema_migrations")).toBe(true);
    expect(ALL_TABLE_NAMES).toContain("db_stats_snapshots");
    expect(DROPPED_TABLE_NAMES).toContain("db_stats_snapshots");
    expect(CURRENT_TABLE_NAMES).not.toContain("db_stats_snapshots");
    for (const t of CURRENT_TABLE_NAMES) {
      expect(tables.has(t)).toBe(true);
    }
    for (const t of DROPPED_TABLE_NAMES) {
      expect(tables.has(t)).toBe(false);
    }
  });

  it("creates run_usage in v26 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 26);
      expect(currentSchemaVersion(db)).toBe(25);
      expect(hasSchemaObject(db, "table", "run_usage")).toBe(false);

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([26]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "run_usage")).toBe(true);

      const columns = db
        .prepare("PRAGMA table_info(run_usage)")
        .all() as { name: string; type: string; notnull: number; pk: number }[];
      expect(columns.find((r) => r.name === "run_id")).toMatchObject({
        type: "TEXT",
        notnull: 0,
        pk: 1,
      });
      expect(columns.find((r) => r.name === "model")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      for (const name of [
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
      ]) {
        expect(columns.find((r) => r.name === name)).toMatchObject({
          type: "INTEGER",
          notnull: 0,
        });
      }
      expect(columns.find((r) => r.name === "usage_source")).toMatchObject({
        type: "TEXT",
        notnull: 1,
      });
      expect(columns.find((r) => r.name === "created_at")).toMatchObject({
        type: "TEXT",
        notnull: 1,
      });

      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, updated_at)
         VALUES ('run-v26', 'demo', 'apps/web', 'domain-coding', 'main',
           'needs_review', '2026-06-13T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO run_usage
           (run_id, input_tokens, cached_input_tokens, output_tokens,
            reasoning_output_tokens, total_tokens, usage_source, created_at)
         VALUES ('run-v26', 10, 2, 5, 1, 15, 'exact',
           '2026-06-13T00:00:00.000Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO run_usage (run_id, usage_source, created_at)
             VALUES ('run-v26-bad', 'exact', '2026-06-13T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow();
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, updated_at)
         VALUES ('run-v26-bad-source', 'demo', 'apps/web', 'domain-coding',
           'main', 'needs_review', '2026-06-13T00:00:00.000Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO run_usage (run_id, usage_source, created_at)
             VALUES ('run-v26-bad-source', 'self_reported',
               '2026-06-13T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/CHECK/i);

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("adds run execution environment provenance columns in v25 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 25);
      expect(currentSchemaVersion(db)).toBe(24);
      const before = db
        .prepare("PRAGMA table_info(runs)")
        .all() as { name: string }[];
      expect(before.map((r) => r.name)).not.toContain("harness_version");
      expect(before.map((r) => r.name)).not.toContain("schema_version_at_run");
      expect(before.map((r) => r.name)).not.toContain("codex_model");
      expect(before.map((r) => r.name)).not.toContain("codex_binary_version");
      expect(before.map((r) => r.name)).not.toContain("prompt_sha256");

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([25, 26]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      const after = db
        .prepare("PRAGMA table_info(runs)")
        .all() as { name: string; type: string; notnull: number }[];
      expect(after.find((r) => r.name === "harness_version")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(after.find((r) => r.name === "schema_version_at_run")).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });
      expect(after.find((r) => r.name === "codex_model")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(after.find((r) => r.name === "codex_binary_version")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(after.find((r) => r.name === "prompt_sha256")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("adds review_proposals.prompt_provenance_json in v24 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 24);
      expect(currentSchemaVersion(db)).toBe(23);
      const before = db
        .prepare("PRAGMA table_info(review_proposals)")
        .all() as { name: string }[];
      expect(before.map((r) => r.name)).not.toContain("prompt_provenance_json");

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([24, 25, 26]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      const after = db
        .prepare("PRAGMA table_info(review_proposals)")
        .all() as { name: string; type: string; notnull: number }[];
      const column = after.find((r) => r.name === "prompt_provenance_json");
      expect(column).toMatchObject({ type: "TEXT", notnull: 0 });

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("creates hitch_lifecycle_events in v23 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 23);
      expect(currentSchemaVersion(db)).toBe(22);
      expect(hasSchemaObject(db, "table", "hitch_lifecycle_events")).toBe(false);

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([23, 24, 25, 26]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "hitch_lifecycle_events")).toBe(true);
      expect(hasSchemaObject(db, "index", "hitch_lifecycle_events_hitch_idx")).toBe(
        true,
      );

      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_lifecycle_events
               (event_id, hitch_id, event, reason, created_at, created_by)
             VALUES ('event-bad', 'missing', 'reopened', 'why',
               '2026-06-12T00:00:00.000Z', 'test')`,
          )
          .run(),
      ).toThrow();

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("drops db_stats_snapshots in v22 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 22);
      expect(currentSchemaVersion(db)).toBe(21);
      expect(hasSchemaObject(db, "table", "db_stats_snapshots")).toBe(true);
      expect(hasSchemaObject(db, "index", "db_stats_snapshots_created_idx")).toBe(
        true,
      );
      db.prepare(
        "INSERT INTO db_stats_snapshots (created_at, stats_json) VALUES (?, ?)",
      ).run("2026-06-12T00:00:00.000Z", "{}");

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([22, 23, 24, 25, 26]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "db_stats_snapshots")).toBe(false);
      expect(hasSchemaObject(db, "index", "db_stats_snapshots_created_idx")).toBe(
        false,
      );

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "db_stats_snapshots")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("creates the runs indexes", () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    runMigrations(db);
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    db.close();
    expect(idx).toContain("runs_project_idx");
    expect(idx).toContain("runs_status_idx");
  });

  it("is idempotent — a second run applies nothing", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    const r2 = runMigrations(db);
    db.close();
    expect(r2.applied).toEqual([]);
    expect(r2.version).toBe(SCHEMA_VERSION);
  });

  it("currentSchemaVersion is 0 before any migration, latest after", () => {
    const db = openDb(freshDbPath());
    expect(currentSchemaVersion(db)).toBe(0);
    runMigrations(db);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("rejects a DB stamped with a newer schema version", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(999, "from-the-future", new Date().toISOString());
    expect(() => runMigrations(db)).toThrow(/newer than this harness/);
    db.close();
  });

  it("readSchemaVersion returns 0 without creating schema_migrations", () => {
    const db = openDb(freshDbPath());
    expect(readSchemaVersion(db)).toBe(0);
    // it must not have created the table
    const present = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    expect(present).toBeUndefined();
    runMigrations(db);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("openDb throws a DbError when the file is not a SQLite database", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-db-"));
    const bogus = join(dir, "harness.sqlite");
    writeFileSync(bogus, "this is not a database\n");
    expect(() => openDb(bogus)).toThrow(/not a database/);
  });
});
