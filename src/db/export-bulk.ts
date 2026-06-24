import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import {
  exportRun,
  exportBacklogItem,
  exportKnowledgeDecisions,
  clearKnowledgeDecisionExport,
} from "./export-files.js";

/**
 * Bulk file export (Phase 7-11) — `harness db export-files`.
 *
 * The DB-first commands export the single scope they touched. This drives
 * the same per-scope exporters across *every* DB-canonical row, so an
 * operator can rebuild the compatibility files after a crash, a failed
 * export, or a `--reset` import.
 *
 * - `run` / `backlog`: every `db-first` row's files are re-exported.
 * - `knowledge`: every run with `db-first` rejected candidate decisions
 *   has its `knowledge-decisions.yaml` re-projected. Promoted-entry `.md`
 *   bodies are file-backed (the `.md` is the artifact) and are NOT
 *   re-exported.
 */

export type ExportScope = "run" | "backlog" | "knowledge";

export interface BulkExportResult {
  scope: ExportScope;
  total: number;
  synced: number;
  failed: number;
  failures: { id: string; error: string }[];
}

export interface ExportFilesOptions {
  harnessRoot: string;
  /** restrict to one scope; default exports run + backlog + knowledge */
  scope?: ExportScope;
  /** restrict to one row id within the scope (requires `scope`) */
  id?: string;
}

/** Re-export the DB-canonical files for the requested scopes. */
export function exportFiles(
  db: Database.Database,
  opts: ExportFilesOptions,
): BulkExportResult[] {
  const paths = harnessPaths(opts.harnessRoot);
  const scopes: ExportScope[] =
    opts.scope !== undefined ? [opts.scope] : ["run", "backlog", "knowledge"];
  return scopes.map((scope) => {
    if (scope === "knowledge") {
      clearKnowledgeDecisionExportsWithoutRejections(db, paths.runsDir, opts.id);
    }
    const ids = scopeIds(db, scope, opts.id);
    const result: BulkExportResult = {
      scope,
      total: ids.length,
      synced: 0,
      failed: 0,
      failures: [],
    };
    for (const id of ids) {
      const r = exportOne(db, scope, id, paths.runsDir, paths.backlogDir);
      if (r.status === "synced") result.synced += 1;
      else {
        result.failed += 1;
        result.failures.push({ id, error: r.error ?? "unknown error" });
      }
    }
    return result;
  });
}

/**
 * The export targets for a scope. `run` / `backlog` are `db-first` rows;
 * `knowledge` is the set of runs that have `db-first` rejected candidate
 * decisions (one `knowledge-decisions.yaml` per run).
 */
function scopeIds(
  db: Database.Database,
  scope: ExportScope,
  id: string | undefined,
): string[] {
  const table =
    scope === "run"
      ? "runs"
      : scope === "backlog"
        ? "backlog_items"
        : "knowledge_candidates";
  const col = scope === "backlog" ? "item_id" : "run_id";
  const distinct = scope === "knowledge" ? "DISTINCT " : "";
  let sql = `SELECT ${distinct}${col} AS id FROM ${table} WHERE source_mode = 'db-first'`;
  if (scope === "knowledge") sql += " AND status = 'rejected'";
  // a run whose dir was removed by `cleanup --scope run/all` is
  // intentionally file-less — re-exporting it (the run's meta/events OR
  // its knowledge-decisions.yaml, both under runs/<id>/) would resurrect
  // the deleted run dir, so it is excluded (P1-4 / P1-a).
  if (scope === "run" || scope === "knowledge") {
    sql +=
      " AND run_id NOT IN (SELECT run_id FROM cleanup_actions" +
      " WHERE action_type = 'run_dir_remove' AND status = 'done')";
  }
  if (id !== undefined) sql += ` AND ${col} = @id`;
  sql += ` ORDER BY ${col}`;
  const rows = db.prepare(sql).all(id !== undefined ? { id } : {}) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

function clearKnowledgeDecisionExportsWithoutRejections(
  db: Database.Database,
  runsDir: string,
  id: string | undefined,
): void {
  const runIdFilter = id === undefined ? "" : " AND run_id = @id";
  const scopeIdFilter = id === undefined ? "" : " AND scope_id = @id";
  const rows = db
    .prepare(
      `SELECT target.id
       FROM (
         SELECT run_id AS id
         FROM runs
         WHERE source_mode = 'db-first'${runIdFilter}
         UNION
         SELECT scope_id AS id
         FROM exported_files
         WHERE scope_type = 'knowledge_decisions'${scopeIdFilter}
         UNION
         SELECT run_id AS id
         FROM knowledge_candidates
         WHERE source_mode = 'db-first'${runIdFilter}
       ) AS target
       WHERE NOT EXISTS (
         SELECT 1 FROM knowledge_candidates rejected
         WHERE rejected.run_id = target.id
           AND rejected.status = 'rejected'
       )
       ORDER BY target.id`,
    )
    .all(id === undefined ? {} : { id }) as { id: string }[];
  for (const row of rows) {
    clearKnowledgeDecisionExport(db, row.id, runsDir);
  }
}

function exportOne(
  db: Database.Database,
  scope: ExportScope,
  id: string,
  runsDir: string,
  backlogDir: string,
): { status: "synced" | "failed" | "disabled"; error?: string } {
  // an explicit `db export-files` always exports — `force` bypasses the
  // Phase 8-5 opt-out (`HARNESS_EXPORT_FILES`).
  if (scope === "run") return exportRun(db, id, { runsDir, force: true });
  if (scope === "backlog") {
    return exportBacklogItem(db, id, { backlogDir, force: true });
  }
  return exportKnowledgeDecisions(db, id, { runsDir, force: true });
}

/** Render the bulk export result set as a human-readable block. */
export function formatBulkExport(results: BulkExportResult[]): string {
  const lines = ["db export-files:"];
  for (const r of results) {
    const unit = r.scope === "knowledge" ? "decision sidecars" : "rows";
    lines.push(
      `  ${r.scope}: ${r.synced}/${r.total} ${unit} synced` +
        (r.failed > 0 ? ` (${r.failed} failed)` : ""),
    );
    for (const f of r.failures) lines.push(`    failed ${f.id}: ${f.error}`);
  }
  return `${lines.join("\n")}\n`;
}
