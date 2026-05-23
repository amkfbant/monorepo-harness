import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations, currentSchemaVersion } from "../../../src/db/migrations.js";
import {
  MIGRATION_V1_STATEMENTS,
  MIGRATION_V2_STATEMENTS,
  MIGRATION_V3_STATEMENTS,
} from "../../../src/db/schema.js";

/**
 * Phase 8-1 — schema v4 (runtime DB complete).
 *
 * v4 adds artifact-body blob storage, rebuilds `artifacts` to allow
 * `storage='db'` + `blob_sha256` / `body_status`, and gives
 * `pull_requests` a `UNIQUE(run_id)` index (de-duplicating first).
 */

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-db-v4-"));
  return join(dir, ".harness", "harness.sqlite");
}

/** Open a DB stamped at schema v3 (v1+v2+v3 applied, v4 NOT yet). */
function v3Db(path: string): Database.Database {
  const db = openDb(path);
  const tx = db.transaction(() => {
    for (const s of MIGRATION_V1_STATEMENTS) db.prepare(s).run();
    for (const s of MIGRATION_V2_STATEMENTS) db.prepare(s).run();
    for (const s of MIGRATION_V3_STATEMENTS) db.prepare(s).run();
    db.prepare(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    ).run();
    for (const v of [1, 2, 3]) {
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(v, `v${v}`, "2026-05-22T00:00:00Z");
    }
  });
  tx();
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) as { n: number }
  ).n > 0;
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
}

describe("schema v4 migration", () => {
  it("v1→…→latest creates the v4 blob tables", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    // runMigrations advances to the latest schema (v5 since Phase 9);
    // v4-introduced tables must be present at any version >= 4.
    expect(tableExists(db, "artifact_blobs")).toBe(true);
    expect(tableExists(db, "artifact_blob_chunks")).toBe(true);
    db.close();
  });

  it("is idempotent — re-running applies nothing", () => {
    const path = freshDbPath();
    const db = openDb(path);
    const first = runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.version).toBe(first.version);
    db.close();
  });

  it("rebuilds artifacts with blob_sha256 / body_status and storage='db'", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    const cols = columns(db, "artifacts");
    expect(cols.has("blob_sha256")).toBe(true);
    expect(cols.has("body_status")).toBe(true);
    // storage='db' is now accepted (the v1 CHECK only allowed 'file')
    db.prepare(
      `INSERT INTO artifacts (artifact_id, kind, bytes, sha256, storage,
         body_status)
       VALUES ('a1', 'log', 1, 'h', 'db', 'db_available')`,
    ).run();
    expect(
      (
        db
          .prepare("SELECT storage FROM artifacts WHERE artifact_id = 'a1'")
          .get() as { storage: string }
      ).storage,
    ).toBe("db");
    db.close();
  });

  it("preserves existing artifacts rows across the v4 rebuild", () => {
    const path = freshDbPath();
    const db = v3Db(path);
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path, bytes,
         sha256, storage)
       VALUES ('old-1', 'run-x', 'summary', 'summary.md', 42, 'sha-old',
         'file')`,
    ).run();
    db.close();

    const up = openDb(path);
    runMigrations(up); // applies v4 — rebuilds artifacts
    const row = up
      .prepare("SELECT * FROM artifacts WHERE artifact_id = 'old-1'")
      .get() as Record<string, unknown>;
    up.close();
    expect(row.run_id).toBe("run-x");
    expect(row.bytes).toBe(42);
    expect(row.sha256).toBe("sha-old");
    // an existing file-backed artifact becomes body_status='legacy_file'
    expect(row.body_status).toBe("legacy_file");
    expect(row.blob_sha256).toBeNull();
  });

  it("gives pull_requests a UNIQUE(run_id), de-duplicating first", () => {
    const path = freshDbPath();
    const db = v3Db(path);
    // a v3 DB with two PR rows for the same run (pre-UNIQUE)
    for (const id of [1, 2]) {
      db.prepare(
        `INSERT INTO pull_requests (id, run_id, provider, status, created_at,
           updated_at)
         VALUES (?, 'run-x', 'github', 'created', 't', 't')`,
      ).run(id);
    }
    db.close();

    const up = openDb(path);
    runMigrations(up); // v4 de-dups then adds UNIQUE(run_id)
    const count = (
      up
        .prepare("SELECT count(*) AS n FROM pull_requests WHERE run_id = 'run-x'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(1); // only the latest id survived
    // the older non-canonical row was salvaged into pull_request_attempts
    const attempts = (
      up
        .prepare(
          "SELECT count(*) AS n FROM pull_request_attempts WHERE run_id = 'run-x'",
        )
        .get() as { n: number }
    ).n;
    expect(attempts).toBe(1);
    // the UNIQUE index now rejects a duplicate run_id
    expect(() =>
      up
        .prepare(
          `INSERT INTO pull_requests (run_id, provider, status, created_at,
             updated_at)
           VALUES ('run-x', 'github', 'created', 't', 't')`,
        )
        .run(),
    ).toThrow();
    up.close();
  });

  it("rejects an unknown content_encoding on artifact_blobs (P2)", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO artifact_blobs (sha256, bytes, content_encoding,
             stored_bytes, chunk_count, created_at)
           VALUES ('h', 1, 'lzma', 1, 1, 't')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
});
