import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readArtifactBlob } from "../db/artifact-blobs.js";
import {
  findBlobStore,
  findExternalBlob,
  recordExternalBlob,
  setExternalBlobStatus,
  listExternalBlobs,
  type ExternalBlobRow,
} from "../db/blob-stores.js";
import type { BlobStore } from "./blob-store.js";

/**
 * Phase 16-4 — DB ↔ external migration.
 *
 * `migrateBlobsToExternal`: read DB blobs not yet in external for the
 * target store, put to external, INSERT external_artifact_blobs row.
 * Idempotent: a sha already present in external_artifact_blobs is
 * skipped (status='available').
 *
 * Phase 16-5 verify + GC are co-located here so the migration tooling
 * has a single import.
 *
 * Note: this **does not** flip artifacts.storage to 'external' — that
 * requires the artifacts.storage CHECK to allow it (post-Phase-16
 * schema v12 work). The migration prepares the external store + DB
 * catalog so the eventual flip is a metadata-only operation.
 */

export interface BlobMigrationOptions {
  storeId: string;
  /** Skip blobs whose stored_bytes < this size (default: 0). */
  minBytes?: number;
  /** Upper bound on rows to process per call (default: 50). */
  limit?: number;
  /** Dry-run: don't upload + don't INSERT external row. */
  dryRun?: boolean;
}

export interface MigrationResult {
  jobId: string;
  direction: "db-to-external" | "external-to-db";
  storeId: string;
  candidatesCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  details: Array<{ sha256: string; status: "uploaded" | "skipped" | "failed"; error?: string }>;
}

export async function migrateBlobsToExternal(
  db: Database.Database,
  store: BlobStore,
  opts: BlobMigrationOptions,
): Promise<MigrationResult> {
  if (findBlobStore(db, opts.storeId) === null) {
    throw new Error(`unknown blob store: ${opts.storeId}`);
  }
  const minBytes = opts.minBytes ?? 0;
  const limit = opts.limit ?? 50;
  const jobId = `migr-${randomUUID()}`;
  const startedAt = new Date().toISOString();

  const candidates = db
    .prepare(
      `SELECT b.sha256, b.stored_bytes, b.content_encoding
         FROM artifact_blobs b
        WHERE b.stored_bytes >= ?
          AND NOT EXISTS (
            SELECT 1 FROM external_artifact_blobs e
            WHERE e.sha256 = b.sha256
          )
        ORDER BY b.stored_bytes DESC
        LIMIT ?`,
    )
    .all(minBytes, limit) as {
    sha256: string;
    stored_bytes: number;
    content_encoding: string;
  }[];

  const details: MigrationResult["details"] = [];
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of candidates) {
    if (opts.dryRun) {
      details.push({ sha256: c.sha256, status: "skipped" });
      skipped++;
      continue;
    }
    try {
      const body = readArtifactBlob(db, c.sha256);
      if (body === null) {
        failed++;
        details.push({
          sha256: c.sha256,
          status: "failed",
          error: "DB blob read returned null",
        });
        continue;
      }
      const put = await store.put({
        sha256: c.sha256,
        body,
        contentEncoding: "identity",
      });
      // verify via head
      const h = await store.head({ sha256: c.sha256, uri: put.uri });
      if (h === null || h.sizeBytes !== put.storedBytes) {
        failed++;
        details.push({
          sha256: c.sha256,
          status: "failed",
          error: "head verify mismatch",
        });
        continue;
      }
      recordExternalBlob(db, {
        sha256: c.sha256,
        storeId: opts.storeId,
        uri: put.uri,
        bytes: body.length,
        storedBytes: put.storedBytes,
        contentEncoding: "identity",
      });
      uploaded++;
      details.push({ sha256: c.sha256, status: "uploaded" });
    } catch (e) {
      failed++;
      details.push({
        sha256: c.sha256,
        status: "failed",
        error: (e as Error).message,
      });
    }
  }

  const completedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO blob_migration_jobs
       (job_id, direction, store_id, status, started_at, completed_at,
        input_json, result_json)
     VALUES (?, 'db-to-external', ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    opts.storeId,
    failed === 0 ? (uploaded > 0 ? "succeeded" : "skipped") : "partial",
    startedAt,
    completedAt,
    JSON.stringify({ minBytes, limit, dryRun: opts.dryRun ?? false }),
    JSON.stringify({
      candidates: candidates.length,
      uploaded,
      skipped,
      failed,
    }),
  );

  return {
    jobId,
    direction: "db-to-external",
    storeId: opts.storeId,
    candidatesCount: candidates.length,
    uploadedCount: uploaded,
    skippedCount: skipped,
    failedCount: failed,
    details,
  };
}

// ---------------------------------------------------------------------------
// Phase 16-5: verify + GC

export interface VerifyResult {
  storeId: string;
  checkedCount: number;
  okCount: number;
  missingCount: number;
  corruptCount: number;
  updated: Array<{ sha256: string; status: "available" | "missing" | "corrupt" }>;
}

export async function verifyExternalBlobs(
  db: Database.Database,
  store: BlobStore,
  opts: { storeId?: string; deep?: boolean; sample?: number } = {},
): Promise<VerifyResult> {
  // Phase 16 post-close fix (external review P2-5): the prior default
  // `{ storeId: "" }` made an opts-less call filter for `store_id = ''`,
  // which silently checked zero blobs. Treat an empty/undefined storeId
  // as "no filter — verify every external blob the DB knows about".
  const filter =
    opts.storeId !== undefined && opts.storeId !== ""
      ? { storeId: opts.storeId }
      : {};
  const rows = listExternalBlobs(db, filter);
  const sample =
    opts.sample !== undefined && opts.sample < rows.length
      ? rows.slice(0, opts.sample)
      : rows;
  let ok = 0;
  let missing = 0;
  let corrupt = 0;
  const updated: VerifyResult["updated"] = [];
  for (const r of sample) {
    try {
      const h = await store.head({ sha256: r.sha256, uri: r.uri });
      if (h === null) {
        setExternalBlobStatus(db, r.sha256, "missing");
        missing++;
        updated.push({ sha256: r.sha256, status: "missing" });
        continue;
      }
      if (h.sizeBytes !== r.storedBytes) {
        setExternalBlobStatus(db, r.sha256, "corrupt");
        corrupt++;
        updated.push({ sha256: r.sha256, status: "corrupt" });
        continue;
      }
      if (opts.deep === true) {
        await store.get({ sha256: r.sha256, uri: r.uri });
      }
      setExternalBlobStatus(db, r.sha256, "available");
      ok++;
      updated.push({ sha256: r.sha256, status: "available" });
    } catch {
      setExternalBlobStatus(db, r.sha256, "corrupt");
      corrupt++;
      updated.push({ sha256: r.sha256, status: "corrupt" });
    }
  }
  return {
    storeId: opts.storeId ?? "",
    checkedCount: sample.length,
    okCount: ok,
    missingCount: missing,
    corruptCount: corrupt,
    updated,
  };
}

export interface GcResult {
  candidates: string[];
  removed: string[];
  dryRun: boolean;
}

/**
 * GC external_artifact_blobs rows that are no longer referenced by any
 * `artifacts.blob_sha256`. dry-run default. Optionally also DELETE the
 * stored object via the BlobStore.
 */
export async function gcExternalBlobs(
  db: Database.Database,
  store: BlobStore,
  opts: { apply?: boolean; deleteObjects?: boolean; storeId?: string; sha256s?: readonly string[] } = {},
): Promise<GcResult> {
  const where = [
    `NOT EXISTS (
       SELECT 1 FROM artifacts a WHERE a.blob_sha256 = e.sha256
     )`,
  ];
  const params: unknown[] = [];
  if (opts.sha256s !== undefined) {
    if (opts.sha256s.length === 0) {
      return { candidates: [], removed: [], dryRun: !opts.apply };
    }
    where.push(`e.sha256 IN (${opts.sha256s.map(() => "?").join(", ")})`);
    params.push(...opts.sha256s);
  }
  if (opts.storeId !== undefined) {
    where.push("e.store_id = ?");
    params.push(opts.storeId);
  }
  const candidates = db
    .prepare(
      `SELECT e.sha256, e.uri FROM external_artifact_blobs e
        WHERE ${where.join(" AND ")}`,
    )
    .all(...params) as { sha256: string; uri: string }[];
  const removed: string[] = [];
  if (opts.apply === true) {
    for (const c of candidates) {
      if (opts.deleteObjects === true) {
        try {
          await store.delete(c);
        } catch {
          // best-effort
        }
      }
      db.prepare(`DELETE FROM external_artifact_blobs WHERE sha256 = ?`).run(
        c.sha256,
      );
      removed.push(c.sha256);
    }
  }
  return {
    candidates: candidates.map((c) => c.sha256),
    removed,
    dryRun: !opts.apply,
  };
}

export { type ExternalBlobRow };
