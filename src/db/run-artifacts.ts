import {
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { sha256 } from "./import/common.js";
import { storeArtifactBlob } from "./artifact-blobs.js";

/**
 * Run artifact manifest (Phase 7-4).
 *
 * The `artifacts` table is a manifest only — `storage='file'`, the bodies
 * stay file-backed in `runs/<runId>/`. Both the file importer and a
 * DB-first run's finalize step record the manifest by scanning the run
 * directory, so the scan lives here and is shared.
 */

/** Artifact kind keyed by the run-dir filename. */
const ARTIFACT_KINDS: Record<string, string> = {
  "meta.json": "meta",
  "events.jsonl": "events",
  "codex-prompt.md": "codex-prompt",
  "codex-output.log": "codex-output",
  "codex-error.log": "codex-error",
  "codex-events.jsonl": "codex-events",
  "final-diff.patch": "diff",
  "summary.md": "summary",
  "review-request.md": "review-request",
  "review-decision.yaml": "review-decision",
  "resolved-policy.yaml": "resolved-policy",
  "knowledge-candidates.yaml": "knowledge-candidates",
  "context-pack-manifest.yaml": "context-pack-manifest",
};

function contentType(name: string): string {
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".jsonl")) return "application/x-ndjson";
  if (name.endsWith(".yaml")) return "text/yaml";
  if (name.endsWith(".patch")) return "text/x-patch";
  if (name.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

/**
 * Replace the `artifacts` rows for one run with a fresh scan of its
 * directory. Dotfiles (the transient `.exporting` marker, atomic-write
 * temp files) are skipped — they are bookkeeping, not run artifacts.
 */
export function recordRunArtifacts(
  db: Database.Database,
  runDir: string,
  runId: string,
): void {
  const insert = db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
       content_type, bytes, sha256, storage, created_at, redacted,
       secret_suspect)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'file', ?, 0, 0)`,
  );
  // wrap the replace in a transaction so a mid-scan stat/read failure
  // cannot leave a partially-rebuilt manifest. better-sqlite3 nests this
  // as a SAVEPOINT when the importer already holds a transaction.
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(runId);
    for (const file of readdirSync(runDir, { withFileTypes: true })) {
      if (!file.isFile() || file.name.startsWith(".")) continue;
      const name = file.name;
      const abs = join(runDir, name);
      const st = statSync(abs);
      insert.run(
        `${runId}:${name}`,
        runId,
        ARTIFACT_KINDS[name] ?? "other",
        name,
        contentType(name),
        st.size,
        // hash the raw bytes — an artifact may be binary, where a UTF-8
        // decode would corrupt the digest.
        sha256(readFileSync(abs)),
        new Date(st.mtimeMs).toISOString(),
      );
    }
  });
  txn();
}

/**
 * Artifacts whose body is reconstructed from other DB tables (`runs`,
 * `run_events`, `review_decisions`) by `exportRun` — they get a manifest
 * row but NO `artifact_blobs` entry, so the two writers do not collide.
 * Exported so the artifact backfill (Phase 8-3) skips them too.
 */
export const DB_RECONSTRUCTED = new Set([
  "meta.json",
  "events.jsonl",
  "review-decision.yaml",
]);

export interface IngestRunArtifactsResult {
  count: number;
  totalBytes: number;
}

type ArtifactInsertStatement = Database.Statement<unknown[]>;

/**
 * Recursively yield every regular file under `dir`, keyed by a POSIX-style
 * path relative to the run dir. Dotfiles are skipped at every level: they
 * include transient `.exporting` markers, atomic-write temp files, and the
 * quarantined raw Codex JSONL stream (`.codex-events.raw.jsonl`). Raw streams
 * must never become artifact blobs; only the published `codex-events.jsonl`
 * is ingestable. Symlinks are also skipped and never followed into the blob
 * store.
 */
function* walkRunArtifacts(
  dir: string,
  base = "",
): Generator<{ rel: string; abs: string }> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // an unreadable dir must NOT be silently skipped: `ingestRunArtifacts`
    // already deleted the run's artifact rows, so swallowing this would
    // commit an empty / partial manifest. Throw so the surrounding
    // transaction rolls back and the caller surfaces a warning.
    throw new Error(
      `run artifact dir unreadable (${dir}): ${(e as Error).message}`,
    );
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = base === "" ? e.name : `${base}/${e.name}`;
    const abs = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      yield* walkRunArtifacts(abs, rel);
    } else if (e.isFile()) {
      yield { rel, abs };
    }
  }
}

function prepareDbArtifactInsert(
  db: Database.Database,
  onConflict: "insert" | "replace",
): ArtifactInsertStatement {
  const verb = onConflict === "replace" ? "INSERT OR REPLACE" : "INSERT";
  // schema v5 added original_bytes / original_sha256 — only set when the
  // body was truncated to `HARD_MAX_BYTES`, NULL otherwise (Phase 9-9).
  return db.prepare(
    `${verb} INTO artifacts (artifact_id, run_id, kind, relative_path,
       content_type, bytes, sha256, storage, blob_sha256, body_status,
       created_at, redacted, secret_suspect,
       original_bytes, original_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'db', ?, ?, ?, 0, 0, ?, ?)`,
  );
}

function ingestRunArtifactFile(
  db: Database.Database,
  insert: ArtifactInsertStatement,
  runId: string,
  rel: string,
  abs: string,
): IngestRunArtifactsResult {
  const raw = readFileSync(abs);
  const st = statSync(abs);
  let blobSha: string | null = null;
  let bodyStatus = "db_available";
  let bytes = raw.length;
  let originalBytes: number | null = null;
  let originalSha: string | null = null;
  let count = 0;
  let totalBytes = 0;
  if (!DB_RECONSTRUCTED.has(rel)) {
    const blob = storeArtifactBlob(db, raw);
    blobSha = blob.sha256;
    bytes = blob.bytes;
    count = 1;
    totalBytes = raw.length;
    if (blob.truncated) {
      bodyStatus = "truncated";
      originalBytes = raw.length;
      originalSha = sha256(raw);
    }
  }
  insert.run(
    `${runId}:${rel}`,
    runId,
    ARTIFACT_KINDS[rel] ?? "other",
    rel,
    contentType(rel),
    bytes,
    sha256(raw),
    blobSha,
    bodyStatus,
    new Date(st.mtimeMs).toISOString(),
    originalBytes,
    originalSha,
  );
  return { count, totalBytes };
}

function isIngestableRelPath(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\")) return false;
  const parts = rel.split("/");
  return parts.every(
    (part) =>
      part !== "" &&
      part !== "." &&
      part !== ".." &&
      !part.startsWith("."),
  );
}

/**
 * Ingest a DB-first run's artifact bodies into the DB (Phase 8-2).
 *
 * Like `recordRunArtifacts` it replaces the run's `artifacts` rows from a
 * directory scan, but it also stores each artifact *body* in
 * `artifact_blobs` (content-addressed, chunked) and marks the manifest
 * `storage='db'`. After this the DB holds the canonical body and the
 * run-dir files are a compatibility export.
 *
 * The scan recurses into subdirectories (`commands/` / `review-evaluations/`
 * etc.) so nested artifact bodies are DB-canonical too — `relative_path`
 * holds the POSIX-style path relative to the run dir (Phase 8 — external
 * review P1-3).
 *
 * `meta.json` / `events.jsonl` / `review-decision.yaml` are skipped for
 * blob storage — their body is reconstructed by `exportRun` from the
 * canonical `runs` / `run_events` / `review_decisions` rows.
 *
 * Manifest rebuild semantics depend on the run's `source_mode` (#272 audit
 * fidelity):
 *   - file-first / unknown: the run dir IS the source of truth, so the manifest
 *     is fully rebuilt from disk (delete-all → rescan). Stale rows are pruned.
 *   - db-first: the run dir is EPHEMERAL SCRATCH and the DB is canonical. A
 *     recoverable DB-canonical row (`storage='db'` with a present blob body)
 *     whose scratch file is INTENTIONALLY absent (e.g. quarantined by #272's
 *     `quarantinePriorReviewerVerdictArtifacts`) must NOT be deleted just
 *     because it is not on disk — that would lose the audit transcript. So in
 *     db-first mode only rows that will be re-scanned from disk, or that are not
 *     recoverable, are deleted, and the rescan upserts (INSERT OR REPLACE).
 */
export function ingestRunArtifacts(
  db: Database.Database,
  runDir: string,
  runId: string,
): IngestRunArtifactsResult {
  const sourceRow = db
    .prepare("SELECT source_mode FROM runs WHERE run_id = ?")
    .get(runId) as { source_mode: string } | undefined;
  const dbFirst = sourceRow?.source_mode === "db-first";
  const insert = prepareDbArtifactInsert(db, dbFirst ? "replace" : "insert");
  const txn = db.transaction((): IngestRunArtifactsResult => {
    const onDisk = [...walkRunArtifacts(runDir)];
    if (dbFirst) {
      // Preserve recoverable DB-canonical rows whose scratch file is absent;
      // delete rows about to be re-scanned (refreshed) or that are not
      // recoverable so they cannot strand. The recoverability key is a present
      // blob body, regardless of storage tier — both `storage='db'` and
      // `storage='external'` (after `db migrate-blobs`) are DB-canonical and
      // rebuilt by `exportRun`, so neither may be pruned merely because its
      // intentionally-quarantined scratch file is absent. Only bodyless rows
      // (`blob_sha256 IS NULL`, e.g. file-backed) and on-disk-refreshed rows
      // are deleted.
      const placeholders = onDisk.map(() => "?").join(", ");
      const onDiskFilter =
        onDisk.length > 0 ? `relative_path IN (${placeholders})` : "0";
      db.prepare(
        `DELETE FROM artifacts
          WHERE run_id = ?
            AND (${onDiskFilter}
                 OR storage NOT IN ('db', 'external')
                 OR blob_sha256 IS NULL)`,
      ).run(runId, ...onDisk.map((a) => a.rel));
    } else {
      db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(runId);
    }
    let count = 0;
    let totalBytes = 0;
    for (const { rel, abs } of onDisk) {
      const result = ingestRunArtifactFile(db, insert, runId, rel, abs);
      count += result.count;
      totalBytes += result.totalBytes;
    }
    return { count, totalBytes };
  });
  return txn();
}

/**
 * Upsert only selected artifact bodies for a DB-first run without rebuilding
 * the run's manifest. This is used after reviewer-agent gate failures, where
 * the runDir may contain untrusted tampered bytes and existing DB-canonical
 * artifacts must not be touched.
 */
export function ingestRunArtifactPaths(
  db: Database.Database,
  runDir: string,
  runId: string,
  relPaths: readonly string[],
): IngestRunArtifactsResult {
  const insert = prepareDbArtifactInsert(db, "replace");
  const txn = db.transaction((): IngestRunArtifactsResult => {
    let count = 0;
    let totalBytes = 0;
    for (const rel of relPaths) {
      if (!isIngestableRelPath(rel)) continue;
      const abs = join(runDir, rel);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw e;
      }
      if (!st.isFile()) continue;
      const result = ingestRunArtifactFile(db, insert, runId, rel, abs);
      count += result.count;
      totalBytes += result.totalBytes;
    }
    return { count, totalBytes };
  });
  return txn();
}
