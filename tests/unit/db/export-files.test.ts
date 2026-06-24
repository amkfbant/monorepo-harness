import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openDb, DbError } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  atomicWriteFile,
  beginExporting,
  endExporting,
  isExporting,
} from "../../../src/db/atomic-write.js";
import {
  exportKnowledgeDecisions,
  exportRun,
} from "../../../src/db/export-files.js";
import { ingestRunArtifacts } from "../../../src/db/run-artifacts.js";
import { importRuns } from "../../../src/db/import/runs.js";
import { emptyCounters } from "../../../src/db/import/common.js";
import {
  recordExternalBlob,
  registerBlobStore,
} from "../../../src/db/blob-stores.js";
import { LocalBlobStore } from "../../../src/storage/local-blob-store.js";

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

  it("leaves no temp file behind when the rename fails", () => {
    const dir = tmpDir();
    const path = join(dir, "target");
    // make the target a non-empty directory so the rename onto it fails
    mkdirSync(path);
    mkdirSync(join(path, "child"));
    expect(() => atomicWriteFile(path, "new\n")).toThrow();
    const leftover = readdirSync(dir).filter((n) => n.includes(".tmp."));
    expect(leftover).toEqual([]);
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
    // a needs_review run also exports the pending review-decision.yaml
    // template (Phase 8 — 8-2 P1-2)
    expect(files).toEqual(["meta.json", "review-decision.yaml"]);

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

  it("round-trips: run row, events and command results re-import", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    insertRun(db, "run-c");
    db.prepare(
      `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
       VALUES ('run-c', 0, 'run_started', NULL, '{"type":"run_started"}'),
              ('run-c', 1, 'run_completed', NULL, '{"type":"run_completed"}')`,
    ).run();
    db.prepare(
      `INSERT INTO command_results (run_id, command_index, command, exit_code,
         duration_ms, timed_out)
       VALUES ('run-c', 0, 'npm test', 0, 1200, 0)`,
    ).run();
    const res = exportRun(db, "run-c", { runsDir });

    // the recorded sha256 matches the bytes actually on disk
    const meta = res.files.find((f) => f.relativePath === "meta.json");
    expect(meta).toBeDefined();
    const rec = db
      .prepare(
        "SELECT sha256 FROM exported_files WHERE scope_id='run-c' AND relative_path='meta.json'",
      )
      .get() as { sha256: string };
    expect(rec.sha256).toBe(meta?.sha256);

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
    expect(
      (
        db2
          .prepare("SELECT count(*) AS n FROM run_events WHERE run_id='run-c'")
          .get() as { n: number }
      ).n,
    ).toBe(2);
    const cmd = db2
      .prepare(
        "SELECT command, exit_code FROM command_results WHERE run_id='run-c'",
      )
      .get() as { command: string; exit_code: number };
    expect(cmd).toEqual({ command: "npm test", exit_code: 0 });
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

  it("exports db-stored artifact bodies from artifact_blobs (Phase 8-4)", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    insertRun(db, "run-art");
    const runDir = join(runsDir, "run-art");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "codex-output.log"), "codex ran\n");
    // ingest the body into artifact_blobs (storage='db')
    ingestRunArtifacts(db, runDir, "run-art");
    // the run dir loses the artifact file — export must restore it
    rmSync(join(runDir, "codex-output.log"));

    const result = exportRun(db, "run-art", { runsDir });
    expect(result.status).toBe("synced");
    expect(readFileSync(join(runDir, "codex-output.log"), "utf8")).toBe(
      "codex ran\n",
    );
    expect(
      result.files.some((f) => f.relativePath === "codex-output.log"),
    ).toBe(true);
    db.close();
  });

  it("refuses to export corrupt external blob bytes", async () => {
    const db = freshDb();
    const runsDir = tmpDir();
    const storeRoot = tmpDir();
    insertRun(db, "run-ext");
    registerBlobStore(db, {
      storeId: "local",
      storeType: "local",
      config: { root: storeRoot },
    });
    const body = Buffer.from("external body\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const put = await new LocalBlobStore({ root: storeRoot }).put({
      sha256,
      body,
      contentEncoding: "identity",
    });
    recordExternalBlob(db, {
      sha256,
      storeId: "local",
      uri: put.uri,
      bytes: body.length,
      storedBytes: body.length,
      contentEncoding: "identity",
    });
    db.prepare(
      `INSERT INTO artifacts
         (artifact_id, run_id, kind, relative_path, content_type, bytes,
          sha256, storage, blob_sha256, body_status, created_at,
          redacted, secret_suspect)
       VALUES ('run-ext:summary.md', 'run-ext', 'summary', 'summary.md',
               'text/markdown', ?, ?, 'external', ?, 'external_available',
               '2026-05-25T00:00:00.000Z', 0, 0)`,
    ).run(body.length, sha256, sha256);
    writeFileSync(fileURLToPath(put.uri), "corrupt body\n");

    const result = exportRun(db, "run-ext", { runsDir });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/body sha/);
    expect(existsSync(join(runsDir, "run-ext", "summary.md"))).toBe(false);
    db.close();
  });

  it("exports review-decision.yaml from the DB review_decisions row (P1-2)", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    insertRun(db, "run-rev");
    const yaml = "runId: run-rev\ndecision: approved\nreviewed_at: t\n";
    db.prepare(
      `INSERT INTO review_decisions (run_id, decision, reviewer, summary,
         reviewed_at, source_yaml, source_sha256)
       VALUES ('run-rev', 'approved', 'kn', NULL, 't', ?, 'h')`,
    ).run(yaml);
    const result = exportRun(db, "run-rev", { runsDir });
    expect(result.status).toBe("synced");
    // review-decision.yaml is exported verbatim from source_yaml
    const path = join(runsDir, "run-rev", "review-decision.yaml");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(yaml);
    // it is tracked in the run's exported file set
    expect(
      result.files.some((f) => f.relativePath === "review-decision.yaml"),
    ).toBe(true);
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

  it("db import skips a db-first run and keeps its diff-result tables", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    insertRun(db, "run-dbf");
    // a DB-first run populates run_changed_files directly (Phase 7-4)
    db.prepare(
      `INSERT INTO run_changed_files (run_id, path, status, allowed, source)
       VALUES ('run-dbf', 'a.ts', 'tracked', 1, 'post-codex')`,
    ).run();
    exportRun(db, "run-dbf", { runsDir });
    // re-importing from the exported files must NOT wipe the diff tables:
    // a db-first run is DB-canonical and is skipped by the importer.
    importRuns(db, runsDir, emptyCounters());
    expect(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM run_changed_files WHERE run_id='run-dbf'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(1);
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

describe("exportKnowledgeDecisions", () => {
  it("does not write or track a decision sidecar when there are no rejected candidates", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    mkdirSync(join(runsDir, "run-no-rejections"), { recursive: true });
    db.prepare(
      `INSERT INTO knowledge_candidates (candidate_id, run_id, domain, kind,
         title, body, status, created_at, decided_at, reviewer, reason,
         source_mode, db_revision, export_status)
       VALUES ('run-no-rejections:0', 'run-no-rejections', 'apps/x',
         'policy_improvement', 't', 'c', 'promoted',
         '2026-05-22T00:00:00Z', '2026-05-22T01:00:00Z',
         'kn', NULL, 'db-first', 1, 'synced')`,
    ).run();
    writeFileSync(
      join(runsDir, "run-no-rejections", "knowledge-decisions.yaml"),
      "decisions:\n\n",
    );
    db.prepare(
      `INSERT INTO exported_files (scope_type, scope_id, relative_path,
         sha256, bytes, db_revision, exported_at)
       VALUES ('knowledge_decisions', 'run-no-rejections',
         'knowledge-decisions.yaml', 'stale-empty', 12, 1,
         '2026-05-22T02:00:00Z')`,
    ).run();

    const result = exportKnowledgeDecisions(db, "run-no-rejections", {
      runsDir,
      force: true,
    });

    expect(result.status).toBe("synced");
    expect(
      existsSync(
        join(runsDir, "run-no-rejections", "knowledge-decisions.yaml"),
      ),
    ).toBe(false);
    const tracked = db
      .prepare(
        `SELECT count(*) AS n FROM exported_files
         WHERE scope_type = 'knowledge_decisions'
           AND scope_id = 'run-no-rejections'`,
      )
      .get() as { n: number };
    expect(tracked.n).toBe(0);
    db.close();
  });
});
