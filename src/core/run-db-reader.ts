import { existsSync } from "node:fs";
import { openDbReadonly } from "../db/connection.js";
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
  const db = openDbReadonly(dbPath);
  try {
    const row = db
      .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
      .get(runId) as { meta_json: string | null } | undefined;
    // no row, or a legacy-file run with no stored document — the file is
    // canonical for those, so the file path handles them.
    if (row === undefined || row.meta_json === null) return null;
    try {
      return JSON.parse(row.meta_json) as RunMeta;
    } catch {
      return null;
    }
  } finally {
    db.close();
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
  const db = openDbReadonly(dbPath);
  try {
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
        // a corrupt payload is skipped, mirroring the file timeline reader
      }
    }
    return events;
  } finally {
    db.close();
  }
}

/** Artifact relative paths recorded for a run, or null when not in the DB. */
export function listRunArtifactsFromDb(
  dbPath: string,
  runId: string,
): string[] | null {
  if (!existsSync(dbPath)) return null;
  const db = openDbReadonly(dbPath);
  try {
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
  } finally {
    db.close();
  }
}
