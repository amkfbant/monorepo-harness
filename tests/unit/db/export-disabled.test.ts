import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { exportRun } from "../../../src/db/export-files.js";
import { fileExportEnabled } from "../../../src/config/export-mode.js";

/** Phase 8-5 — opt-out file export (DB-only mode). */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-exp-off-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function insertRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, repo_path, domain, workflow,
       base_branch, base_sha, run_branch, status, safety_status,
       started_at, finished_at, changed_files_count, updated_at,
       source_mode, db_revision, export_status)
     VALUES (?, 'demo', '/repo', 'apps/web', 'domain-coding', 'main',
       'abc', 'harness/run', 'needs_review', 'allowed',
       't', 't', 0, 't', 'db-first', 2, 'dirty')`,
  ).run(runId);
}

const PRIOR = process.env.HARNESS_EXPORT_FILES;
afterEach(() => {
  if (PRIOR === undefined) delete process.env.HARNESS_EXPORT_FILES;
  else process.env.HARNESS_EXPORT_FILES = PRIOR;
});

describe("fileExportEnabled", () => {
  it("defaults to ON, OFF for falsy values", () => {
    delete process.env.HARNESS_EXPORT_FILES;
    expect(fileExportEnabled()).toBe(true);
    for (const v of ["0", "false", "off", "no", "OFF"]) {
      process.env.HARNESS_EXPORT_FILES = v;
      expect(fileExportEnabled()).toBe(false);
    }
    process.env.HARNESS_EXPORT_FILES = "1";
    expect(fileExportEnabled()).toBe(true);
  });
});

describe("exportRun with file export disabled", () => {
  it("skips the file write and marks export_status='disabled'", () => {
    process.env.HARNESS_EXPORT_FILES = "0";
    const db = freshDb();
    const runsDir = mkdtempSync(join(tmpdir(), "harness-exp-off-runs-"));
    insertRun(db, "run-off");
    const r = exportRun(db, "run-off", { runsDir });
    expect(r.status).toBe("disabled");
    expect(r.files).toEqual([]);
    expect(existsSync(join(runsDir, "run-off", "meta.json"))).toBe(false);
    const row = db
      .prepare("SELECT export_status FROM runs WHERE run_id = 'run-off'")
      .get() as { export_status: string };
    expect(row.export_status).toBe("disabled");
    db.close();
  });

  it("still exports when force is passed (explicit db export-files)", () => {
    process.env.HARNESS_EXPORT_FILES = "0";
    const db = freshDb();
    const runsDir = mkdtempSync(join(tmpdir(), "harness-exp-off-runs-"));
    insertRun(db, "run-forced");
    const r = exportRun(db, "run-forced", { runsDir, force: true });
    expect(r.status).toBe("synced");
    expect(existsSync(join(runsDir, "run-forced", "meta.json"))).toBe(true);
    db.close();
  });
});
