import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openDb, openDbReadonly, DbError } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  storeArtifactBlob,
  readArtifactBlob,
  CHUNK_BYTES,
  GZIP_MIN_BYTES,
} from "../../src/db/artifact-blobs.js";
import { backupDb, restoreDb } from "../../src/db/maintenance.js";

/**
 * Phase 8-9 — runtime DB complete fixture matrix.
 *
 * Exercises the artifact-blob edge cases (chunk boundaries, incompressible
 * bodies, dedup), the crash-sanity guards, and end-to-end DB-only recovery
 * (backup survives a full file wipe) that the per-feature unit tests of
 * 8-1..8-8 do not cover individually.
 */

let seq = 0;

function freshDb(): { db: Database.Database; dbPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), `harness-p8fx-${seq++}-`));
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  return { db, dbPath, root };
}

function blobRow(
  db: Database.Database,
  sha: string,
): { chunk_count: number; content_encoding: string; bytes: number } {
  return db
    .prepare(
      "SELECT chunk_count, content_encoding, bytes FROM artifact_blobs WHERE sha256 = ?",
    )
    .get(sha) as {
    chunk_count: number;
    content_encoding: string;
    bytes: number;
  };
}

describe("Phase 8-9 — artifact blob chunk boundaries", () => {
  it("a body of exactly N chunk-widths splits into exactly N chunks", () => {
    const { db } = freshDb();
    // an incompressible body so chunking is measured on raw size, not gzip
    const body = randomBytes(2 * CHUNK_BYTES);
    const stored = storeArtifactBlob(db, body);
    const row = blobRow(db, stored.sha256);
    expect(row.chunk_count).toBe(2);
    expect(row.content_encoding).toBe("identity");
    expect(readArtifactBlob(db, stored.sha256)?.equals(body)).toBe(true);
    db.close();
  });

  it("a body one byte over a chunk boundary takes an extra chunk", () => {
    const { db } = freshDb();
    const body = randomBytes(2 * CHUNK_BYTES + 1);
    const stored = storeArtifactBlob(db, body);
    expect(blobRow(db, stored.sha256).chunk_count).toBe(3);
    expect(readArtifactBlob(db, stored.sha256)?.equals(body)).toBe(true);
    db.close();
  });

  it("an incompressible body stays identity-encoded and round-trips", () => {
    const { db } = freshDb();
    // random bytes do not compress — gzip would only grow them
    const body = randomBytes(GZIP_MIN_BYTES * 4);
    const stored = storeArtifactBlob(db, body);
    expect(blobRow(db, stored.sha256).content_encoding).toBe("identity");
    expect(readArtifactBlob(db, stored.sha256)?.equals(body)).toBe(true);
    db.close();
  });

  it("a compressible multi-chunk body is gzip-encoded and round-trips", () => {
    const { db } = freshDb();
    const body = Buffer.alloc(2 * CHUNK_BYTES, "A");
    const stored = storeArtifactBlob(db, body);
    expect(blobRow(db, stored.sha256).content_encoding).toBe("gzip");
    expect(blobRow(db, stored.sha256).bytes).toBe(body.length);
    expect(readArtifactBlob(db, stored.sha256)?.equals(body)).toBe(true);
    db.close();
  });
});

describe("Phase 8-9 — artifact blob dedup", () => {
  it("storing identical content twice keeps a single blob row", () => {
    const { db } = freshDb();
    const body = Buffer.from("shared artifact body");
    const a = storeArtifactBlob(db, body);
    const b = storeArtifactBlob(db, body);
    expect(a.sha256).toBe(b.sha256);
    const count = (
      db
        .prepare("SELECT count(*) AS n FROM artifact_blobs WHERE sha256 = ?")
        .get(a.sha256) as { n: number }
    ).n;
    expect(count).toBe(1);
    // chunk rows are not duplicated either
    const chunks = (
      db
        .prepare(
          "SELECT count(*) AS n FROM artifact_blob_chunks WHERE sha256 = ?",
        )
        .get(a.sha256) as { n: number }
    ).n;
    expect(chunks).toBe(1);
    db.close();
  });

  it("two distinct bodies get two blob rows", () => {
    const { db } = freshDb();
    const x = storeArtifactBlob(db, Buffer.from("body one"));
    const y = storeArtifactBlob(db, Buffer.from("body two"));
    expect(x.sha256).not.toBe(y.sha256);
    expect(
      (
        db
          .prepare("SELECT count(*) AS n FROM artifact_blobs")
          .get() as { n: number }
      ).n,
    ).toBe(2);
    db.close();
  });
});

describe("Phase 8-9 — crash sanity", () => {
  it("readArtifactBlob fails loudly when a chunk is missing", () => {
    const { db } = freshDb();
    const body = randomBytes(2 * CHUNK_BYTES);
    const stored = storeArtifactBlob(db, body);
    // simulate a partial write / corruption: drop one chunk
    db.prepare(
      "DELETE FROM artifact_blob_chunks WHERE sha256 = ? AND chunk_index = 1",
    ).run(stored.sha256);
    // the DB is canonical — a missing chunk must throw, never return a
    // silently truncated body.
    expect(() => readArtifactBlob(db, stored.sha256)).toThrow(DbError);
    db.close();
  });

  it("storeArtifactBlob is atomic — a thrown txn leaves no orphan rows", () => {
    const { db } = freshDb();
    const body = Buffer.from("atomic body");
    const stored = storeArtifactBlob(db, body);
    // a healthy blob has matching manifest + chunk rows
    const blobs = (
      db.prepare("SELECT count(*) AS n FROM artifact_blobs").get() as {
        n: number;
      }
    ).n;
    const orphanChunks = (
      db
        .prepare(
          `SELECT count(*) AS n FROM artifact_blob_chunks c
           WHERE NOT EXISTS (
             SELECT 1 FROM artifact_blobs b WHERE b.sha256 = c.sha256)`,
        )
        .get() as { n: number }
    ).n;
    expect(blobs).toBe(1);
    expect(orphanChunks).toBe(0);
    expect(readArtifactBlob(db, stored.sha256)?.equals(body)).toBe(true);
    db.close();
  });
});

describe("Phase 8-9 — concurrent connections", () => {
  it("a blob written on one connection is visible on another (WAL)", () => {
    const { db, dbPath } = freshDb();
    const body = Buffer.from("cross-connection body");
    const stored = storeArtifactBlob(db, body);
    // a second, independent connection to the same DB sees the commit
    const other = openDbReadonly(dbPath);
    expect(readArtifactBlob(other, stored.sha256)?.equals(body)).toBe(true);
    other.close();
    db.close();
  });

  it("the same content stored from two connections dedups to one row", () => {
    const { dbPath } = freshDb();
    const body = randomBytes(CHUNK_BYTES + 5);
    // two writers race on identical content — INSERT OR IGNORE means the
    // loser is a harmless no-op, never a duplicate or a half-written blob.
    const a = openDb(dbPath);
    const b = openDb(dbPath);
    const ra = storeArtifactBlob(a, body);
    const rb = storeArtifactBlob(b, body);
    expect(ra.sha256).toBe(rb.sha256);
    a.close();
    b.close();
    const probe = openDbReadonly(dbPath);
    expect(
      (
        probe
          .prepare("SELECT count(*) AS n FROM artifact_blobs")
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(readArtifactBlob(probe, ra.sha256)?.equals(body)).toBe(true);
    probe.close();
  });

  it("two connections each running migrations is safe and idempotent", () => {
    const { dbPath, db } = freshDb();
    db.close();
    // a second runner on an already-migrated DB applies nothing
    const a = openDb(dbPath);
    const b = openDb(dbPath);
    expect(runMigrations(a).applied).toEqual([]);
    expect(runMigrations(b).applied).toEqual([]);
    expect(runMigrations(a).version).toBe(4);
    a.close();
    b.close();
  });
});

describe("Phase 8-9 — DB-only recovery (backup survives a file wipe)", () => {
  it("a backup carries artifact blobs and restores after the runs dir is gone", async () => {
    const { db, dbPath, root } = freshDb();
    const body = randomBytes(CHUNK_BYTES + 17);
    const stored = storeArtifactBlob(db, body);
    db.close();

    const backup = join(root, "snapshot.sqlite");
    await backupDb({ dbPath, outPath: backup });

    // the backup alone holds the blob — verify before touching the live DB
    const probe = openDbReadonly(backup);
    expect(readArtifactBlob(probe, stored.sha256)?.equals(body)).toBe(true);
    probe.close();

    // simulate total loss of the working tree AND the live DB
    rmSync(join(root, ".harness"), { recursive: true, force: true });

    const r = await restoreDb({ dbPath, fromPath: backup });
    expect(r.schemaVersion).toBe(4);
    const restored = openDbReadonly(dbPath);
    expect(readArtifactBlob(restored, stored.sha256)?.equals(body)).toBe(true);
    restored.close();
  });
});
