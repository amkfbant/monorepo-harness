import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  runMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
} from "../../../src/db/migrations.js";

// (#396 part 2) v41 adds the run-scoped transient close-push retry budget to
// hitch_sessions. Additive ALTERs only; idempotent; convergence never reads them.

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function seedThrough(db: Database.Database, target: number): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of [...MIGRATIONS]
    .filter((m) => m.version <= target)
    .sort((a, b) => a.version - b.version)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    insert.run(m.version, m.name, "2026-01-01T00:00:00Z");
  }
}

function columns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

describe("v41 hitch_sessions close-push retry budget migration", () => {
  it("LATEST_SCHEMA_VERSION is at or beyond v41", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
  });

  it("fresh migration adds close_push_attempts (default 0) and close_push_run_id (NULL)", () => {
    const db = freshDb();
    const r = runMigrations(db);
    expect(r.applied).toContain(41);
    const cols = columns(db, "hitch_sessions");
    expect(cols).toContain("close_push_attempts");
    expect(cols).toContain("close_push_run_id");
  });

  it("a hitch_sessions row defaults to attempts=0 / run_id=NULL", () => {
    const db = freshDb();
    runMigrations(db);
    // minimal insert: rely on column defaults for the two new columns.
    const info = db
      .prepare(`PRAGMA table_info(hitch_sessions)`)
      .all() as { name: string; dflt_value: string | null; notnull: number }[];
    const attempts = info.find((c) => c.name === "close_push_attempts");
    const runId = info.find((c) => c.name === "close_push_run_id");
    expect(attempts?.notnull).toBe(1);
    expect(attempts?.dflt_value).toBe("0");
    expect(runId?.notnull).toBe(0); // nullable
  });

  it("is idempotent: re-running migrations does not re-add the columns", () => {
    const db = freshDb();
    seedThrough(db, 41);
    const again = runMigrations(db);
    expect(again.applied).not.toContain(41);
    expect(
      columns(db, "hitch_sessions").filter((c) => c === "close_push_attempts"),
    ).toHaveLength(1);
  });

  it("upgrades a v40 DB additively (close_push columns appear on top of v40)", () => {
    const db = freshDb();
    seedThrough(db, 40);
    expect(columns(db, "hitch_sessions")).not.toContain("close_push_attempts");
    const r = runMigrations(db);
    expect(r.applied).toContain(41);
    expect(columns(db, "hitch_sessions")).toContain("close_push_attempts");
    expect(columns(db, "hitch_sessions")).toContain("close_push_run_id");
  });
});
