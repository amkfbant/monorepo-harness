import type Database from "better-sqlite3";

/**
 * `blob_stores` + `external_artifact_blobs` repositories (Phase 16-3).
 *
 * blob_stores.config_json holds env var **names**, never secret
 * values (design §3.F). The repository does not enforce this — the
 * caller (CLI / setup script) must redact.
 */

export type StoreType = "local" | "s3";
export type StoreStatus = "active" | "disabled";
export type ContentEncoding = "identity" | "gzip";
export type ExternalBlobStatus = "available" | "missing" | "corrupt";

export interface BlobStoreRow {
  storeId: string;
  storeType: StoreType;
  configJson: string;
  createdAt: string;
  updatedAt: string;
  status: StoreStatus;
  metadataJson: string;
}

export interface ExternalBlobRow {
  sha256: string;
  storeId: string;
  uri: string;
  bytes: number;
  storedBytes: number;
  contentEncoding: ContentEncoding;
  chunking: string;
  uploadedAt: string;
  verifiedAt: string | null;
  status: ExternalBlobStatus;
  metadataJson: string;
}

// ---------------------------------------------------------------------------
// blob_stores

export function registerBlobStore(
  db: Database.Database,
  input: {
    storeId: string;
    storeType: StoreType;
    config: Record<string, unknown>;
    status?: StoreStatus;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
): BlobStoreRow {
  const now = (input.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO blob_stores
       (store_id, store_type, config_json, created_at, updated_at,
        status, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id) DO UPDATE SET
       store_type = excluded.store_type,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at,
       status = excluded.status,
       metadata_json = excluded.metadata_json`,
  ).run(
    input.storeId,
    input.storeType,
    JSON.stringify(input.config),
    now,
    now,
    input.status ?? "active",
    JSON.stringify(input.metadata ?? {}),
  );
  return findBlobStore(db, input.storeId) as BlobStoreRow;
}

export function findBlobStore(
  db: Database.Database,
  storeId: string,
): BlobStoreRow | null {
  const row = db
    .prepare(
      `SELECT store_id, store_type, config_json, created_at, updated_at,
              status, metadata_json
         FROM blob_stores WHERE store_id = ?`,
    )
    .get(storeId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toStoreRow(row);
}

export function listBlobStores(db: Database.Database): BlobStoreRow[] {
  const rows = db
    .prepare(
      `SELECT store_id, store_type, config_json, created_at, updated_at,
              status, metadata_json
         FROM blob_stores ORDER BY store_id`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toStoreRow);
}

function toStoreRow(r: Record<string, unknown>): BlobStoreRow {
  return {
    storeId: r.store_id as string,
    storeType: r.store_type as StoreType,
    configJson: r.config_json as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    status: r.status as StoreStatus,
    metadataJson: r.metadata_json as string,
  };
}

// ---------------------------------------------------------------------------
// external_artifact_blobs

export function recordExternalBlob(
  db: Database.Database,
  input: {
    sha256: string;
    storeId: string;
    uri: string;
    bytes: number;
    storedBytes: number;
    contentEncoding: ContentEncoding;
    chunking?: string;
    now?: Date;
  },
): ExternalBlobRow {
  const now = (input.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO external_artifact_blobs
       (sha256, store_id, uri, bytes, stored_bytes, content_encoding,
        chunking, uploaded_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available')
     ON CONFLICT(sha256) DO UPDATE SET
       store_id = excluded.store_id,
       uri = excluded.uri,
       bytes = excluded.bytes,
       stored_bytes = excluded.stored_bytes,
       content_encoding = excluded.content_encoding,
       chunking = excluded.chunking,
       uploaded_at = excluded.uploaded_at,
       status = 'available'`,
  ).run(
    input.sha256,
    input.storeId,
    input.uri,
    input.bytes,
    input.storedBytes,
    input.contentEncoding,
    input.chunking ?? "none",
    now,
  );
  return findExternalBlob(db, input.sha256) as ExternalBlobRow;
}

export function findExternalBlob(
  db: Database.Database,
  sha256: string,
): ExternalBlobRow | null {
  const row = db
    .prepare(
      `SELECT sha256, store_id, uri, bytes, stored_bytes, content_encoding,
              chunking, uploaded_at, verified_at, status, metadata_json
         FROM external_artifact_blobs WHERE sha256 = ?`,
    )
    .get(sha256) as Record<string, unknown> | undefined;
  return row === undefined ? null : toExtRow(row);
}

export function listExternalBlobs(
  db: Database.Database,
  filter: { storeId?: string; status?: ExternalBlobStatus } = {},
): ExternalBlobRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.storeId !== undefined) {
    where.push("store_id = ?");
    params.push(filter.storeId);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const sql =
    `SELECT sha256, store_id, uri, bytes, stored_bytes, content_encoding,
            chunking, uploaded_at, verified_at, status, metadata_json
       FROM external_artifact_blobs` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY uploaded_at DESC`;
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(toExtRow);
}

export function setExternalBlobStatus(
  db: Database.Database,
  sha256: string,
  status: ExternalBlobStatus,
  now: Date = new Date(),
): boolean {
  const info = db
    .prepare(
      `UPDATE external_artifact_blobs
          SET status = ?, verified_at = ?
        WHERE sha256 = ?`,
    )
    .run(status, now.toISOString(), sha256);
  return info.changes > 0;
}

function toExtRow(r: Record<string, unknown>): ExternalBlobRow {
  return {
    sha256: r.sha256 as string,
    storeId: r.store_id as string,
    uri: r.uri as string,
    bytes: r.bytes as number,
    storedBytes: r.stored_bytes as number,
    contentEncoding: r.content_encoding as ContentEncoding,
    chunking: r.chunking as string,
    uploadedAt: r.uploaded_at as string,
    verifiedAt: (r.verified_at as string | null) ?? null,
    status: r.status as ExternalBlobStatus,
    metadataJson: (r.metadata_json as string | null) ?? "{}",
  };
}
