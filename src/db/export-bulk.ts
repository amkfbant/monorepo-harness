import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import {
  exportRun,
  exportBacklogItem,
  exportKnowledgeEntry,
  type ExportResult,
} from "./export-files.js";

/**
 * Bulk file export (Phase 7-11) — `harness db export-files`.
 *
 * The DB-first commands export the single scope they touched. This drives
 * the same per-scope exporters across *every* `db-first` row, so an
 * operator can rebuild the compatibility files after a crash, a failed
 * export, or a `--reset` import. Only `db-first` rows are exported: a
 * `legacy-file` row's files are already its source of truth.
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

const SCOPE_QUERY: Record<ExportScope, { table: string; idColumn: string }> = {
  run: { table: "runs", idColumn: "run_id" },
  backlog: { table: "backlog_items", idColumn: "item_id" },
  knowledge: { table: "knowledge_entries", idColumn: "entry_id" },
};

/** Re-export the DB-canonical files for the requested scopes. */
export function exportFiles(
  db: Database.Database,
  opts: ExportFilesOptions,
): BulkExportResult[] {
  const paths = harnessPaths(opts.harnessRoot);
  const scopes: ExportScope[] =
    opts.scope !== undefined ? [opts.scope] : ["run", "backlog", "knowledge"];
  return scopes.map((scope) => {
    const ids = dbFirstIds(db, scope, opts.id);
    const result: BulkExportResult = {
      scope,
      total: ids.length,
      synced: 0,
      failed: 0,
      failures: [],
    };
    for (const id of ids) {
      const r = exportOne(db, scope, id, opts.harnessRoot, paths.runsDir, paths.backlogDir);
      if (r.status === "synced") result.synced += 1;
      else {
        result.failed += 1;
        result.failures.push({ id, error: r.error ?? "unknown error" });
      }
    }
    return result;
  });
}

/** The `db-first` row ids for a scope, optionally narrowed to one id. */
function dbFirstIds(
  db: Database.Database,
  scope: ExportScope,
  id: string | undefined,
): string[] {
  const { table, idColumn } = SCOPE_QUERY[scope];
  const where =
    id !== undefined
      ? `WHERE source_mode = 'db-first' AND ${idColumn} = ?`
      : "WHERE source_mode = 'db-first'";
  const rows = db
    .prepare(`SELECT ${idColumn} AS id FROM ${table} ${where} ORDER BY ${idColumn}`)
    .all(...(id !== undefined ? [id] : [])) as { id: string }[];
  return rows.map((r) => r.id);
}

function exportOne(
  db: Database.Database,
  scope: ExportScope,
  id: string,
  harnessRoot: string,
  runsDir: string,
  backlogDir: string,
): ExportResult {
  if (scope === "run") return exportRun(db, id, { runsDir });
  if (scope === "backlog") return exportBacklogItem(db, id, { backlogDir });
  return exportKnowledgeEntry(db, id, { harnessRoot });
}

/** Render the bulk export result set as a human-readable block. */
export function formatBulkExport(results: BulkExportResult[]): string {
  const lines = ["db export-files:"];
  for (const r of results) {
    lines.push(
      `  ${r.scope}: ${r.synced}/${r.total} synced` +
        (r.failed > 0 ? ` (${r.failed} failed)` : ""),
    );
    for (const f of r.failures) lines.push(`    failed ${f.id}: ${f.error}`);
  }
  return `${lines.join("\n")}\n`;
}
