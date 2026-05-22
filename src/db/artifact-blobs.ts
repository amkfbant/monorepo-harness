import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { sha256 } from "./import/common.js";

/**
 * Artifact body blob storage (Phase 8-2).
 *
 * A run's artifact bodies (codex logs, diffs, summaries) were file-backed
 * through Phase 7. Phase 8 stores them in the DB so a run can be operated
 * without files. Bodies are **content-addressed** by the sha256 of their
 * raw bytes (so identical bodies across runs dedup), chunked into
 * `artifact_blob_chunks` (large codex logs), and optionally gzip-compressed.
 *
 * A body larger than `HARD_MAX_BYTES` is **truncated** and stored
 * truncated — it is never left file-canonical, since that would break
 * DB-only operation. The `artifacts` row records `body_status='truncated'`.
 */

/** Chunk size for `artifact_blob_chunks` rows. */
export const CHUNK_BYTES = 256 * 1024;
/** Bodies at or above this size are gzip-compressed when it helps. */
export const GZIP_MIN_BYTES = 4 * 1024;
/** Bodies larger than this are truncated (never escape to a file). */
export const HARD_MAX_BYTES = 16 * 1024 * 1024;

export interface StoredBlob {
  /** sha256 of the RAW artifact bytes — the content address. */
  sha256: string;
  /** RAW byte length (before truncation / compression). */
  bytes: number;
  /** true when the body exceeded `HARD_MAX_BYTES` and was stored truncated. */
  truncated: boolean;
}

/**
 * Store an artifact body in `artifact_blobs` / `artifact_blob_chunks` and
 * return its content address. Idempotent: a body whose sha256 is already
 * stored is not re-written (dedup).
 */
export function storeArtifactBlob(
  db: Database.Database,
  raw: Buffer,
): StoredBlob {
  const rawSha = sha256(raw);
  const rawBytes = raw.length;

  let truncated = false;
  let body = raw;
  if (rawBytes > HARD_MAX_BYTES) {
    body = raw.subarray(0, HARD_MAX_BYTES);
    truncated = true;
  }

  let encoding = "identity";
  let stored = body;
  if (body.length >= GZIP_MIN_BYTES) {
    const gz = gzipSync(body);
    if (gz.length < body.length) {
      encoding = "gzip";
      stored = gz;
    }
  }

  const already = db
    .prepare("SELECT 1 FROM artifact_blobs WHERE sha256 = ?")
    .get(rawSha);
  if (already === undefined) {
    const chunks: Buffer[] = [];
    for (let i = 0; i < stored.length; i += CHUNK_BYTES) {
      chunks.push(stored.subarray(i, i + CHUNK_BYTES));
    }
    // an empty body still gets one (empty) chunk so `chunk_count` is exact.
    if (chunks.length === 0) chunks.push(Buffer.alloc(0));
    const txn = db.transaction(() => {
      db.prepare(
        `INSERT INTO artifact_blobs (sha256, bytes, content_encoding,
           stored_bytes, chunk_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        rawSha,
        rawBytes,
        encoding,
        stored.length,
        chunks.length,
        new Date().toISOString(),
      );
      const insChunk = db.prepare(
        `INSERT INTO artifact_blob_chunks (sha256, chunk_index, content)
         VALUES (?, ?, ?)`,
      );
      chunks.forEach((c, i) => insChunk.run(rawSha, i, c));
    });
    txn();
  }
  return { sha256: rawSha, bytes: rawBytes, truncated };
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
      "SELECT content_encoding FROM artifact_blobs WHERE sha256 = ?",
    )
    .get(blobSha256) as { content_encoding: string } | undefined;
  if (meta === undefined) return null;
  const rows = db
    .prepare(
      "SELECT content FROM artifact_blob_chunks WHERE sha256 = ? ORDER BY chunk_index",
    )
    .all(blobSha256) as { content: Buffer }[];
  const stored = Buffer.concat(rows.map((r) => r.content));
  return meta.content_encoding === "gzip" ? gunzipSync(stored) : stored;
}
