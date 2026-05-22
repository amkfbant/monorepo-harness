import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { migrateLegacy } from "../../../src/db/migrate-legacy.js";

/** Phase 8-6 — legacy-file → db-first migration. */

function setup(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "harness-mig-leg-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { root, db };
}

function seedLegacyRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch, status,
       updated_at, source_mode, db_revision, export_status, meta_json)
     VALUES (?, 'r', 'apps/x', 'domain-coding', 'main', 'needs_review',
       't', 'legacy-file', 0, 'synced', NULL)`,
  ).run(runId);
}

function sourceMode(db: Database.Database, runId: string): string {
  return (
    db.prepare("SELECT source_mode FROM runs WHERE run_id = ?").get(runId) as {
      source_mode: string;
    }
  ).source_mode;
}

describe("migrateLegacy", () => {
  it("converts legacy-file runs to db-first, backfilling meta_json", () => {
    const { root, db } = setup();
    seedLegacyRun(db, "run-leg");
    const runDir = join(root, "runs", "run-leg");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "meta.json"), '{"runId":"run-leg"}\n');

    const report = migrateLegacy(db, { runsDir: join(root, "runs") });
    expect(report.runs).toBe(1);
    expect(sourceMode(db, "run-leg")).toBe("db-first");
    const row = db
      .prepare("SELECT meta_json, export_status FROM runs WHERE run_id = ?")
      .get("run-leg") as { meta_json: string; export_status: string };
    expect(row.meta_json).toBe('{"runId":"run-leg"}');
    expect(row.export_status).toBe("dirty");
    db.close();
  });

  it("counts a run with no meta.json file (meta_json left NULL)", () => {
    const { root, db } = setup();
    seedLegacyRun(db, "run-nofile");
    const report = migrateLegacy(db, { runsDir: join(root, "runs") });
    expect(report.runs).toBe(1);
    expect(report.runsWithoutMetaFile).toBe(1);
    const row = db
      .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
      .get("run-nofile") as { meta_json: string | null };
    expect(row.meta_json).toBeNull();
    db.close();
  });

  it("converts legacy backlog items and knowledge candidates", () => {
    const { root, db } = setup();
    db.prepare(
      `INSERT INTO backlog_items (item_id, domain, title, goal, status,
         priority, tags_json, created_at, updated_at, source_mode,
         db_revision, export_status)
       VALUES ('b1', 'apps/x', 't', 'g', 'open', 'medium', '[]', 't', 't',
         'legacy-file', 0, 'synced')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_candidates (candidate_id, run_id, domain, kind,
         title, body, status, created_at, source_mode, db_revision,
         export_status)
       VALUES ('c1', 'run-x', 'apps/x', 'policy_improvement', 't', 'b',
         'pending', 't', 'legacy-file', 0, 'synced')`,
    ).run();
    const report = migrateLegacy(db, { runsDir: join(root, "runs") });
    expect(report.backlogItems).toBe(1);
    expect(report.knowledgeCandidates).toBe(1);
    db.close();
  });

  it("is idempotent — a second run converts nothing", () => {
    const { root, db } = setup();
    seedLegacyRun(db, "run-leg");
    migrateLegacy(db, { runsDir: join(root, "runs") });
    const again = migrateLegacy(db, { runsDir: join(root, "runs") });
    expect(again.runs).toBe(0);
    expect(again.backlogItems).toBe(0);
    db.close();
  });

  it("does not promote a run with file-backed artifact bodies (P1)", () => {
    const { root, db } = setup();
    seedLegacyRun(db, "run-art");
    // a non-reconstructed artifact still storage='file' (not backfilled)
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path, bytes,
         sha256, storage, body_status)
       VALUES ('run-art:codex-output.log', 'run-art', 'codex-output',
         'codex-output.log', 1, 'h', 'file', 'legacy_file')`,
    ).run();
    const report = migrateLegacy(db, { runsDir: join(root, "runs") });
    expect(report.runs).toBe(0);
    expect(report.runsBlockedByArtifacts).toBe(1);
    expect(sourceMode(db, "run-art")).toBe("legacy-file");
    db.close();
  });

  it("promotes a run once its artifacts are db-backed (DB_RECONSTRUCTED ok)", () => {
    const { root, db } = setup();
    seedLegacyRun(db, "run-ok");
    // meta.json is DB-reconstructed — a storage='file' meta.json artifact
    // does NOT block promotion
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path, bytes,
         sha256, storage, body_status)
       VALUES ('run-ok:meta.json', 'run-ok', 'meta', 'meta.json', 1, 'h',
         'file', 'legacy_file')`,
    ).run();
    // a real artifact body already migrated to the DB
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path, bytes,
         sha256, storage, blob_sha256, body_status)
       VALUES ('run-ok:summary.md', 'run-ok', 'summary', 'summary.md', 1, 'h',
         'db', 'h', 'db_available')`,
    ).run();
    const report = migrateLegacy(db, { runsDir: join(root, "runs") });
    expect(report.runs).toBe(1);
    expect(report.runsBlockedByArtifacts).toBe(0);
    db.close();
  });
});
