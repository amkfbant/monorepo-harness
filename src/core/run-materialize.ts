import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DbError } from "../db/connection.js";
import { openManagedDb } from "../db/managed-connection.js";
import { exportRun } from "../db/export-files.js";
import { ingestRunArtifacts } from "../db/run-artifacts.js";
import { fileExportEnabled } from "../config/export-mode.js";
import {
  recordScratchMaterialization,
  markScratchCleaned,
  listActiveScratchForRun,
} from "../db/repositories/run-materializations.js";

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
 *
 * Phase 9 post-close (second review) P1-1 fix — this is a **scratch
 * materialization** (the reviewer agent needs the run dir on disk to
 * spawn codex over it). It must NOT be recorded as a compatibility
 * export: with export OFF the DB-only runtime semantics require
 * `runs.export_status` to stay `disabled` and `exported_files` to stay
 * empty. Passing `trackExport: false` keeps the export bookkeeping
 * untouched while still writing the files.
 */
export function ensureRunMaterialized(opts: {
  dbPath: string;
  runsDir: string;
  runId: string;
  /**
   * Phase 10-3: optional `reason` recorded in `run_materializations`
   * for audit / `db doctor` visibility. Defaults to "ensureRunMaterialized".
   */
  reason?: string;
}): boolean {
  if (!existsSync(opts.dbPath)) return false;
  if (existsSync(join(opts.runsDir, opts.runId, "meta.json"))) return false;
  const dbHandle = openManagedDb({ dbPath: opts.dbPath });
  const db = dbHandle.db;
  try {
    // force: materialize even with file export OFF — the caller needs
    // the files regardless of the export setting.
    // trackExport: false: scratch materialization is not a compatibility
    // export, so do not flip export_status / exported_files (Phase 9
    // post-close P1-1 fix).
    const result = exportRun(db, opts.runId, {
      runsDir: opts.runsDir,
      force: true,
      trackExport: false,
    });
    // `exportRun` reports a failed export (e.g. a missing blob) via its
    // return value, not an exception — fail loudly so the caller never
    // proceeds to read a partially materialized run dir.
    if (result.status === "failed") {
      throw new DbError(
        `could not materialize run ${opts.runId}: ` +
          `${result.error ?? "export failed"}`,
      );
    }
    // Phase 10-3: record the scratch row so `db doctor` can detect leaks
    // and so `db materialize cleanup --expired` has a list to work from.
    // This is a best-effort write — a failure here must not roll back the
    // already-completed materialization.
    try {
      recordScratchMaterialization(db, {
        runId: opts.runId,
        path: join(opts.runsDir, opts.runId),
        reason: opts.reason ?? "ensureRunMaterialized",
      });
    } catch (e) {
      process.stderr.write(
        `warning: could not record scratch materialization for ` +
          `${opts.runId}: ${(e as Error).message}\n`,
      );
    }
    return true;
  } catch (e) {
    // a DbError naming this run is "no such run" — let the caller's own
    // "run not found" path report it; a materialize failure is rethrown.
    if (e instanceof DbError && e.message.includes("no run")) return false;
    throw e;
  } finally {
    dbHandle.close();
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
  const dbHandle = openManagedDb({ dbPath: opts.dbPath });
  const db = dbHandle.db;
  let ingestOk = false;
  let dbFirst = false;
  try {
    const row = db
      .prepare("SELECT source_mode FROM runs WHERE run_id = ?")
      .get(opts.runId) as { source_mode: string } | undefined;
    if (row === undefined || row.source_mode !== "db-first") return;
    dbFirst = true;
    // best-effort post-processing: a sync failure (e.g. an unreadable run
    // dir) must not crash the review command that succeeded — warn and
    // leave the prior manifest intact (ingestRunArtifacts is transactional).
    try {
      ingestRunArtifacts(db, runDir, opts.runId);
      ingestOk = true;
    } catch (e) {
      process.stderr.write(
        `warning: could not sync run ${opts.runId} artifacts to the DB: ` +
          `${(e as Error).message}\n`,
      );
    }
  } finally {
    dbHandle.close();
  }
  // Phase 9 post-close (second review) P1-1 fix — with export OFF, a
  // scratch materialization (ensureRunMaterialized) plus a successful
  // ingest leaves a runDir that is no longer needed and would otherwise
  // mislead `run show` (file-first) into rendering stale meta.json /
  // artifact listing. Remove it so the DB stays the single source of
  // truth. Failure to remove is best-effort + warning — the canonical
  // state is in the DB regardless.
  if (dbFirst && ingestOk && !fileExportEnabled()) {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(
        `warning: could not remove scratch run dir ${runDir}: ` +
          `${(e as Error).message}\n`,
      );
    }
    // Phase 10-3: mark any active scratch rows for this run as cleaned.
    // Best-effort — failing to update bookkeeping must not surface as a
    // hard error to the caller.
    try {
      const dbHandle2 = openManagedDb({ dbPath: opts.dbPath });
      try {
        for (const row of listActiveScratchForRun(dbHandle2.db, opts.runId)) {
          markScratchCleaned(dbHandle2.db, row.materializationId);
        }
      } finally {
        dbHandle2.close();
      }
    } catch (e) {
      process.stderr.write(
        `warning: could not update run_materializations for ${opts.runId}: ` +
          `${(e as Error).message}\n`,
      );
    }
  }
}
