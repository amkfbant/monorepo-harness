import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDb, DbError } from "../db/connection.js";
import { exportRun } from "../db/export-files.js";
import { ingestRunArtifacts } from "../db/run-artifacts.js";

/**
 * Run materialization helpers (Phase 8-13).
 *
 * With file export optional (Phase 8-5) a db-first run may have no run
 * dir. Commands that genuinely need the run's files on disk — the
 * reviewer agent spawns codex with a read-only sandbox over the run dir —
 * materialize them from the DB first, and sync any artifacts they then
 * add back into the DB so those bodies stay DB-canonical.
 */

/**
 * Restore a db-first run's files from the DB when they are absent.
 * A no-op when the files already exist or the run is not in the DB.
 * Returns true when files were written.
 */
export function ensureRunMaterialized(opts: {
  dbPath: string;
  runsDir: string;
  runId: string;
}): boolean {
  if (!existsSync(opts.dbPath)) return false;
  if (existsSync(join(opts.runsDir, opts.runId, "meta.json"))) return false;
  const db = openDb(opts.dbPath);
  try {
    // force: materialize even with file export OFF — the caller needs
    // the files regardless of the export setting.
    exportRun(db, opts.runId, { runsDir: opts.runsDir, force: true });
    return true;
  } catch (e) {
    // the run is simply not in the DB — let the caller's own
    // "run not found" path report it.
    if (e instanceof DbError) return false;
    throw e;
  } finally {
    db.close();
  }
}

/**
 * Re-ingest a db-first run's artifact bodies into the DB after a later
 * command (review auto / reviewed-run) added artifacts to the run dir, so
 * the new bodies are DB-canonical and survive a backup / file wipe.
 *
 * Only db-first runs are synced — a legacy-file run's artifacts stay
 * `storage='file'` (its files are canonical).
 */
export function syncRunArtifactsToDb(opts: {
  dbPath: string;
  runsDir: string;
  runId: string;
}): void {
  if (!existsSync(opts.dbPath)) return;
  const runDir = join(opts.runsDir, opts.runId);
  if (!existsSync(runDir)) return;
  const db = openDb(opts.dbPath);
  try {
    const row = db
      .prepare("SELECT source_mode FROM runs WHERE run_id = ?")
      .get(opts.runId) as { source_mode: string } | undefined;
    if (row === undefined || row.source_mode !== "db-first") return;
    ingestRunArtifacts(db, runDir, opts.runId);
  } finally {
    db.close();
  }
}
