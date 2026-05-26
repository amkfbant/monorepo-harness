import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { openDbReadonly } from "../db/connection.js";
import { openManagedDb } from "../db/managed-connection.js";
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
