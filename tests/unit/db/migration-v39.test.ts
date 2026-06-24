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

describe("v39 hitch_evidence table migration", () => {
  it("LATEST_SCHEMA_VERSION is at or beyond v39", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(39);
  });

  it("fresh migration creates hitch_evidence with all expected columns", () => {
    const db = freshDb();
    const r = runMigrations(db);
    expect(r.version).toBe(LATEST_SCHEMA_VERSION);
    expect(r.applied).toContain(39);
    expect(tableExists(db, "hitch_evidence")).toBe(true);
    const cols = columns(db, "hitch_evidence");
    expect(cols).toContain("evidence_id");
    expect(cols).toContain("hitch_id");
    expect(cols).toContain("run_id");
    expect(cols).toContain("condition_id");
    expect(cols).toContain("kind");
    expect(cols).toContain("attester");
    expect(cols).toContain("label");
    // attester_label is intentionally NOT a column (operator-only, no label)
    expect(cols).not.toContain("attester_label");
    expect(cols).toContain("command");
    expect(cols).toContain("exit_code");
    expect(cols).toContain("summary_metrics_json");
    expect(cols).toContain("metrics_schema");
    expect(cols).toContain("output_excerpt");
    expect(cols).toContain("secret_suspect");
    expect(cols).toContain("redacted");
    expect(cols).toContain("created_at");
    // excerpt-only: must NOT have full-body blob columns
    expect(cols).not.toContain("blob_sha256");
    expect(cols).not.toContain("body_status");
  });

  it("is additive on a realistic v38 DB (table absent before, present after)", () => {
    const db = freshDb();
    seedThrough(db, 38);
    expect(tableExists(db, "hitch_evidence")).toBe(false);

    runMigrations(db);

    expect(tableExists(db, "hitch_evidence")).toBe(true);
    expect(columns(db, "hitch_evidence")).toContain("evidence_id");
  });

  it("re-running migrations is a no-op (idempotent)", () => {
    const db = freshDb();
    runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).not.toContain(39);
    expect(
      columns(db, "hitch_evidence").filter((c) => c === "evidence_id"),
    ).toHaveLength(1);
  });

  it("enforces kind CHECK constraint", () => {
    const db = freshDb();
    runMigrations(db);
    // set up a hitch_session first (FK ON DELETE CASCADE)
    db.prepare(
      `INSERT INTO hitch_sessions
         (hitch_id, project_id, title, status, scope_json, close_conditions_json,
          policy_json, max_iterations, max_review_cycles, max_reruns,
          max_total_new_findings, created_by, created_source, created_at, updated_at)
       VALUES ('h-1','p-1','T','open','{}','[]','{}',3,3,2,12,'t','cli',
               '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO hitch_evidence
             (evidence_id, hitch_id, kind, attester, label, created_at)
           VALUES ('e-bad', 'h-1', 'invalid_kind', 'operator', 'lbl', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });

  it("enforces attester CHECK constraint", () => {
    const db = freshDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO hitch_sessions
         (hitch_id, project_id, title, status, scope_json, close_conditions_json,
          policy_json, max_iterations, max_review_cycles, max_reruns,
          max_total_new_findings, created_by, created_source, created_at, updated_at)
       VALUES ('h-2','p-1','T','open','{}','[]','{}',3,3,2,12,'t','cli',
               '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO hitch_evidence
             (evidence_id, hitch_id, kind, attester, label, created_at)
           VALUES ('e-bad2', 'h-2', 'note', 'robot', 'lbl', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });

  // ── F4: attester CHECK is operator-only in Stage A ────────────────────────
  // 'agent'/'harness_auto' have no hardcode-stamped writer yet, so the DB must
  // reject them — defense-in-depth before the Stage B close-gate trusts the row.
  it.each(["agent", "harness_auto"])(
    "rejects non-operator attester '%s' (operator-only CHECK)",
    (badAttester) => {
      const db = freshDb();
      runMigrations(db);
      db.prepare(
        `INSERT INTO hitch_sessions
           (hitch_id, project_id, title, status, scope_json, close_conditions_json,
            policy_json, max_iterations, max_review_cycles, max_reruns,
            max_total_new_findings, created_by, created_source, created_at, updated_at)
         VALUES ('h-att','p-1','T','open','{}','[]','{}',3,3,2,12,'t','cli',
                 '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_evidence
               (evidence_id, hitch_id, kind, attester, label, created_at)
             VALUES ('e-att', 'h-att', 'note', ?, 'lbl', '2026-01-01T00:00:00Z')`,
          )
          .run(badAttester),
      ).toThrow();
    },
  );

  it("accepts a valid row with defaults and returns correct column values", () => {
    const db = freshDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO hitch_sessions
         (hitch_id, project_id, title, status, scope_json, close_conditions_json,
          policy_json, max_iterations, max_review_cycles, max_reruns,
          max_total_new_findings, created_by, created_source, created_at, updated_at)
       VALUES ('h-3','p-1','T','open','{}','[]','{}',3,3,2,12,'t','cli',
               '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO hitch_evidence
         (evidence_id, hitch_id, kind, attester, label, created_at)
       VALUES ('e-1', 'h-3', 'command', 'operator', 'my label', '2026-01-01T00:00:00Z')`,
    ).run();
    const row = db
      .prepare("SELECT * FROM hitch_evidence WHERE evidence_id='e-1'")
      .get() as Record<string, unknown>;
    expect(row["summary_metrics_json"]).toBe("{}");
    expect(row["metrics_schema"]).toBe(1);
    expect(row["secret_suspect"]).toBe(0);
    expect(row["redacted"]).toBe(0);
    expect(row["run_id"]).toBeNull();
    expect(row["output_excerpt"]).toBeNull();
  });
});
