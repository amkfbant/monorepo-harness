import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  storeArtifactBlob,
  readArtifactBlob,
  CHUNK_BYTES,
  HARD_MAX_BYTES,
} from "../../../src/db/artifact-blobs.js";
import { ingestRunArtifacts } from "../../../src/db/run-artifacts.js";

/** Phase 8-2 — artifact body blob storage and DB-first ingestion. */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-blob-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function blobCount(db: Database.Database): number {
  return (
    db.prepare("SELECT count(*) AS n FROM artifact_blobs").get() as {
      n: number;
    }
  ).n;
}

describe("storeArtifactBlob / readArtifactBlob", () => {
  it("round-trips a small body (identity encoding)", () => {
    const db = freshDb();
    const body = Buffer.from("hello artifact\n");
    const r = storeArtifactBlob(db, body);
    expect(r.bytes).toBe(body.length);
    expect(r.truncated).toBe(false);
    expect(readArtifactBlob(db, r.sha256)?.equals(body)).toBe(true);
    db.close();
  });

  it("round-trips a body larger than one chunk", () => {
    const db = freshDb();
    const body = Buffer.alloc(CHUNK_BYTES * 2 + 123, 7);
    const r = storeArtifactBlob(db, body);
    const back = readArtifactBlob(db, r.sha256);
    expect(back?.length).toBe(body.length);
    expect(back?.equals(body)).toBe(true);
    db.close();
  });

  it("gzip-compresses a large compressible body and round-trips it", () => {
    const db = freshDb();
    const body = Buffer.from("x".repeat(64 * 1024)); // very compressible
    const r = storeArtifactBlob(db, body);
    const meta = db
      .prepare("SELECT content_encoding, stored_bytes FROM artifact_blobs WHERE sha256 = ?")
      .get(r.sha256) as { content_encoding: string; stored_bytes: number };
    expect(meta.content_encoding).toBe("gzip");
    expect(meta.stored_bytes).toBeLessThan(body.length);
    expect(readArtifactBlob(db, r.sha256)?.equals(body)).toBe(true);
    db.close();
  });

  it("dedups identical bodies (content-addressed)", () => {
    const db = freshDb();
    const body = Buffer.from("same content");
    const a = storeArtifactBlob(db, body);
    const b = storeArtifactBlob(db, body);
    expect(a.sha256).toBe(b.sha256);
    expect(blobCount(db)).toBe(1);
    db.close();
  });

  it("round-trips an empty body", () => {
    const db = freshDb();
    const r = storeArtifactBlob(db, Buffer.alloc(0));
    expect(r.bytes).toBe(0);
    expect(readArtifactBlob(db, r.sha256)?.length).toBe(0);
    db.close();
  });

  it("truncates a body over the hard max, never escaping to a file", () => {
    const db = freshDb();
    const body = Buffer.alloc(HARD_MAX_BYTES + 4096, 3);
    const r = storeArtifactBlob(db, body);
    expect(r.truncated).toBe(true);
    // `bytes` and the content address are of the STORED (truncated) body
    expect(r.bytes).toBe(HARD_MAX_BYTES);
    const back = readArtifactBlob(db, r.sha256);
    expect(back?.length).toBe(HARD_MAX_BYTES);
    db.close();
  });

  it("readArtifactBlob returns null for an unknown sha", () => {
    const db = freshDb();
    expect(readArtifactBlob(db, "nope")).toBeNull();
    db.close();
  });
});

describe("ingestRunArtifacts", () => {
  it("stores artifact bodies in the DB and marks the manifest storage='db'", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
    const runId = "run-x-001";
    const runDir = join(root, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "codex-output.log"), "codex ran\n");
    writeFileSync(join(runDir, "summary.md"), "# summary\n");
    writeFileSync(join(runDir, "meta.json"), '{"runId":"run-x-001"}\n');

    const result = ingestRunArtifacts(db, runDir, runId);

    const rows = db
      .prepare(
        "SELECT relative_path, storage, blob_sha256, body_status FROM artifacts WHERE run_id = ? ORDER BY relative_path",
      )
      .all(runId) as {
      relative_path: string;
      storage: string;
      blob_sha256: string | null;
      body_status: string;
    }[];
    expect(rows).toHaveLength(3);
    expect(result).toEqual({
      count: 2,
      totalBytes: "codex ran\n".length + "# summary\n".length,
    });
    for (const r of rows) expect(r.storage).toBe("db");

    // a genuine file-only artifact gets a blob
    const log = rows.find((r) => r.relative_path === "codex-output.log");
    expect(log?.blob_sha256).not.toBeNull();
    expect(log?.body_status).toBe("db_available");
    expect(
      readArtifactBlob(db, log?.blob_sha256 as string)?.toString(),
    ).toBe("codex ran\n");

    // meta.json is reconstructed by exportRun from `runs` — no blob
    const meta = rows.find((r) => r.relative_path === "meta.json");
    expect(meta?.blob_sha256).toBeNull();

    db.close();
  });

  it("records original_bytes / original_sha256 only for truncated artifacts (Phase 9-9)", async () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
    const runId = "run-x-trunc";
    const runDir = join(root, runId);
    mkdirSync(runDir, { recursive: true });
    // a normal artifact → original_* stay NULL
    writeFileSync(join(runDir, "summary.md"), "# small\n");
    // a >HARD_MAX_BYTES artifact → truncated, original_* set
    const { HARD_MAX_BYTES } = await import(
      "../../../src/db/artifact-blobs.js"
    );
    const huge = Buffer.alloc(HARD_MAX_BYTES + 1024, "Z");
    writeFileSync(join(runDir, "codex-output.log"), huge);

    ingestRunArtifacts(db, runDir, runId);

    const rows = db
      .prepare(
        `SELECT relative_path, body_status, original_bytes, original_sha256
           FROM artifacts WHERE run_id = ?`,
      )
      .all(runId) as {
      relative_path: string;
      body_status: string;
      original_bytes: number | null;
      original_sha256: string | null;
    }[];

    const summary = rows.find((r) => r.relative_path === "summary.md");
    expect(summary?.body_status).toBe("db_available");
    expect(summary?.original_bytes).toBeNull();
    expect(summary?.original_sha256).toBeNull();

    const log = rows.find((r) => r.relative_path === "codex-output.log");
    expect(log?.body_status).toBe("truncated");
    expect(log?.original_bytes).toBe(HARD_MAX_BYTES + 1024);
    expect(log?.original_sha256).not.toBeNull();
    db.close();
  });

  it("recurses into subdirectories (commands/ etc.) — nested bodies in the DB", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
    const runId = "run-x-nested";
    const runDir = join(root, runId);
    mkdirSync(join(runDir, "commands"), { recursive: true });
    writeFileSync(join(runDir, "summary.md"), "# summary\n");
    writeFileSync(join(runDir, "commands", "cmd-0.stdout.log"), "test ok\n");
    writeFileSync(join(runDir, "commands", "cmd-0.stderr.log"), "");

    ingestRunArtifacts(db, runDir, runId);

    const rows = db
      .prepare(
        "SELECT relative_path, storage, blob_sha256 FROM artifacts WHERE run_id = ?",
      )
      .all(runId) as {
      relative_path: string;
      storage: string;
      blob_sha256: string | null;
    }[];
    const paths = rows.map((r) => r.relative_path);
    // the nested command log is captured with a POSIX-style relative path
    expect(paths).toContain("commands/cmd-0.stdout.log");
    const nested = rows.find(
      (r) => r.relative_path === "commands/cmd-0.stdout.log",
    );
    expect(nested?.storage).toBe("db");
    expect(nested?.blob_sha256).not.toBeNull();
    expect(
      readArtifactBlob(db, nested?.blob_sha256 as string)?.toString(),
    ).toBe("test ok\n");
    db.close();
  });

  it("skips quarantined codex event dotfiles during artifact ingest", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
    const runId = "run-x-dotfiles";
    const runDir = join(root, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, ".codex-events.raw.jsonl"), "raw secret\n");
    writeFileSync(join(runDir, ".codex-events.redacted.tmp"), "tmp\n");
    writeFileSync(
      join(runDir, "codex-events.jsonl"),
      `${JSON.stringify({ type: "turn.completed" })}\n`,
    );

    ingestRunArtifacts(db, runDir, runId);

    const paths = (
      db
        .prepare(
          "SELECT relative_path FROM artifacts WHERE run_id = ? ORDER BY relative_path",
        )
        .all(runId) as { relative_path: string }[]
    ).map((r) => r.relative_path);
    expect(paths).toEqual(["codex-events.jsonl"]);
    db.close();
  });

  it("replaces the run's artifacts on re-ingest", () => {
    const db = freshDb();
    const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
    const runId = "run-x-002";
    const runDir = join(root, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "summary.md"), "v1\n");
    ingestRunArtifacts(db, runDir, runId);
    writeFileSync(join(runDir, "summary.md"), "v2\n");
    ingestRunArtifacts(db, runDir, runId);
    const count = (
      db
        .prepare("SELECT count(*) AS n FROM artifacts WHERE run_id = ?")
        .get(runId) as { n: number }
    ).n;
    expect(count).toBe(1);
    db.close();
  });

  /**
   * #303 — db-first absent-recoverable retention: the full sync preserves an
   * absent recoverable row ONLY when it carries the `quarantined` marker (set by
   * `quarantinePriorReviewerVerdictArtifacts`). A non-quarantined absent
   * recoverable row (e.g. a `review-auto-error.json` that a successful retry
   * removed) is PRUNED. File-first behavior is byte-identical (full
   * delete-then-rescan), regardless of the marker.
   */
  describe("#303 db-first absent-recoverable retention", () => {
    function seedDbFirstRun(db: Database.Database, runId: string): void {
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at)
         VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
           'db-first', 1, 'disabled', '2026-05-23T00:00:00Z')`,
      ).run(runId);
    }
    function seedAbsentRecoverableRow(
      db: Database.Database,
      runId: string,
      rel: string,
      quarantined: 0 | 1,
    ): void {
      const blob = storeArtifactBlob(db, Buffer.from(`body of ${rel}\n`));
      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
           content_type, bytes, sha256, storage, blob_sha256, body_status,
           quarantined)
         VALUES (?, ?, 'other', ?, 'application/json', ?, ?, 'db', ?,
           'db_available', ?)`,
      ).run(`${runId}:${rel}`, runId, rel, blob.bytes, blob.sha256, blob.sha256, quarantined);
    }

    it("prunes a NON-quarantined absent recoverable row (stale review-auto-error.json)", () => {
      const db = freshDb();
      const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
      const runId = "run-x-303-prune";
      const runDir = join(root, runId);
      mkdirSync(runDir, { recursive: true });
      seedDbFirstRun(db, runId);
      // ingested-then-superseded on disk: row present, file absent, NOT quarantined
      seedAbsentRecoverableRow(
        db,
        runId,
        "reviewers/codex-reviewer/review-auto-error.json",
        0,
      );
      // an actually-on-disk artifact so the rescan has content
      writeFileSync(join(runDir, "summary.md"), "ok\n");

      ingestRunArtifacts(db, runDir, runId);

      const row = db
        .prepare(
          "SELECT 1 AS n FROM artifacts WHERE run_id = ? AND relative_path = ?",
        )
        .get(runId, "reviewers/codex-reviewer/review-auto-error.json");
      expect(row).toBeUndefined();
      db.close();
    });

    it("preserves a quarantined (marked) absent recoverable row (#272 non-regression)", () => {
      const db = freshDb();
      const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
      const runId = "run-x-303-keep";
      const runDir = join(root, runId);
      mkdirSync(runDir, { recursive: true });
      seedDbFirstRun(db, runId);
      seedAbsentRecoverableRow(
        db,
        runId,
        "reviewers/alice/reviewer-agent.out.log",
        1,
      );
      writeFileSync(join(runDir, "summary.md"), "ok\n");

      ingestRunArtifacts(db, runDir, runId);

      const row = db
        .prepare(
          `SELECT quarantined, blob_sha256 FROM artifacts
            WHERE run_id = ? AND relative_path = ?`,
        )
        .get(runId, "reviewers/alice/reviewer-agent.out.log") as
        | { quarantined: number; blob_sha256: string | null }
        | undefined;
      expect(row?.quarantined).toBe(1);
      expect(row?.blob_sha256).not.toBeNull();
      db.close();
    });

    it("re-ingest from disk clears the quarantined marker (the file is authoritative again)", () => {
      const db = freshDb();
      const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
      const runId = "run-x-303-reappear";
      const runDir = join(root, runId);
      const rel = "reviewers/alice/reviewer-agent.out.log";
      mkdirSync(join(runDir, "reviewers", "alice"), { recursive: true });
      seedDbFirstRun(db, runId);
      seedAbsentRecoverableRow(db, runId, rel, 1);
      // the same path reappears on disk → it is re-scanned and re-ingested fresh
      writeFileSync(join(runDir, rel), "fresh on-disk body\n");

      ingestRunArtifacts(db, runDir, runId);

      const row = db
        .prepare(
          `SELECT quarantined FROM artifacts
            WHERE run_id = ? AND relative_path = ?`,
        )
        .get(runId, rel) as { quarantined: number } | undefined;
      expect(row?.quarantined).toBe(0);
      db.close();
    });

    it("file-first sync is byte-identical: full delete-then-rescan ignores the marker", () => {
      const db = freshDb();
      const root = mkdtempSync(join(tmpdir(), "harness-ingest-"));
      const runId = "run-x-303-ff";
      const runDir = join(root, runId);
      mkdirSync(runDir, { recursive: true });
      // NO db-first run row → file-first branch (delete-all → rescan).
      // even a "quarantined"-marked absent recoverable row is pruned, because
      // file-first treats the run dir as the sole source of truth.
      seedAbsentRecoverableRow(
        db,
        runId,
        "reviewers/alice/reviewer-agent.out.log",
        1,
      );
      writeFileSync(join(runDir, "summary.md"), "ok\n");

      ingestRunArtifacts(db, runDir, runId);

      const rows = db
        .prepare(
          "SELECT relative_path FROM artifacts WHERE run_id = ? ORDER BY relative_path",
        )
        .all(runId) as { relative_path: string }[];
      expect(rows.map((r) => r.relative_path)).toEqual(["summary.md"]);
      db.close();
    });
  });
});
