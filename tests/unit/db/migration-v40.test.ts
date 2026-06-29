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

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(table);
  return row !== undefined;
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
    )
    .get(indexName);
  return row !== undefined;
}

describe("v40 external_review_events table migration", () => {
  it("LATEST_SCHEMA_VERSION is at or beyond v40", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(40);
  });

  it("fresh migration creates external_review_events with all expected columns and indexes", () => {
    const db = freshDb();
    const r = runMigrations(db);
    expect(r.version).toBe(LATEST_SCHEMA_VERSION);
    expect(r.applied).toContain(40);
    expect(tableExists(db, "external_review_events")).toBe(true);
    expect(columns(db, "external_review_events")).toEqual([
      "event_id",
      "hitch_id",
      "run_id",
      "repo_id",
      "pr_number",
      "author",
      "reviewer_type",
      "state",
      "github_review_id",
      "submitted_at",
      "summary",
      "redacted",
      "created_at",
    ]);
    expect(indexExists(db, "external_review_events_hitch_idx")).toBe(true);
    expect(indexExists(db, "external_review_events_pr_idx")).toBe(true);
    expect(indexExists(db, "external_review_events_review_idx")).toBe(true);
    const uniqueIndex = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type='index' AND name='external_review_events_review_idx'`,
      )
      .get() as { sql: string };
    expect(uniqueIndex.sql).toContain("UNIQUE INDEX");
    // Dedup key is (github_review_id, state): a state change under the same
    // review id is recorded as a new verdict rather than dropped (#397 review).
    expect(uniqueIndex.sql).toContain("state");
    expect(uniqueIndex.sql).toContain("WHERE github_review_id IS NOT NULL");

    // event_id must be NOT NULL — a non-INTEGER TEXT PRIMARY KEY allows NULLs
    // otherwise, which would let a missing-id ingest insert an unreachable row.
    const eventIdCol = (
      db.prepare(`PRAGMA table_info(external_review_events)`).all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === "event_id");
    expect(eventIdCol?.notnull).toBe(1);
  });

  it("is additive on a realistic v39 DB (table absent before, present after)", () => {
    const db = freshDb();
    seedThrough(db, 39);
    expect(tableExists(db, "external_review_events")).toBe(false);

    runMigrations(db);

    expect(tableExists(db, "external_review_events")).toBe(true);
    expect(columns(db, "external_review_events")).toContain("event_id");
  });

  it("re-running migrations is a no-op (idempotent)", () => {
    const db = freshDb();
    runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).not.toContain(40);
    expect(
      columns(db, "external_review_events").filter((c) => c === "event_id"),
    ).toHaveLength(1);
  });

  it("enforces reviewer_type CHECK constraint", () => {
    const db = freshDb();
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO external_review_events
             (event_id, pr_number, author, reviewer_type, state, created_at)
           VALUES ('ev-bad-reviewer', 395, 'robot', 'unknown_bot',
                   'approved', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it("enforces state CHECK constraint", () => {
    const db = freshDb();
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO external_review_events
             (event_id, pr_number, author, reviewer_type, state, created_at)
           VALUES ('ev-bad-state', 395, 'alice', 'human', 'stale',
                   '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it("accepts a valid row with defaults and cascades nullable hitch rows", () => {
    const db = freshDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO hitch_sessions
         (hitch_id, project_id, title, status, scope_json, close_conditions_json,
          policy_json, max_iterations, max_review_cycles, max_reruns,
          max_total_new_findings, created_by, created_source, created_at, updated_at)
       VALUES ('h-ext','p-1','T','open','{}','[]','{}',3,3,2,12,'t','cli',
               '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO external_review_events
         (event_id, hitch_id, run_id, pr_number, author, reviewer_type, state,
          github_review_id, submitted_at, summary, created_at)
       VALUES ('ev-1', 'h-ext', 'run-1', 395, 'codex[bot]', 'codex_app',
               'changes_requested', 'review-1', '2026-01-01T00:01:00Z',
               'redacted summary', '2026-01-01T00:02:00Z')`,
    ).run();
    const row = db
      .prepare("SELECT * FROM external_review_events WHERE event_id='ev-1'")
      .get() as Record<string, unknown>;
    expect(row["redacted"]).toBe(0);
    expect(row["summary"]).toBe("redacted summary");

    db.prepare("DELETE FROM hitch_sessions WHERE hitch_id = 'h-ext'").run();
    const remaining = db
      .prepare(
        "SELECT COUNT(*) AS n FROM external_review_events WHERE event_id = 'ev-1'",
      )
      .get() as { n: number };
    expect(remaining.n).toBe(0);

    db.prepare(
      `INSERT INTO external_review_events
         (event_id, pr_number, author, reviewer_type, state, created_at)
       VALUES ('ev-standalone', 395, 'alice', 'human', 'commented',
               '2026-01-01T00:03:00Z')`,
    ).run();
    const standalone = db
      .prepare(
        "SELECT hitch_id, redacted FROM external_review_events WHERE event_id = 'ev-standalone'",
      )
      .get() as { hitch_id: string | null; redacted: number };
    expect(standalone).toEqual({ hitch_id: null, redacted: 0 });
  });
});
