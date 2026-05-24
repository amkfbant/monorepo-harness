/**
 * BlobStore interface (Phase 16-2).
 *
 * Provider-agnostic content-addressed blob store. Implementations
 * (local filesystem, S3, …) keep bodies under a sha256-derived path
 * layout. The DB stores `external_artifact_blobs.uri` returned by
 * `put()` for later `get()` / `head()` / `delete()`.
 *
 * The sha256 is the **stored body** sha (after truncation, before
 * transport encoding) per Phase 8 invariant.
 */

export type ContentEncoding = "identity" | "gzip";

export interface PutInput {
  sha256: string;
  body: Buffer;
  contentEncoding: ContentEncoding;
  metadata?: Record<string, string>;
}

export interface PutResult {
  uri: string;
  storedBytes: number;
}

export interface HeadResult {
  sizeBytes: number;
}

export interface ListResult {
  sha256: string;
  uri: string;
  sizeBytes: number;
}

export interface BlobStore {
  /** Store an object content-addressed. Idempotent (same sha → same uri). */
  put(input: PutInput): Promise<PutResult>;
  /** Retrieve stored bytes. */
  get(input: { sha256: string; uri: string }): Promise<Buffer>;
  /** Existence + size check. */
  head(input: { sha256: string; uri: string }): Promise<HeadResult | null>;
  /** Remove an object. Idempotent. */
  delete(input: { sha256: string; uri: string }): Promise<void>;
  /** Iterate stored objects (used by GC). */
  list?(prefix?: string): AsyncIterable<ListResult>;
}
