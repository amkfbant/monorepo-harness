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

describe("v37 agent_invocation.source_size migration", () => {
  it("LATEST_SCHEMA_VERSION has advanced to v37", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(37);
  });

  it("fresh migration adds the source_size column", () => {
    const db = freshDb();
    const r = runMigrations(db);
    expect(r.version).toBe(37);
    expect(r.applied).toContain(37);
    expect(columns(db, "agent_invocation")).toContain("source_size");
  });

  it("is additive on a realistic v36 DB (column added, existing rows keep data)", () => {
    const db = freshDb();
    seedThrough(db, 36);
    expect(columns(db, "agent_invocation")).not.toContain("source_size");
    // a pre-v37 codex row (source_size will be NULL after upgrade)
    db.prepare(
      `INSERT INTO agent_invocation
         (invocation_id, tool, role, run_id, invocation_seq, usage_source, created_at)
       VALUES ('x', 'codex', 'coder', 'run-1', 0, 'exact', '2026-01-01T00:00:00Z')`,
    ).run();

    runMigrations(db);

    expect(columns(db, "agent_invocation")).toContain("source_size");
    const row = db
      .prepare("SELECT source_size AS sz, tool FROM agent_invocation WHERE invocation_id='x'")
      .get() as { sz: number | null; tool: string };
    expect(row.tool).toBe("codex"); // existing row preserved
    expect(row.sz).toBeNull(); // pre-v37 rows are NULL → treated as complete
  });

  it("re-running migrations is a no-op (idempotent)", () => {
    const db = freshDb();
    runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).not.toContain(37); // already applied
    expect(columns(db, "agent_invocation").filter((c) => c === "source_size")).toHaveLength(1);
  });
});
