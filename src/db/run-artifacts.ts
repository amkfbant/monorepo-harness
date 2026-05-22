import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
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

/**
 * Recursively yield every regular file under `dir`, keyed by a POSIX-style
 * path relative to the run dir. Dotfiles (the transient `.exporting`
 * marker, atomic-write temp files) and symlinks are skipped at every level
 * — a symlink artifact is never followed into the blob store.
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
 */
export function ingestRunArtifacts(
  db: Database.Database,
  runDir: string,
  runId: string,
): void {
  const insert = db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
       content_type, bytes, sha256, storage, blob_sha256, body_status,
       created_at, redacted, secret_suspect)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'db', ?, ?, ?, 0, 0)`,
  );
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(runId);
    for (const { rel, abs } of walkRunArtifacts(runDir)) {
      const raw = readFileSync(abs);
      const st = statSync(abs);
      let blobSha: string | null = null;
      let bodyStatus = "db_available";
      let bytes = raw.length;
      if (!DB_RECONSTRUCTED.has(rel)) {
        const blob = storeArtifactBlob(db, raw);
        blobSha = blob.sha256;
        bytes = blob.bytes;
        if (blob.truncated) bodyStatus = "truncated";
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
      );
    }
  });
  txn();
}
