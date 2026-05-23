import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { DbError } from "./connection.js";
import { sha256 } from "./import/common.js";

/**
 * Artifact body blob storage (Phase 8-2).
 *
 * A run's artifact bodies (codex logs, diffs, summaries) were file-backed
 * through Phase 7. Phase 8 stores them in the DB so a run can be operated
 * without files. Bodies are **content-addressed** by the sha256 of their
 * STORED form — the bytes after truncation (over `HARD_MAX_BYTES`) and
 * before compression — so the address always matches exactly what
 * `readArtifactBlob` returns and identical bodies across runs dedup.
 * Bodies are chunked into `artifact_blob_chunks` (large codex logs) and
 * optionally gzip-compressed.
 *
 * A body larger than `HARD_MAX_BYTES` is **truncated** and stored
 * truncated — it is never left file-canonical, since that would break
 * DB-only operation. The `artifacts` row records `body_status='truncated'`,
 * and Phase 9 additionally records `original_bytes` / `original_sha256`
 * on truncation so a future refetch can decide whether to recover the
 * dropped tail bytes.
 */

/** Chunk size for `artifact_blob_chunks` rows. */
export const CHUNK_BYTES = 256 * 1024;
/** Bodies at or above this size are gzip-compressed when it helps. */
export const GZIP_MIN_BYTES = 4 * 1024;
/** Bodies larger than this are truncated (never escape to a file). */
export const HARD_MAX_BYTES = 16 * 1024 * 1024;

export interface StoredBlob {
  /**
   * sha256 of the STORED body — the content the blob holds (after
   * truncation, before compression). `readArtifactBlob` returns exactly
   * the bytes whose sha256 is this, so the address always matches the
   * readable body.
   */
  sha256: string;
  /** stored body byte length (after truncation, before compression). */
  bytes: number;
  /** true when the body exceeded `HARD_MAX_BYTES` and was stored truncated. */
  truncated: boolean;
}

/**
 * Store an artifact body in `artifact_blobs` / `artifact_blob_chunks` and
 * return its content address. Idempotent and race-safe: a body whose
 * sha256 is already stored is not re-written (`INSERT OR IGNORE`).
 */
export function storeArtifactBlob(
  db: Database.Database,
  raw: Buffer,
): StoredBlob {
  let truncated = false;
  let body = raw;
  if (raw.length > HARD_MAX_BYTES) {
    body = raw.subarray(0, HARD_MAX_BYTES);
    truncated = true;
  }
  // content-address by the STORED body, so `blob_sha256` is always the
  // sha256 of what `readArtifactBlob` returns (truncated bodies included).
  const sha = sha256(body);

  let encoding = "identity";
  let stored = body;
  if (body.length >= GZIP_MIN_BYTES) {
    const gz = gzipSync(body);
    if (gz.length < body.length) {
      encoding = "gzip";
      stored = gz;
    }
  }

  const chunks: Buffer[] = [];
  for (let i = 0; i < stored.length; i += CHUNK_BYTES) {
    chunks.push(stored.subarray(i, i + CHUNK_BYTES));
  }
  // an empty body still gets one (empty) chunk so `chunk_count` is exact.
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));

  const txn = db.transaction(() => {
    // `INSERT OR IGNORE` — a concurrent writer storing the same content
    // wins harmlessly; only the winner writes the chunks.
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO artifact_blobs (sha256, bytes,
           content_encoding, stored_bytes, chunk_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha,
        body.length,
        encoding,
        stored.length,
        chunks.length,
        new Date().toISOString(),
      );
    if (info.changes > 0) {
      const insChunk = db.prepare(
        `INSERT OR IGNORE INTO artifact_blob_chunks (sha256, chunk_index,
           content)
         VALUES (?, ?, ?)`,
      );
      chunks.forEach((c, i) => insChunk.run(sha, i, c));
    }
  });
  txn();
  return { sha256: sha, bytes: body.length, truncated };
}

/**
 * Read an artifact body back from the blob store. Returns the stored
 * bytes (truncated, if the body was over `HARD_MAX_BYTES`), or null when
 * the sha256 is not stored.
 */
export function readArtifactBlob(
  db: Database.Database,
  blobSha256: string,
): Buffer | null {
  const meta = db
    .prepare(
      `SELECT content_encoding, stored_bytes, chunk_count
       FROM artifact_blobs WHERE sha256 = ?`,
    )
    .get(blobSha256) as
    | { content_encoding: string; stored_bytes: number; chunk_count: number }
    | undefined;
  if (meta === undefined) return null;
  const rows = db
    .prepare(
      `SELECT chunk_index, content FROM artifact_blob_chunks
       WHERE sha256 = ? ORDER BY chunk_index`,
    )
    .all(blobSha256) as { chunk_index: number; content: Buffer }[];
  // verify the chunk set is complete — the DB is the canonical store, so
  // a missing / non-contiguous chunk must be a loud error, not a silently
  // truncated body.
  if (rows.length !== meta.chunk_count) {
    throw new DbError(
      `artifact blob ${blobSha256}: expected ${meta.chunk_count} chunks, ` +
        `found ${rows.length}`,
    );
  }
  rows.forEach((r, i) => {
    if (r.chunk_index !== i) {
      throw new DbError(
        `artifact blob ${blobSha256}: chunk index gap at ${i}`,
      );
    }
  });
  const stored = Buffer.concat(rows.map((r) => r.content));
  if (stored.length !== meta.stored_bytes) {
    throw new DbError(
      `artifact blob ${blobSha256}: stored ${stored.length} bytes, ` +
        `expected ${meta.stored_bytes}`,
    );
  }
  return meta.content_encoding === "gzip" ? gunzipSync(stored) : stored;
}
