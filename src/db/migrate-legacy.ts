import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { DB_RECONSTRUCTED } from "./run-artifacts.js";

/**
 * Legacy-file → db-first migration (Phase 8-6) — `harness db migrate-legacy`.
 *
 * Phase 7 left rows imported from files as `source_mode='legacy-file'`.
 * Phase 8 runs DB-first; this converts the remaining legacy rows to
 * `db-first` so the DB is canonical for them too (after which
 * `db export-files` covers them and the legacy routing branches no longer
 * apply).
 *
 * A run is only promoted once its artifact bodies are in the DB: a run
 * still holding file-backed artifact bodies (`storage='file'`, excluding
 * the DB-reconstructed `meta.json` / `events.jsonl` / `review-decision.yaml`)
 * is skipped and reported — run `db migrate-artifacts` first, then re-run
 * this. Otherwise the run would be db-first with no DB-side artifact body,
 * breaking the DB-complete invariant.
 *
 * Idempotent — only `source_mode='legacy-file'` rows are touched. The whole
 * migration runs in one immediate transaction. A run's `meta_json` is
 * backfilled from its `meta.json` file (its content, sans the trailing
 * newline — matching how `meta_json` is stored elsewhere; `exportRun`
 * re-appends the newline). If the file is gone the column is left NULL and
 * `exportRun` reconstructs `meta.json` from the flat columns.
 */

export interface MigrateLegacyReport {
  /** runs converted to db-first. */
  runs: number;
  /** runs left legacy-file because file-backed artifact bodies remain. */
  runsBlockedByArtifacts: number;
  /** backlog items converted. */
  backlogItems: number;
  /** knowledge candidates converted. */
  knowledgeCandidates: number;
  /** converted runs that had no `meta.json` file (meta_json left NULL). */
  runsWithoutMetaFile: number;
}

export function migrateLegacy(
  db: Database.Database,
  opts: { runsDir: string },
): MigrateLegacyReport {
  const run = db.transaction((): MigrateLegacyReport => {
    const report: MigrateLegacyReport = {
      runs: 0,
      runsBlockedByArtifacts: 0,
      backlogItems: 0,
      knowledgeCandidates: 0,
      runsWithoutMetaFile: 0,
    };

    const legacyRuns = db
      .prepare(
        `SELECT run_id, meta_json FROM runs WHERE source_mode = 'legacy-file'`,
      )
      .all() as { run_id: string; meta_json: string | null }[];
    // a run still holding non-reconstructed file-backed artifact bodies
    // cannot safely become db-first (P1).
    const reconstructed = [...DB_RECONSTRUCTED];
    const pendingArtifacts = db.prepare(
      `SELECT count(*) AS n FROM artifacts
       WHERE run_id = ? AND storage = 'file'
         AND (relative_path IS NULL
              OR relative_path NOT IN (${reconstructed.map(() => "?").join(", ")}))`,
    );
    // the UPDATE is guarded by `source_mode = 'legacy-file'` so a
    // concurrent promotion of the same run cannot be double-applied.
    const promoteRun = db.prepare(
      `UPDATE runs
         SET source_mode = 'db-first', meta_json = ?,
             db_revision = db_revision + 1, export_status = 'dirty',
             last_export_error = NULL
       WHERE run_id = ? AND source_mode = 'legacy-file'`,
    );
    for (const r of legacyRuns) {
      const pending = pendingArtifacts.get(r.run_id, ...reconstructed) as {
        n: number;
      };
      if (pending.n > 0) {
        report.runsBlockedByArtifacts += 1;
        continue;
      }
      let metaJson = r.meta_json;
      if (metaJson === null) {
        const metaPath = join(opts.runsDir, r.run_id, "meta.json");
        if (existsSync(metaPath)) {
          metaJson = readFileSync(metaPath, "utf8").replace(/\n$/, "");
        } else {
          report.runsWithoutMetaFile += 1;
        }
      }
      const res = promoteRun.run(metaJson, r.run_id);
      report.runs += res.changes;
    }

    report.backlogItems = db
      .prepare(
        `UPDATE backlog_items
           SET source_mode = 'db-first', db_revision = db_revision + 1,
               export_status = 'dirty', last_export_error = NULL
         WHERE source_mode = 'legacy-file'`,
      )
      .run().changes;

    // a rejected candidate has a `knowledge-decisions.yaml` projection to
    // re-export (`dirty`); other candidates have no DB→file export, so
    // marking them `dirty` would leave a permanent `check-consistency`
    // drift — they stay `synced` (P1).
    report.knowledgeCandidates = db
      .prepare(
        `UPDATE knowledge_candidates
           SET source_mode = 'db-first', db_revision = db_revision + 1,
               export_status =
                 CASE WHEN status = 'rejected' THEN 'dirty' ELSE 'synced' END,
               last_export_error = NULL
         WHERE source_mode = 'legacy-file'`,
      )
      .run().changes;

    return report;
  });
  return run.immediate();
}

/** Render a `MigrateLegacyReport` as a human-readable block. */
export function formatMigrateLegacy(r: MigrateLegacyReport): string {
  const lines = [
    "db migrate-legacy:",
    `  runs:                 ${r.runs}`,
    `  backlog items:        ${r.backlogItems}`,
    `  knowledge candidates: ${r.knowledgeCandidates}`,
    `  runs without meta.json (meta_json left NULL): ${r.runsWithoutMetaFile}`,
  ];
  if (r.runsBlockedByArtifacts > 0) {
    lines.push(
      `  runs NOT converted (file-backed artifacts remain): ${r.runsBlockedByArtifacts}`,
      "  → run `harness db migrate-artifacts` first, then re-run this.",
    );
  }
  return `${lines.join("\n")}\n`;
}
