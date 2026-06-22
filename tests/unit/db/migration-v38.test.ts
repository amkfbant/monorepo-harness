import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  runMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
} from "../../../src/db/migrations.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Apply every migration with version <= target, stamping schema_migrations. */
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

describe("v38 hitch_findings.deferred_issue_url migration", () => {
  it("LATEST_SCHEMA_VERSION has advanced to v38", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(38);
  });

  it("fresh migration adds the deferred_issue_url column", () => {
    const db = freshDb();
    const r = runMigrations(db);
    expect(r.version).toBe(38);
    expect(r.applied).toContain(38);
    expect(columns(db, "hitch_findings")).toContain("deferred_issue_url");
  });

  it("is additive on a realistic v37 DB (column added, existing rows keep data)", () => {
    const db = freshDb();
    seedThrough(db, 37);
    expect(columns(db, "hitch_findings")).not.toContain("deferred_issue_url");

    runMigrations(db);

    expect(columns(db, "hitch_findings")).toContain("deferred_issue_url");
  });

  it("re-running migrations is a no-op (idempotent)", () => {
    const db = freshDb();
    runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).not.toContain(38);
    expect(
      columns(db, "hitch_findings").filter((c) => c === "deferred_issue_url"),
    ).toHaveLength(1);
  });
});
