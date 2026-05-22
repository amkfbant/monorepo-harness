import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

/**
 * Legacy-file → db-first migration (Phase 8-6) — `harness db migrate-legacy`.
 *
 * Phase 7 left rows imported from files as `source_mode='legacy-file'`.
 * Phase 8 runs DB-first; this converts the remaining legacy rows to
 * `db-first` so the DB is canonical for them too (after which
 * `db export-files` covers them and the legacy routing branches no longer
 * apply).
 *
 * It is idempotent — only `source_mode='legacy-file'` rows are touched, so
 * a second run is a no-op. A run's `meta_json` is backfilled from its
 * `meta.json` file verbatim (lossless); if the file is gone the column is
 * left NULL and `exportRun` reconstructs meta.json from the flat columns.
 */

export interface MigrateLegacyReport {
  runs: number;
  backlogItems: number;
  knowledgeCandidates: number;
  /** runs converted without a `meta.json` file (meta_json left NULL). */
  runsWithoutMetaFile: number;
}

export function migrateLegacy(
  db: Database.Database,
  opts: { runsDir: string },
): MigrateLegacyReport {
  const report: MigrateLegacyReport = {
    runs: 0,
    backlogItems: 0,
    knowledgeCandidates: 0,
    runsWithoutMetaFile: 0,
  };

  const legacyRuns = db
    .prepare(
      `SELECT run_id, meta_json FROM runs WHERE source_mode = 'legacy-file'`,
    )
    .all() as { run_id: string; meta_json: string | null }[];
  const promoteRun = db.prepare(
    `UPDATE runs
       SET source_mode = 'db-first', meta_json = ?,
           db_revision = db_revision + 1, export_status = 'dirty',
           last_export_error = NULL
     WHERE run_id = ?`,
  );
  for (const run of legacyRuns) {
    // backfill meta_json from the run's meta.json file (the legacy
    // canonical) so the db-first export is lossless.
    let metaJson = run.meta_json;
    if (metaJson === null) {
      const metaPath = join(opts.runsDir, run.run_id, "meta.json");
      if (existsSync(metaPath)) {
        metaJson = readFileSync(metaPath, "utf8").replace(/\n$/, "");
      } else {
        report.runsWithoutMetaFile += 1;
      }
    }
    promoteRun.run(metaJson, run.run_id);
    report.runs += 1;
  }

  const promoteBacklog = db
    .prepare(
      `UPDATE backlog_items
         SET source_mode = 'db-first', db_revision = db_revision + 1,
             export_status = 'dirty', last_export_error = NULL
       WHERE source_mode = 'legacy-file'`,
    )
    .run();
  report.backlogItems = promoteBacklog.changes;

  const promoteKnowledge = db
    .prepare(
      `UPDATE knowledge_candidates
         SET source_mode = 'db-first', db_revision = db_revision + 1,
             export_status = 'dirty', last_export_error = NULL
       WHERE source_mode = 'legacy-file'`,
    )
    .run();
  report.knowledgeCandidates = promoteKnowledge.changes;

  return report;
}

/** Render a `MigrateLegacyReport` as a human-readable block. */
export function formatMigrateLegacy(r: MigrateLegacyReport): string {
  return (
    [
      "db migrate-legacy:",
      `  runs:                ${r.runs}`,
      `  backlog items:       ${r.backlogItems}`,
      `  knowledge candidates: ${r.knowledgeCandidates}`,
      `  runs without meta.json (meta_json left NULL): ${r.runsWithoutMetaFile}`,
    ].join("\n") + "\n"
  );
}
