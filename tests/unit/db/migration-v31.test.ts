import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, LATEST_SCHEMA_VERSION, MIGRATIONS } from "../../../src/db/migrations.js";
import { ALL_TABLE_NAMES, CURRENT_TABLE_NAMES } from "../../../src/db/schema.js";

const V31_TABLES = [
  "jury_classification_proposals",
  "jury_classification_refutations",
  "jury_severity_audits",
];

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Apply only the migrations with version <= 30 (i.e. everything before the
 * #230 v31 DDL). Creates `schema_migrations`, runs each migration's
 * statements, and stamps the row — mirroring `runMigrations` without the
 * name-integrity guard so we can simulate a foreign v31 having landed first.
 */
function seedSchemaThroughV30(db: Database.Database): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  ).run();
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  const ordered = [...MIGRATIONS]
    .filter((m) => m.version <= 30)
    .sort((a, b) => a.version - b.version);
  for (const m of ordered) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    insert.run(m.version, m.name, "2026-01-01T00:00:00Z");
  }
}

describe("v31 migration", () => {
  it("LATEST_SCHEMA_VERSION has advanced beyond shipped v31", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThan(31);
  });

  it("fresh migration creates the shipped v31 jury tables and records version 31", () => {
    const db = freshDb();
    runMigrations(db);
    const applied = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    expect(applied.map((r) => r.version)).toContain(31);
    expect(applied.at(-1)?.version).toBe(LATEST_SCHEMA_VERSION);
    for (const t of V31_TABLES) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t);
      expect(row, `table ${t} must exist`).toBeTruthy();
    }
  });

  it("v31 tables have ZERO foreign keys (backbone P1-1)", () => {
    const db = freshDb();
    runMigrations(db);
    for (const t of V31_TABLES) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
      expect(fks, `${t} must have no FK`).toHaveLength(0);
    }
  });

  it("union health: CURRENT_TABLE_NAMES EXACTLY matches sqlite_master (R10/codex#252: catches hand-union drift in either direction)", () => {
    const db = freshDb();
    runMigrations(db);
    // 3 V31 tables must be declared members of ALL_TABLE_NAMES (contains).
    for (const t of V31_TABLES) expect(ALL_TABLE_NAMES).toContain(t);
    // ALL_TABLE_NAMES still CONTAINS dropped tables, so exact-match must compare
    // the live data tables against CURRENT_TABLE_NAMES (dropped excluded).
    const META = new Set(["schema_migrations"]); // sqlite_% は LIKE で除外
    const live = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((n) => !META.has(n))
      .sort();
    const declared = [...new Set(CURRENT_TABLE_NAMES)]
      .filter((n) => !META.has(n))
      .sort();
    expect(declared).toEqual(live); // 完全集合一致: 宣言漏れ も 余分 も検出
  });

  it("idempotent: second runMigrations is a no-op", () => {
    const db = freshDb();
    runMigrations(db);
    const before = db
      .prepare("SELECT count(*) c FROM schema_migrations")
      .get() as { c: number };
    runMigrations(db);
    const after = db
      .prepare("SELECT count(*) c FROM schema_migrations")
      .get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("schema_migrations.name for v31 matches expected (R12: same-number collision guard)", () => {
    const db = freshDb();
    runMigrations(db);
    const row = db
      .prepare("SELECT name FROM schema_migrations WHERE version=31")
      .get() as { name: string };
    expect(row.name).toBe("epic228_deliberation_v31");
  });

  it("R12/codex#252: a pre-existing v31 under a DIFFERENT name is detected, not silently skipped", () => {
    // simulate #229/#231 having taken v31 first under another name:
    // migrate up to v30, then seed schema_migrations(31,'other_v31') WITHOUT the #230 DDL.
    const db = freshDb();
    seedSchemaThroughV30(db); // helper: apply v1..v30 only
    db.prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (31,'other_v31', ?)",
    ).run("2026-01-01T00:00:00Z");
    // runMigrations dedups by version → would no-op v31 and leave #230 tables ABSENT (silent skip).
    // A1 GREEN adds a name-integrity check: applied v31 name must equal expected, else throw (fail-closed).
    expect(() => runMigrations(db)).toThrow(
      /v31 .*name mismatch|conflicting migration/i,
    );
    // and the #230 tables must NOT exist (we did not apply our DDL under a foreign v31)
    const t = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='jury_classification_proposals'",
      )
      .get();
    expect(t).toBeUndefined();
  });
});
