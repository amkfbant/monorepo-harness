import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import {
  runMigrations,
  currentSchemaVersion,
  readSchemaVersion,
} from "../../../src/db/migrations.js";
import { ALL_TABLE_NAMES, SCHEMA_VERSION } from "../../../src/db/schema.js";

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

describe("runMigrations", () => {
  it("creates the latest schema with every table on a fresh DB", () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const r = runMigrations(db);
    db.close();
    expect(r.version).toBe(SCHEMA_VERSION);
    expect(r.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const tables = tableNames(dbPath);
    expect(tables.has("schema_migrations")).toBe(true);
    for (const t of ALL_TABLE_NAMES) {
      expect(tables.has(t)).toBe(true);
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
