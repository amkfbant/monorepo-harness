import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { openDbReadonly } from "../db/connection.js";
import { openManagedDb } from "../db/managed-connection.js";
import { readArtifactBlob } from "../db/artifact-blobs.js";
import { findBlobStore } from "../db/blob-stores.js";
import { reconstructRunArtifactBodyFromDb } from "../db/run-reconstruction.js";
import { LocalBlobStore } from "../storage/local-blob-store.js";
import type { RunMeta } from "../logging/run-log.js";

/**
 * DB-backed run reader (Phase 8-12).
 *
 * With file export optional (Phase 8-5), a db-first run's `meta.json` /
 * `events.jsonl` / artifact files may be absent — either because export
 * was OFF or because `cleanup` removed the run dir. The read-only viewers
 * (`run show` / `timeline` / `artifacts`) fall back to these helpers so a
 * DB-only run is still inspectable. A `runs` row that lacks `meta_json`
 * (a legacy-file run) is left to the file path — its file is canonical.
 */

/** The full `meta.json` document of a db-first run, or null. */
export function readRunMetaFromDb(
  dbPath: string,
  runId: string,
): RunMeta | null {
  if (!existsSync(dbPath)) return null;
  const dbHandle = openManagedDb({ dbPath, readonly: true });
  const db = dbHandle.db;
  try {
    const row = db
      .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
      .get(runId) as { meta_json: string | null } | undefined;
    // no row, or a legacy-file run with no stored document — the file is
    // canonical for those, so the file path handles them.
    if (row === undefined) return readRunMetaFromArchives(db, runId);
    if (row.meta_json === null) return null;
    try {
      return JSON.parse(row.meta_json) as RunMeta;
    } catch {
      return null;
    }
  } finally {
    dbHandle.close();
  }
}

/**
 * A db-first run's lifecycle events, each the parsed `events.jsonl` line
 * (the importer / run log store the full event object in `payload_json`).
 * Returns null when the DB has no such run.
 */
export function readRunEventsFromDb(
  dbPath: string,
  runId: string,
): Record<string, unknown>[] | null {
  if (!existsSync(dbPath)) return null;
  const dbHandle = openManagedDb({ dbPath, readonly: true });
  const db = dbHandle.db;
  try {
    const present = db
      .prepare("SELECT 1 FROM runs WHERE run_id = ?")
      .get(runId);
    if (present === undefined) return readRunEventsFromArchives(db, runId);
    const rows = db
      .prepare(
        "SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq",
      )
      .all(runId) as { payload_json: string }[];
    const events: Record<string, unknown>[] = [];
    for (const r of rows) {
      try {
        events.push(JSON.parse(r.payload_json) as Record<string, unknown>);
      } catch {
        // a corrupt payload is skipped, mirroring the file timeline reader
      }
    }
    return events;
  } finally {
    dbHandle.close();
  }
}

/**
 * Resolve a run's `source_mode` + `export_status` so callers can decide
 * whether to prefer the DB over the file (Phase 9 post-close P1-1 fix).
 *
 * Returns null when the DB does not exist or the run is not in it — the
 * caller then falls back to its existing file-first behavior.
 */
export function readRunSourceModeFromDb(
  dbPath: string,
  runId: string,
): { sourceMode: string; exportStatus: string | null } | null {
  if (!existsSync(dbPath)) return null;
  const dbHandle = openManagedDb({ dbPath, readonly: true });
  const db = dbHandle.db;
  try {
    const row = db
      .prepare(
        "SELECT source_mode, export_status FROM runs WHERE run_id = ?",
      )
      .get(runId) as
      | { source_mode: string; export_status: string | null }
      | undefined;
    if (row === undefined) {
      return readRunSourceModeFromArchives(db, runId);
    }
    return {
      sourceMode: row.source_mode,
      exportStatus: row.export_status,
    };
  } finally {
    dbHandle.close();
  }
}

/** Artifact relative paths recorded for a run, or null when not in the DB. */
export function listRunArtifactsFromDb(
  dbPath: string,
  runId: string,
): string[] | null {
  if (!existsSync(dbPath)) return null;
  const dbHandle = openManagedDb({ dbPath, readonly: true });
  const db = dbHandle.db;
  try {
    const present = db
      .prepare("SELECT 1 FROM runs WHERE run_id = ?")
      .get(runId);
    if (present === undefined) return listRunArtifactsFromArchives(db, runId);
    const rows = db
      .prepare(
        `SELECT relative_path, kind FROM artifacts
         WHERE run_id = ? ORDER BY relative_path`,
      )
      .all(runId) as { relative_path: string | null; kind: string }[];
    return rows.map((r) => r.relative_path ?? `(${r.kind})`);
  } finally {
    dbHandle.close();
  }
}

export type ArtifactBodySelector =
  | { kind: "name"; value: string }
  | { kind: "artifactId"; value: string };

export interface RunArtifactBodyFromDb {
  artifactId: string;
  relativePath: string | null;
  body: Buffer;
  bodyStatus: string | null;
  storage: string;
}

export type RunArtifactBodyDbResult =
  | { status: "ok"; artifact: RunArtifactBodyFromDb }
  | { status: "run_not_found" }
  | { status: "artifact_not_found" }
  | { status: "file_backed"; artifactId: string; relativePath: string | null }
  | {
      status: "body_unavailable";
      reason:
        | "redacted"
        | "secret_suspect"
        | "quarantined"
        | "unsupported_storage"
        | "blob_missing"
        | "missing_blob_reference";
      artifactId: string;
      relativePath: string | null;
    };

/** Full body for one DB-canonical artifact, including attached archives. */
export function readRunArtifactBodyFromDb(
  dbPath: string,
  runId: string,
  selector: ArtifactBodySelector,
): RunArtifactBodyDbResult | null {
  if (!existsSync(dbPath)) return null;
  const dbHandle = openManagedDb({ dbPath, readonly: true });
  const db = dbHandle.db;
  try {
    const result = readArtifactBodyFromSingleDb(db, runId, selector);
    if (result.status !== "run_not_found") return result;
    const archived = withArchives(db, (archiveDb) => {
      const archiveResult = readArtifactBodyFromSingleDb(
        archiveDb,
        runId,
        selector,
      );
      return archiveResult.status === "run_not_found" ? null : archiveResult;
    });
    return archived ?? result;
  } finally {
    dbHandle.close();
  }
}

function attachedArchivePaths(db: Database.Database): string[] {
  const present = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_catalog'",
    )
    .get();
  if (present === undefined) return [];
  const rows = db
    .prepare(
      `SELECT path FROM archive_catalog
        WHERE status = 'attached'
        ORDER BY created_at DESC`,
    )
    .all() as { path: string }[];
  return rows.map((r) => r.path).filter((p) => existsSync(p));
}

function withArchives<T>(
  mainDb: Database.Database,
  read: (archiveDb: Database.Database) => T | null,
): T | null {
  for (const path of attachedArchivePaths(mainDb)) {
    const archiveDb = openDbReadonly(path);
    try {
      const result = read(archiveDb);
      if (result !== null) return result;
    } finally {
      archiveDb.close();
    }
  }
  return null;
}

function readRunMetaFromArchives(
  mainDb: Database.Database,
  runId: string,
): RunMeta | null {
  return withArchives(mainDb, (db) => {
    const row = db
      .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
      .get(runId) as { meta_json: string | null } | undefined;
    if (row === undefined || row.meta_json === null) return null;
    try {
      return JSON.parse(row.meta_json) as RunMeta;
    } catch {
      return null;
    }
  });
}

function readRunEventsFromArchives(
  mainDb: Database.Database,
  runId: string,
): Record<string, unknown>[] | null {
  return withArchives(mainDb, (db) => {
    const present = db
      .prepare("SELECT 1 FROM runs WHERE run_id = ?")
      .get(runId);
    if (present === undefined) return null;
    const rows = db
      .prepare(
        "SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq",
      )
      .all(runId) as { payload_json: string }[];
    const events: Record<string, unknown>[] = [];
    for (const r of rows) {
      try {
        events.push(JSON.parse(r.payload_json) as Record<string, unknown>);
      } catch {
        // skip corrupt archived event payloads, matching active DB behavior
      }
    }
    return events;
  });
}

function readRunSourceModeFromArchives(
  mainDb: Database.Database,
  runId: string,
): { sourceMode: string; exportStatus: string | null } | null {
  return withArchives(mainDb, (db) => {
    const row = db
      .prepare(
        "SELECT source_mode, export_status FROM runs WHERE run_id = ?",
      )
      .get(runId) as
      | { source_mode: string; export_status: string | null }
      | undefined;
    if (row === undefined) return null;
    return { sourceMode: row.source_mode, exportStatus: row.export_status };
  });
}

function listRunArtifactsFromArchives(
  mainDb: Database.Database,
  runId: string,
): string[] | null {
  return withArchives(mainDb, (db) => {
    const present = db
      .prepare("SELECT 1 FROM runs WHERE run_id = ?")
      .get(runId);
    if (present === undefined) return null;
    const rows = db
      .prepare(
        `SELECT relative_path, kind FROM artifacts
         WHERE run_id = ? ORDER BY relative_path`,
      )
      .all(runId) as { relative_path: string | null; kind: string }[];
    return rows.map((r) => r.relative_path ?? `(${r.kind})`);
  });
}

interface ArtifactBodyRow {
  artifact_id: string;
  relative_path: string | null;
  storage: string;
  blob_sha256: string | null;
  body_status: string | null;
  redacted: number;
  secret_suspect: number;
  quarantined: number;
}

function readArtifactBodyFromSingleDb(
  db: Database.Database,
  runId: string,
  selector: ArtifactBodySelector,
): RunArtifactBodyDbResult {
  const present = db
    .prepare("SELECT 1 FROM runs WHERE run_id = ?")
    .get(runId);
  if (present === undefined) return { status: "run_not_found" };
  if (!tableExists(db, "artifacts")) return { status: "artifact_not_found" };

  const storageExpr = artifactSelectExpr(db, "storage", "'file'");
  const blobShaExpr = artifactSelectExpr(db, "blob_sha256", "NULL");
  const bodyStatusExpr = artifactSelectExpr(db, "body_status", "NULL");
  const redactedExpr = artifactFlagSelectExpr(db, "redacted");
  const secretSuspectExpr = artifactFlagSelectExpr(db, "secret_suspect");
  const quarantinedExpr = artifactFlagSelectExpr(db, "quarantined");
  const row =
    selector.kind === "artifactId"
      ? db
          .prepare(
            `SELECT artifact_id, relative_path, ${storageExpr},
                    ${blobShaExpr}, ${bodyStatusExpr}, ${redactedExpr},
                    ${secretSuspectExpr}, ${quarantinedExpr}
               FROM artifacts
              WHERE run_id = ? AND artifact_id = ?
              LIMIT 1`,
          )
          .get(runId, selector.value)
      : db
          .prepare(
            `SELECT artifact_id, relative_path, ${storageExpr},
                    ${blobShaExpr}, ${bodyStatusExpr}, ${redactedExpr},
                    ${secretSuspectExpr}, ${quarantinedExpr}
               FROM artifacts
              WHERE run_id = ? AND relative_path = ?
              LIMIT 1`,
          )
          .get(runId, selector.value);
  const artifact = row as ArtifactBodyRow | undefined;
  if (artifact === undefined) return { status: "artifact_not_found" };

  const unavailable = (
    reason: Extract<
      RunArtifactBodyDbResult,
      { status: "body_unavailable" }
    >["reason"],
  ): RunArtifactBodyDbResult => ({
    status: "body_unavailable",
    reason,
    artifactId: artifact.artifact_id,
    relativePath: artifact.relative_path,
  });
  if (artifact.redacted === 1) return unavailable("redacted");
  if (artifact.secret_suspect === 1) return unavailable("secret_suspect");
  if (
    artifact.quarantined === 1 &&
    shouldRefuseQuarantinedArtifactBody(artifact.relative_path)
  ) {
    return unavailable("quarantined");
  }
  if (artifact.storage === "file") {
    return {
      status: "file_backed",
      artifactId: artifact.artifact_id,
      relativePath: artifact.relative_path,
    };
  }
  if (artifact.storage !== "db" && artifact.storage !== "external") {
    return unavailable("unsupported_storage");
  }
  if (artifact.blob_sha256 === null) {
    const reconstructed = reconstructRunArtifactBodyFromDb(
      db,
      runId,
      artifact.relative_path,
    );
    if (reconstructed !== null) {
      return {
        status: "ok",
        artifact: {
          artifactId: artifact.artifact_id,
          relativePath: artifact.relative_path,
          body: reconstructed,
          bodyStatus: artifact.body_status,
          storage: artifact.storage,
        },
      };
    }
    return unavailable("missing_blob_reference");
  }

  const body =
    artifact.storage === "external"
      ? readExternalArtifactBlob(db, artifact.blob_sha256)
      : readArtifactBlob(db, artifact.blob_sha256);
  if (body === null) return unavailable("blob_missing");
  return {
    status: "ok",
    artifact: {
      artifactId: artifact.artifact_id,
      relativePath: artifact.relative_path,
      body,
      bodyStatus: artifact.body_status,
      storage: artifact.storage,
    },
  };
}

function artifactSelectExpr(
  db: Database.Database,
  column: "storage" | "blob_sha256" | "body_status",
  fallbackSql: string,
): string {
  return artifactColumnExists(db, column)
    ? column
    : `${fallbackSql} AS ${column}`;
}

function artifactFlagSelectExpr(
  db: Database.Database,
  column: "redacted" | "secret_suspect" | "quarantined",
): string {
  return artifactColumnExists(db, column) ? column : `0 AS ${column}`;
}

function artifactColumnExists(
  db: Database.Database,
  column: string,
): boolean {
  const rows = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
}

function shouldRefuseQuarantinedArtifactBody(
  relativePath: string | null,
): boolean {
  if (relativePath === null) return true;
  return (
    relativePath === "review-decision.yaml" ||
    relativePath === "review-auto-error.json" ||
    relativePath === "reviewer-agent.out.log" ||
    relativePath === "reviewer-agent.err.log" ||
    relativePath === "reviewer-agent.events.jsonl" ||
    relativePath.startsWith("reviewers/") ||
    relativePath.startsWith("review-evaluations/")
  );
}

function readExternalArtifactBlob(
  db: Database.Database,
  blobSha256: string,
): Buffer | null {
  if (
    !tableExists(db, "external_artifact_blobs") ||
    !tableExists(db, "blob_stores")
  ) {
    return null;
  }
  const external = db
    .prepare(
      `SELECT sha256, store_id, uri, status
         FROM external_artifact_blobs
        WHERE sha256 = ?`,
    )
    .get(blobSha256) as
    | { sha256: string; store_id: string; uri: string; status: string }
    | undefined;
  if (external === undefined || external.status !== "available") return null;

  const storeRow = findBlobStore(db, external.store_id);
  if (storeRow === null || storeRow.storeType !== "local") return null;
  const config = parseJson<{ root?: unknown }>(storeRow.configJson, {});
  if (typeof config.root !== "string") return null;

  try {
    return new LocalBlobStore({ root: config.root }).getSync({
      sha256: blobSha256,
      uri: external.uri,
    });
  } catch {
    return null;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
