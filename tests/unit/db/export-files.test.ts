import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb, DbError } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  atomicWriteFile,
  beginExporting,
  endExporting,
  isExporting,
} from "../../../src/db/atomic-write.js";
import { exportRun } from "../../../src/db/export-files.js";
import { importRuns } from "../../../src/db/import/runs.js";
import { emptyCounters } from "../../../src/db/import/common.js";

/**
 * Phase 7-2 — scoped export engine: atomic write, the `.exporting`
 * marker, `exportRun` (DB → files) and its integrity tracking.
 */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-export-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-export-"));
}

function insertRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, repo_path, domain, workflow,
       base_branch, base_sha, run_branch, status, safety_status,
       started_at, finished_at, changed_files_count, updated_at,
       source_mode, db_revision, export_status)
     VALUES (?, 'demo', '/repo', 'apps/web', 'domain-coding', 'main',
       'abc123', 'harness/run', 'needs_review', 'allowed',
       '2026-05-22T00:00:00Z', '2026-05-22T00:05:00Z', 3,
       '2026-05-22T00:05:00Z', 'db-first', 3, 'dirty')`,
  ).run(runId);
}

describe("atomicWriteFile", () => {
  it("writes content and leaves no temp file behind", () => {
    const dir = tmpDir();
    const path = join(dir, "sub", "out.txt");
    atomicWriteFile(path, "hello\n");
    expect(readFileSync(path, "utf8")).toBe("hello\n");
    atomicWriteFile(path, "replaced\n");
    expect(readFileSync(path, "utf8")).toBe("replaced\n");
    const leftover = readdirSync(join(dir, "sub")).filter((n) =>
      n.includes(".tmp."),
    );
    expect(leftover).toEqual([]);
  });

  it("begin/end mark and clear the .exporting marker", () => {
    const dir = tmpDir();
    expect(isExporting(dir)).toBe(false);
    beginExporting(dir);
    expect(isExporting(dir)).toBe(true);
    endExporting(dir);
    expect(isExporting(dir)).toBe(false);
  });
});

describe("exportRun", () => {
  it("writes meta.json and events.jsonl from DB rows", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    insertRun(db, "run-a");
    db.prepare(
      `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
       VALUES ('run-a', 0, 'run_started', '2026-05-22T00:00:00Z',
         '{"type":"run_started"}'),
              ('run-a', 1, 'run_completed', '2026-05-22T00:05:00Z',
         '{"type":"run_completed"}')`,
    ).run();

    const res = exportRun(db, "run-a", { runsDir });
    expect(res.status).toBe("synced");
    expect(res.dbRevision).toBe(3);

    const runDir = join(runsDir, "run-a");
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({
      runId: "run-a",
      repoId: "demo",
      domain: "apps/web",
      status: "needs_review",
      safetyStatus: "allowed",
    });
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0] as string).type).toBe("run_started");
    // a successful export clears its in-progress marker
    expect(isExporting(runDir)).toBe(false);
    db.close();
  });

  it("records export_records, exported_files and the run status", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    insertRun(db, "run-b");
    exportRun(db, "run-b", { runsDir });

    const rec = db
      .prepare(
        "SELECT status, db_revision FROM export_records WHERE scope_id = 'run-b'",
      )
      .get() as { status: string; db_revision: number };
    expect(rec).toEqual({ status: "synced", db_revision: 3 });

    const files = (
      db
        .prepare(
          "SELECT relative_path FROM exported_files WHERE scope_id = 'run-b' ORDER BY relative_path",
        )
        .all() as { relative_path: string }[]
    ).map((r) => r.relative_path);
    expect(files).toEqual(["meta.json"]);

    const run = db
      .prepare(
        `SELECT export_status, last_export_revision, last_export_error
         FROM runs WHERE run_id = 'run-b'`,
      )
      .get() as {
      export_status: string;
      last_export_revision: number;
      last_export_error: string | null;
    };
    expect(run.export_status).toBe("synced");
    expect(run.last_export_revision).toBe(3);
    expect(run.last_export_error).toBeNull();
    db.close();
  });

  it("round-trips: an exported run re-imports to an equivalent row", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    insertRun(db, "run-c");
    db.prepare(
      `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
       VALUES ('run-c', 0, 'run_started', '2026-05-22T00:00:00Z',
         '{"type":"run_started"}')`,
    ).run();
    exportRun(db, "run-c", { runsDir });

    // re-import the exported files into a fresh DB
    const db2 = freshDb();
    importRuns(db2, runsDir, emptyCounters());
    const reimported = db2
      .prepare(
        `SELECT repo_id, domain, status, safety_status, started_at,
                changed_files_count
         FROM runs WHERE run_id = 'run-c'`,
      )
      .get() as Record<string, unknown>;
    expect(reimported).toEqual({
      repo_id: "demo",
      domain: "apps/web",
      status: "needs_review",
      safety_status: "allowed",
      started_at: "2026-05-22T00:00:00Z",
      changed_files_count: 3,
    });
    db.close();
    db2.close();
  });

  it("throws DbError for a run absent from the DB", () => {
    const db = freshDb();
    expect(() => exportRun(db, "missing", { runsDir: tmpDir() })).toThrow(
      DbError,
    );
    db.close();
  });

  it("records a failed export without throwing when the write fails", () => {
    const db = freshDb();
    insertRun(db, "run-d");
    // a runsDir whose parent is a regular file — mkdir will fail
    const blocker = join(tmpDir(), "not-a-dir");
    writeFileSync(blocker, "x");
    const res = exportRun(db, "run-d", { runsDir: join(blocker, "runs") });
    expect(res.status).toBe("failed");
    expect(res.error).toBeTruthy();

    const run = db
      .prepare(
        "SELECT export_status, last_export_error FROM runs WHERE run_id = 'run-d'",
      )
      .get() as { export_status: string; last_export_error: string | null };
    expect(run.export_status).toBe("failed");
    expect(run.last_export_error).toBeTruthy();
    const rec = db
      .prepare("SELECT status FROM export_records WHERE scope_id = 'run-d'")
      .get() as { status: string };
    expect(rec.status).toBe("failed");
    db.close();
  });

  it("the importer ignores the transient .exporting marker", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    insertRun(db, "run-e");
    const runDir = join(runsDir, "run-e");
    exportRun(db, "run-e", { runsDir });
    // simulate a crashed export leaving a stale marker
    beginExporting(runDir);
    expect(existsSync(join(runDir, ".exporting"))).toBe(true);

    const db2 = freshDb();
    importRuns(db2, runsDir, emptyCounters());
    // the marker produced no artifact row
    const artifacts = (
      db2
        .prepare(
          "SELECT relative_path FROM artifacts WHERE run_id = 'run-e'",
        )
        .all() as { relative_path: string }[]
    ).map((r) => r.relative_path);
    expect(artifacts).not.toContain(".exporting");
    db.close();
    db2.close();
  });
});
