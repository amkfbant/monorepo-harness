import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import {
  runMigrations,
  currentSchemaVersion,
} from "../../../src/db/migrations.js";
import {
  MIGRATION_V1_STATEMENTS,
  MIGRATION_V2_STATEMENTS,
  MIGRATION_V3_STATEMENTS,
  MIGRATION_V4_STATEMENTS,
  SCHEMA_VERSION,
} from "../../../src/db/schema.js";

/**
 * Phase 9-1 — schema v5 (concurrency + runtime completion).
 *
 * v5 adds:
 *   - `domain_locks` (lease + heartbeat + fencing token = lock_id)
 *   - `review_proposals` (DB-canonical review verdict)
 *   - `artifacts.original_bytes` / `original_sha256` (truncation audit)
 *   - `runs.lease_lock_id` / `lease_token` / `lease_domain_key`
 *   - partial unique indexes for "at most one active lease per domain"
 *     and "at most one active proposal per (run, reviewer)"
 */

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-db-v5-"));
  return join(dir, ".harness", "harness.sqlite");
}

/** Open a DB stamped at schema v4 (v1..v4 applied, v5 NOT yet). */
function v4Db(path: string): Database.Database {
  const db = openDb(path);
  const tx = db.transaction(() => {
    for (const s of MIGRATION_V1_STATEMENTS) db.prepare(s).run();
    for (const s of MIGRATION_V2_STATEMENTS) db.prepare(s).run();
    for (const s of MIGRATION_V3_STATEMENTS) db.prepare(s).run();
    for (const s of MIGRATION_V4_STATEMENTS) db.prepare(s).run();
    db.prepare(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    ).run();
    for (const v of [1, 2, 3, 4]) {
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(v, `v${v}`, "2026-05-23T00:00:00Z");
    }
  });
  tx();
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) as { n: number }
    ).n > 0
  );
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((c) => c.name),
  );
}

describe("schema v5 migration", () => {
  it("v1→v2→v3→v4→v5 reaches version 5 and creates the new tables", () => {
    const path = freshDbPath();
    const db = openDb(path);
    const r = runMigrations(db);
    expect(r.version).toBe(SCHEMA_VERSION);
    expect(tableExists(db, "domain_locks")).toBe(true);
    expect(tableExists(db, "review_proposals")).toBe(true);
    const runs = columns(db, "runs");
    expect(runs.has("lease_lock_id")).toBe(true);
    expect(runs.has("lease_token")).toBe(true);
    expect(runs.has("lease_domain_key")).toBe(true);
    const artifacts = columns(db, "artifacts");
    expect(artifacts.has("original_bytes")).toBe(true);
    expect(artifacts.has("original_sha256")).toBe(true);
    db.close();
  });

  it("is idempotent — re-running applies nothing", () => {
    const path = freshDbPath();
    const db = openDb(path);
    runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("applies cleanly on top of an existing v4 DB without breaking rows", () => {
    const path = freshDbPath();
    const db = v4Db(path);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at)
       VALUES ('run-v4', 'r', 'apps/x', 'domain-coding', 'main',
         'needs_review', 'db-first', 1, 'synced', 't')`,
    ).run();
    const r = runMigrations(db);
    expect(r.applied).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24,
    ]);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const row = db
      .prepare(
        "SELECT lease_lock_id, lease_token, lease_domain_key FROM runs WHERE run_id = 'run-v4'",
      )
      .get() as {
      lease_lock_id: number | null;
      lease_token: number | null;
      lease_domain_key: string | null;
    };
    // existing rows get NULL for the new lease columns
    expect(row.lease_lock_id).toBeNull();
    expect(row.lease_token).toBeNull();
    expect(row.lease_domain_key).toBeNull();
    db.close();
  });

  it("domain_locks active partial unique index rejects two active rows per domain", () => {
    const path = freshDbPath();
    const db = openDb(path);
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO domain_locks (domain_key, repo_id, domain, holder_run_id,
         holder_pid, holder_hostname, acquired_at, expires_at, heartbeat_at)
       VALUES ('r::apps/x', 'r', 'apps/x', ?, 1, 'h', 't', 't', 't')`,
    );
    insert.run("run-a");
    // a second active lease on the same domain_key is rejected
    expect(() => insert.run("run-b")).toThrow(/UNIQUE/);
    // releasing the first lets a new lease be inserted
    db.prepare(
      "UPDATE domain_locks SET released_at = 't', release_reason = 'normal' WHERE holder_run_id = 'run-a'",
    ).run();
    expect(() => insert.run("run-b")).not.toThrow();
    db.close();
  });

  it("review_proposals active partial unique index rejects two active rows per (run, reviewer)", () => {
    const path = freshDbPath();
    const db = openDb(path);
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO review_proposals (run_id, reviewer, decision, reviewed_at,
         source_yaml, source_sha256, created_at)
       VALUES ('run-x', 'codex-reviewer', 'pending', 't', '...', 'sha', 't')`,
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE/);
    // marking the first as superseded lets a new active proposal in
    db.prepare(
      "UPDATE review_proposals SET superseded_at = 't' WHERE run_id = 'run-x' AND reviewer = 'codex-reviewer'",
    ).run();
    expect(() => insert.run()).not.toThrow();
    db.close();
  });

  it("review_proposals.decision CHECK rejects unknown values", () => {
    const path = freshDbPath();
    const db = openDb(path);
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO review_proposals (run_id, reviewer, decision,
             reviewed_at, source_yaml, source_sha256, created_at)
           VALUES ('run-x', 'rv', 'bogus', 't', 'y', 's', 't')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});
