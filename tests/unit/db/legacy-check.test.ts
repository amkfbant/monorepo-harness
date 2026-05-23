import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  assertNoLegacyRuntimeRows,
  LegacyRowsFoundError,
} from "../../../src/db/legacy-check.js";

/**
 * Phase 9-11 — legacy-file removal gate.
 */

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "harness-legchk-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("assertNoLegacyRuntimeRows", () => {
  it("is a no-op on a freshly migrated empty DB", () => {
    const db = freshDb();
    expect(() => assertNoLegacyRuntimeRows(db)).not.toThrow();
    db.close();
  });

  it("throws LegacyRowsFoundError when runs has a legacy-file row", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at)
       VALUES ('run-legacy', 'r', 'apps/x', 'domain-coding', 'main',
         'needs_review', 'legacy-file', 0, 'synced', 't')`,
    ).run();
    expect(() => assertNoLegacyRuntimeRows(db)).toThrow(LegacyRowsFoundError);
    db.close();
  });

  it("throws when backlog_items has a legacy-file row", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO backlog_items (item_id, domain, title, goal, status,
         priority, tags_json, created_at, source_mode, db_revision)
       VALUES ('item-1', 'd', 't', 'g', 'open', 'medium', '[]', 't',
         'legacy-file', 0)`,
    ).run();
    expect(() => assertNoLegacyRuntimeRows(db)).toThrow(/legacy-file row/);
    db.close();
  });

  it("passes once the runs row is migrated to db-first", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at)
       VALUES ('run-1', 'r', 'apps/x', 'domain-coding', 'main',
         'needs_review', 'db-first', 1, 'synced', 't')`,
    ).run();
    expect(() => assertNoLegacyRuntimeRows(db)).not.toThrow();
    db.close();
  });

  it("does NOT gate on knowledge_candidates — syncCandidate uses legacy-file as 'not yet decided'", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO knowledge_candidates (candidate_id, run_id, kind, status,
         source_mode, db_revision)
       VALUES ('c1', 'run-x', 'k', 'candidate', 'legacy-file', 0)`,
    ).run();
    expect(() => assertNoLegacyRuntimeRows(db)).not.toThrow();
    db.close();
  });

  it("error message names each table with at least one legacy-file row", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at)
       VALUES ('r1', 'r', 'd', 'w', 'main', 'needs_review',
         'legacy-file', 0, 'synced', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO backlog_items (item_id, domain, title, goal, status,
         priority, tags_json, created_at, source_mode, db_revision)
       VALUES ('b1', 'd', 't', 'g', 'open', 'medium', '[]', 't',
         'legacy-file', 0)`,
    ).run();
    try {
      assertNoLegacyRuntimeRows(db);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("runs=1");
      expect((e as Error).message).toContain("backlog_items=1");
      expect((e as Error).message).toContain("db migrate-legacy");
    }
    db.close();
  });
});
