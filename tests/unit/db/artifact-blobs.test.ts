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
    expect(r.bytes).toBe(body.length); // raw length recorded
    // the stored (readable) body is capped at the hard max
    expect(readArtifactBlob(db, r.sha256)?.length).toBe(HARD_MAX_BYTES);
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

    ingestRunArtifacts(db, runDir, runId);

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
});
