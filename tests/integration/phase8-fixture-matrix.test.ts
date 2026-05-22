import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type Database from "better-sqlite3";
import { openDb, openDbReadonly, DbError } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  storeArtifactBlob,
  readArtifactBlob,
  CHUNK_BYTES,
  GZIP_MIN_BYTES,
  HARD_MAX_BYTES,
} from "../../src/db/artifact-blobs.js";
import { backupDb, restoreDb } from "../../src/db/maintenance.js";

/**
 * Phase 8-9 — runtime DB complete fixture matrix.
 *
 * Exercises the artifact-blob edge cases (chunk boundaries, incompressible
 * bodies, truncation, dedup), the crash-sanity guards, multi-process
 * concurrency, and end-to-end DB-only recovery that the per-feature unit
 * tests of 8-1..8-8 do not cover individually.
 */

let seq = 0;

function freshDb(): { db: Database.Database; dbPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), `harness-p8fx-${seq++}-`));
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  return { db, dbPath, root };
}

/**
 * A deterministic incompressible buffer of `n` bytes — a SHA-256 hash
 * chain. Deterministic (no flaky `randomBytes`) yet incompressible, so
 * tests that assert `content_encoding === 'identity'` are reproducible.
 */
function incompressible(n: number): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  let block = createHash("sha256").update("phase8-fixture-seed").digest();
  while (total < n) {
    parts.push(block);
    total += block.length;
    block = createHash("sha256").update(block).digest();
  }
  return Buffer.concat(parts).subarray(0, n);
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

/** count of chunk rows for a blob. */
function chunkCount(db: Database.Database, sha: string): number {
  return (
    db
      .prepare(
        "SELECT count(*) AS n FROM artifact_blob_chunks WHERE sha256 = ?",
      )
      .get(sha) as { n: number }
  ).n;
}

describe("Phase 8-9 — artifact blob chunk boundaries", () => {
  it("a body of exactly N chunk-widths splits into exactly N chunks", () => {
    const { db } = freshDb();
    const body = incompressible(2 * CHUNK_BYTES);
    const stored = storeArtifactBlob(db, body);
    const row = blobRow(db, stored.sha256);
    expect(row.chunk_count).toBe(2);
    expect(row.content_encoding).toBe("identity");
    expect(readArtifactBlob(db, stored.sha256)?.equals(body)).toBe(true);
    db.close();
  });

  it("a body one byte over a chunk boundary takes an extra chunk", () => {
    const { db } = freshDb();
    const body = incompressible(2 * CHUNK_BYTES + 1);
    const stored = storeArtifactBlob(db, body);
    expect(blobRow(db, stored.sha256).chunk_count).toBe(3);
    expect(readArtifactBlob(db, stored.sha256)?.equals(body)).toBe(true);
    db.close();
  });

  it("an incompressible body stays identity-encoded and round-trips", () => {
    const { db } = freshDb();
    const body = incompressible(GZIP_MIN_BYTES * 4);
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

  it("a body over the hard max is stored truncated, never escaping to a file", () => {
    const { db } = freshDb();
    const body = Buffer.alloc(HARD_MAX_BYTES + 4096, "Z");
    const stored = storeArtifactBlob(db, body);
    expect(stored.truncated).toBe(true);
    expect(stored.bytes).toBe(HARD_MAX_BYTES);
    // the readable body is exactly the truncated content the sha addresses
    const read = readArtifactBlob(db, stored.sha256);
    expect(read?.length).toBe(HARD_MAX_BYTES);
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
    expect(chunkCount(db, a.sha256)).toBe(1);
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
    const body = incompressible(2 * CHUNK_BYTES);
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

  it("every stored blob's manifest chunk_count matches its actual chunks", () => {
    const { db } = freshDb();
    // a range of sizes: empty, sub-chunk, exact boundary, multi-chunk,
    // and a gzip-compressible body — the manifest invariant readArtifactBlob
    // relies on must hold for all of them.
    const bodies = [
      Buffer.alloc(0),
      Buffer.from("small"),
      incompressible(CHUNK_BYTES),
      incompressible(2 * CHUNK_BYTES + 9),
      Buffer.alloc(3 * CHUNK_BYTES, "A"),
    ];
    for (const body of bodies) {
      const stored = storeArtifactBlob(db, body);
      expect(chunkCount(db, stored.sha256)).toBe(
        blobRow(db, stored.sha256).chunk_count,
      );
    }
    // and no chunk row exists without a manifest row backing it
    const orphans = (
      db
        .prepare(
          `SELECT count(*) AS n FROM artifact_blob_chunks c
           WHERE NOT EXISTS (
             SELECT 1 FROM artifact_blobs b WHERE b.sha256 = c.sha256)`,
        )
        .get() as { n: number }
    ).n;
    expect(orphans).toBe(0);
    db.close();
  });
});

describe("Phase 8-9 — multi-connection access", () => {
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

  it("a second runner on an already-migrated DB applies nothing", () => {
    const { dbPath, db } = freshDb();
    db.close();
    const a = openDb(dbPath);
    const b = openDb(dbPath);
    expect(runMigrations(a).applied).toEqual([]);
    expect(runMigrations(b).applied).toEqual([]);
    expect(runMigrations(a).version).toBe(4);
    a.close();
    b.close();
  });
});

describe("Phase 8-9 — concurrent processes", () => {
  /** Run the blob-write worker as a separate OS process. */
  function spawnWorker(
    dbPath: string,
    seed: string,
    count: number,
  ): Promise<number> {
    const worker = join(
      process.cwd(),
      "tests",
      "fixtures",
      "blob-write-worker.ts",
    );
    return new Promise((resolve, reject) => {
      const child = spawn(
        "node",
        ["--import", "tsx", worker, dbPath, seed, String(count)],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  }

  it("three processes contend on one DB without corruption or lost dedup", async () => {
    const { db, dbPath } = freshDb();
    db.close(); // workers open their own connections

    const perWorker = 40;
    const seeds = ["w0", "w1", "w2"];
    // genuinely parallel: three processes write the same DB at once.
    const codes = await Promise.all(
      seeds.map((s) => spawnWorker(dbPath, s, perWorker)),
    );
    expect(codes).toEqual([0, 0, 0]);

    const probe = openDbReadonly(dbPath);
    try {
      // each worker wrote `perWorker` unique blobs; all share one blob.
      const blobCount = (
        probe
          .prepare("SELECT count(*) AS n FROM artifact_blobs")
          .get() as { n: number }
      ).n;
      expect(blobCount).toBe(seeds.length * perWorker + 1);
      // the shared blob deduped to exactly one row across all processes
      const sharedSha = createHash("sha256")
        .update("shared-across-workers")
        .digest("hex");
      expect(
        readArtifactBlob(probe, sharedSha)?.toString(),
      ).toBe("shared-across-workers");
      // no chunk row was left without its manifest
      const orphans = (
        probe
          .prepare(
            `SELECT count(*) AS n FROM artifact_blob_chunks c
             WHERE NOT EXISTS (
               SELECT 1 FROM artifact_blobs b WHERE b.sha256 = c.sha256)`,
          )
          .get() as { n: number }
      ).n;
      expect(orphans).toBe(0);
    } finally {
      probe.close();
    }
  });
});

describe("Phase 8-9 — DB-only recovery (backup survives a file wipe)", () => {
  it("a backup carries artifact blobs and restores after the runs dir is gone", async () => {
    const { db, dbPath, root } = freshDb();
    const body = incompressible(CHUNK_BYTES + 17);
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
