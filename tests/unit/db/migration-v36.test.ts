import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  runMigrations,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
} from "../../../src/db/migrations.js";
import { ALL_TABLE_NAMES, CURRENT_TABLE_NAMES } from "../../../src/db/schema.js";

const V36_TABLES = ["agent_invocation", "agent_usage_turn"];

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Apply every migration with version <= 35 (the pre-v36 baseline) and stamp
 * each row, mirroring `runMigrations` without the name-integrity guard so a v36
 * upgrade can be exercised on a realistic v35 DB.
 */
function seedThroughV35(db: Database.Database): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  const ordered = [...MIGRATIONS]
    .filter((m) => m.version <= 35)
    .sort((a, b) => a.version - b.version);
  for (const m of ordered) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    insert.run(m.version, m.name, "2026-01-01T00:00:00Z");
  }
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, updated_at)
     VALUES (?, 'r', 'apps/web', 'domain-coding', 'main',
       'needs_review', '2026-01-01T00:00:00Z')`,
  ).run(runId);
}

describe("v36 agent_invocation / agent_usage_turn migration", () => {
  it("LATEST_SCHEMA_VERSION is at or beyond v36", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(36);
  });

  it("fresh migration creates the v36 telemetry tables and records version 36", () => {
    const db = freshDb();
    const r = runMigrations(db);
    expect(r.version).toBe(LATEST_SCHEMA_VERSION);
    expect(r.applied).toContain(36);
    for (const t of V36_TABLES) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(t);
      expect(row, `table ${t} must exist`).toBeTruthy();
    }
  });

  it("agent_invocation has ZERO foreign keys (audit-backbone posture)", () => {
    const db = freshDb();
    runMigrations(db);
    const fks = db.prepare("PRAGMA foreign_key_list(agent_invocation)").all();
    expect(fks, "agent_invocation must have no FK").toHaveLength(0);
  });

  it("agent_usage_turn FK cascade-deletes when its invocation is removed", () => {
    const db = freshDb();
    runMigrations(db);
    const fks = db.prepare(
      "PRAGMA foreign_key_list(agent_usage_turn)",
    ).all() as { table: string; on_delete: string }[];
    expect(fks).toHaveLength(1);
    expect(fks[0]?.table).toBe("agent_invocation");
    expect(fks[0]?.on_delete).toBe("CASCADE");

    db.prepare(
      `INSERT INTO agent_invocation
         (invocation_id, tool, role, run_id, invocation_seq, usage_source, created_at)
       VALUES ('inv-c', 'claude', 'external', NULL, 0, 'exact', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_usage_turn
         (invocation_id, turn_seq, input_tokens, output_tokens, total_tokens,
          cache_read_input_tokens, usage_source, created_at)
       VALUES ('inv-c', 0, 10, 5, 15, 3, 'exact', 't')`,
    ).run();
    db.prepare("DELETE FROM agent_invocation WHERE invocation_id = 'inv-c'").run();
    const turns = db
      .prepare("SELECT COUNT(*) AS c FROM agent_usage_turn")
      .get() as { c: number };
    expect(turns.c).toBe(0);
  });

  it("UNION token CHECK rejects mixed codex+claude token classes", () => {
    const db = freshDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_invocation
         (invocation_id, tool, role, run_id, invocation_seq, usage_source, created_at)
       VALUES ('inv-m', 'claude', 'external', NULL, 0, 'exact', 't')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_usage_turn
             (invocation_id, turn_seq, input_tokens, output_tokens, total_tokens,
              cached_input_tokens, cache_read_input_tokens, usage_source, created_at)
           VALUES ('inv-m', 0, 10, 5, 15, 7, 3, 'exact', 't')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it("UNION token CHECK accepts a pure codex turn and a pure claude turn", () => {
    const db = freshDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_invocation
         (invocation_id, tool, role, run_id, invocation_seq, usage_source, created_at)
       VALUES ('inv-cx', 'claude', 'external', NULL, 0, 'exact', 't')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_usage_turn
             (invocation_id, turn_seq, input_tokens, output_tokens, total_tokens,
              cached_input_tokens, reasoning_output_tokens, usage_source, created_at)
           VALUES ('inv-cx', 0, 10, 5, 15, 7, 2, 'exact', 't')`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_usage_turn
             (invocation_id, turn_seq, input_tokens, output_tokens, total_tokens,
              cache_read_input_tokens, cache_creation_5m_input_tokens, usage_source, created_at)
           VALUES ('inv-cx', 1, 10, 5, 15, 3, 4, 'exact', 't')`,
        )
        .run(),
    ).not.toThrow();
  });

  it("partial unique allows many NULL session/agent rows but rejects a duplicate session+agent", () => {
    const db = freshDb();
    runMigrations(db);
    // Two codex-style rows with NULL session/agent must coexist (outside the
    // partial unique index).
    db.prepare(
      `INSERT INTO agent_invocation
         (invocation_id, tool, role, run_id, invocation_seq, usage_source, created_at)
       VALUES ('inv-n1', 'claude', 'external', NULL, 0, 'exact', 't')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_invocation
             (invocation_id, tool, role, run_id, invocation_seq, usage_source, created_at)
           VALUES ('inv-n2', 'claude', 'external', NULL, 0, 'exact', 't')`,
        )
        .run(),
    ).not.toThrow();
    // First (session, agent) row OK.
    db.prepare(
      `INSERT INTO agent_invocation
         (invocation_id, tool, role, session_id, agent_id, invocation_seq, usage_source, created_at)
       VALUES ('inv-s1', 'claude', 'external', 'sess-1', 'agent-1', 0, 'exact', 't')`,
    ).run();
    // Duplicate (session, agent) must be rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_invocation
             (invocation_id, tool, role, session_id, agent_id, invocation_seq, usage_source, created_at)
           VALUES ('inv-s2', 'claude', 'external', 'sess-1', 'agent-1', 0, 'exact', 't')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("identity CHECK rejects a session_id without an agent_id", () => {
    const db = freshDb();
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_invocation
             (invocation_id, tool, role, session_id, agent_id, invocation_seq, usage_source, created_at)
           VALUES ('inv-i', 'claude', 'external', 'sess-x', NULL, 0, 'exact', 't')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it("role CHECK rejects a non-external row with NULL run_id", () => {
    const db = freshDb();
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_invocation
             (invocation_id, tool, role, run_id, invocation_seq, usage_source, created_at)
           VALUES ('inv-r', 'codex', 'coder', NULL, 0, 'exact', 't')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it("union health: CURRENT_TABLE_NAMES EXACTLY matches sqlite_master tables", () => {
    const db = freshDb();
    runMigrations(db);
    for (const t of V36_TABLES) expect(ALL_TABLE_NAMES).toContain(t);
    const META = new Set(["schema_migrations"]);
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
    expect(declared).toEqual(live);
  });

  it("idempotent: second runMigrations is a no-op", () => {
    const db = freshDb();
    runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
  });

  it("backfills v30 run_usage rows into agent_invocation + agent_usage_turn (turn_seq=0, deterministic id)", () => {
    const db = freshDb();
    seedThroughV35(db);
    seedRun(db, "run-x");
    db.prepare(
      `INSERT INTO run_usage
         (run_id, kind, seq, model, input_tokens, cached_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens, usage_source, created_at)
       VALUES ('run-x', 'coder', 0, NULL, 100, 90, 10, 5, 110, 'exact', '2026-01-01T00:00:00Z')`,
    ).run();
    // An 'unavailable' row (all token fields NULL) must also backfill cleanly.
    db.prepare(
      `INSERT INTO run_usage
         (run_id, kind, seq, model, input_tokens, cached_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens, usage_source, created_at)
       VALUES ('run-x', 'reviewer', 0, NULL, NULL, NULL, NULL, NULL, NULL, 'unavailable', '2026-01-01T00:00:00Z')`,
    ).run();

    const r = runMigrations(db);
    expect(r.applied).toEqual([36, 37, 38, 39]);

    const ru = db.prepare("SELECT COUNT(*) AS c FROM run_usage").get() as {
      c: number;
    };
    const inv = db
      .prepare("SELECT COUNT(*) AS c FROM agent_invocation")
      .get() as { c: number };
    const turn = db
      .prepare("SELECT COUNT(*) AS c FROM agent_usage_turn")
      .get() as { c: number };
    // COUNT gate: no silent INSERT OR IGNORE drop.
    expect(inv.c).toBe(ru.c);
    expect(turn.c).toBe(ru.c);

    const coder = db
      .prepare(
        `SELECT invocation_id, tool, role, run_id, model, invocation_seq, usage_source
           FROM agent_invocation WHERE run_id='run-x' AND role='coder'`,
      )
      .get() as Record<string, unknown>;
    expect(coder.invocation_id).toBe("bf:run-x:coder:0");
    expect(coder.tool).toBe("codex");
    expect(coder.model).toBeNull();
    expect(coder.invocation_seq).toBe(0);
    expect(coder.usage_source).toBe("exact");

    const coderTurn = db
      .prepare(
        `SELECT turn_seq, input_tokens, cached_input_tokens, output_tokens,
                reasoning_output_tokens, total_tokens, cache_read_input_tokens
           FROM agent_usage_turn WHERE invocation_id='bf:run-x:coder:0'`,
      )
      .get() as Record<string, unknown>;
    expect(coderTurn.turn_seq).toBe(0);
    expect(coderTurn.input_tokens).toBe(100);
    expect(coderTurn.cached_input_tokens).toBe(90);
    expect(coderTurn.output_tokens).toBe(10);
    expect(coderTurn.reasoning_output_tokens).toBe(5);
    expect(coderTurn.total_tokens).toBe(110);
    expect(coderTurn.cache_read_input_tokens).toBeNull();
  });

  it("backfill is deterministic and idempotent across a re-applied migration", () => {
    const db = freshDb();
    seedThroughV35(db);
    seedRun(db, "run-y");
    db.prepare(
      `INSERT INTO run_usage
         (run_id, kind, seq, model, input_tokens, cached_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens, usage_source, created_at)
       VALUES ('run-y', 'coder', 0, NULL, 1, 0, 1, 0, 2, 'exact', '2026-01-01T00:00:00Z')`,
    ).run();
    runMigrations(db);
    const first = db
      .prepare("SELECT invocation_id FROM agent_invocation WHERE run_id='run-y'")
      .get() as { invocation_id: string };
    expect(first.invocation_id).toBe("bf:run-y:coder:0");
    // A second runMigrations must not duplicate (INSERT OR IGNORE on stable id).
    runMigrations(db);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM agent_invocation WHERE run_id='run-y'")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});
