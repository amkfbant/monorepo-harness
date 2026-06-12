import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import {
  MIGRATIONS,
  currentSchemaVersion,
  runMigrations,
} from "../../../src/db/migrations.js";
import { SCHEMA_VERSION } from "../../../src/db/schema.js";

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-db-v12-"));
  return join(dir, ".harness", "harness.sqlite");
}

function v11OnlyDb(): Database.Database {
  const db = openDb(freshDbPath());
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const m of MIGRATIONS.filter((migration) => migration.version < 12)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(m.version, m.name, new Date().toISOString());
  }
  return db;
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

describe("schema v12", () => {
  it("rebuilds artifacts to allow external storage and preserves existing rows", () => {
    const db = v11OnlyDb();
    try {
      expect(currentSchemaVersion(db)).toBe(11);
      db.prepare(
        `INSERT INTO artifacts
           (artifact_id, run_id, kind, relative_path, content_type, bytes,
            sha256, storage, blob_sha256, body_status, created_at,
            redacted, secret_suspect, original_bytes, original_sha256)
         VALUES
           ('run-a:summary.md', 'run-a', 'summary', 'summary.md',
            'text/markdown', 3, 'abc', 'db', 'abc', 'db_available',
            '2026-05-25T00:00:00.000Z', 0, 0, NULL, NULL)`,
      ).run();

      const result = runMigrations(db);
      expect(result.applied).toEqual([
        12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
      ]);
      expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);

      const preserved = db
        .prepare(
          "SELECT storage, blob_sha256, body_status FROM artifacts WHERE artifact_id = ?",
        )
        .get("run-a:summary.md") as {
        storage: string;
        blob_sha256: string;
        body_status: string;
      };
      expect(preserved).toEqual({
        storage: "db",
        blob_sha256: "abc",
        body_status: "db_available",
      });

      expect(() =>
        db.prepare(
          `INSERT INTO artifacts
             (artifact_id, kind, bytes, sha256, storage, body_status)
           VALUES ('external-a', 'summary', 1, 'def', 'external', 'external_available')`,
        ).run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("adds queryable run asset-attribution columns", () => {
    const db = v11OnlyDb();
    try {
      runMigrations(db);
      const cols = columnNames(db, "runs");
      expect(cols.has("project_profile_revision_id")).toBe(true);
      expect(cols.has("effective_policy_snapshot_id")).toBe(true);
      expect(cols.has("knowledge_revision_ids_json")).toBe(true);
    } finally {
      db.close();
    }
  });
});
