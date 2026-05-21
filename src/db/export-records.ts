import type Database from "better-sqlite3";
import { sha256 } from "./import/common.js";

/**
 * Export integrity tracking (Phase 7-2).
 *
 * After a DB-first command exports files, it records the outcome here so
 * `db check-consistency` / the dashboard can tell which scope was exported
 * at which `db_revision`, and surface a stale or failed export.
 *
 *  - `export_records` — one row per export attempt (synced / failed).
 *  - `exported_files` — the current exported file set for a scope.
 *  - the scope's own row (`runs` / `backlog_items` / …) carries
 *    `export_status` / `last_export_revision` / `last_exported_at` /
 *    `last_export_error` so a single-row read shows export freshness.
 */

/** Scope tables that carry the v2 export-status columns. */
const SCOPE_TABLE: Record<string, { table: string; idColumn: string }> = {
  run: { table: "runs", idColumn: "run_id" },
  backlog_item: { table: "backlog_items", idColumn: "item_id" },
  knowledge_entry: { table: "knowledge_entries", idColumn: "entry_id" },
};

export interface ExportedFileInfo {
  relativePath: string;
  sha256: string;
  bytes: number;
}

/** Build the `ExportedFileInfo` for a written file. */
export function describeExportedFile(
  relativePath: string,
  content: string | Buffer,
): ExportedFileInfo {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return { relativePath, sha256: sha256(buf), bytes: buf.byteLength };
}

/**
 * Record a successful export: an `export_records` row, the replaced
 * `exported_files` set, and the scope row's export-status columns.
 */
export function recordExportSuccess(
  db: Database.Database,
  input: {
    scopeType: string;
    scopeId: string;
    dbRevision: number;
    startedAt: string;
    files: ExportedFileInfo[];
  },
): void {
  const finishedAt = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO export_records
         (scope_type, scope_id, db_revision, status, started_at,
          finished_at, error_message, exported_files_json)
       VALUES (?, ?, ?, 'synced', ?, ?, NULL, ?)`,
    ).run(
      input.scopeType,
      input.scopeId,
      input.dbRevision,
      input.startedAt,
      finishedAt,
      JSON.stringify(input.files),
    );
    db.prepare(
      "DELETE FROM exported_files WHERE scope_type = ? AND scope_id = ?",
    ).run(input.scopeType, input.scopeId);
    const insertFile = db.prepare(
      `INSERT INTO exported_files
         (scope_type, scope_id, relative_path, sha256, bytes, db_revision,
          exported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of input.files) {
      insertFile.run(
        input.scopeType,
        input.scopeId,
        f.relativePath,
        f.sha256,
        f.bytes,
        input.dbRevision,
        finishedAt,
      );
    }
    // only flip the scope to `synced` when it is STILL at the revision we
    // exported. If another writer advanced `db_revision` while the export
    // ran, the files are already stale — leave the row `dirty` so
    // check-consistency / a re-export picks it up. The export_records /
    // exported_files rows above still record what was written.
    const scope = SCOPE_TABLE[input.scopeType];
    if (scope !== undefined) {
      db.prepare(
        `UPDATE ${scope.table}
           SET export_status = 'synced', last_export_revision = ?,
               last_exported_at = ?, last_export_error = NULL
         WHERE ${scope.idColumn} = ? AND db_revision = ?`,
      ).run(input.dbRevision, finishedAt, input.scopeId, input.dbRevision);
    }
  });
  txn.immediate();
}

/**
 * Record a failed export. The DB stays canonical — the failure is a
 * warning, not a rollback — so the scope is left marked `failed` for
 * `check-consistency` and a later re-export to pick up.
 */
export function recordExportFailure(
  db: Database.Database,
  input: {
    scopeType: string;
    scopeId: string;
    dbRevision: number;
    startedAt: string;
    error: string;
  },
): void {
  const finishedAt = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO export_records
         (scope_type, scope_id, db_revision, status, started_at,
          finished_at, error_message, exported_files_json)
       VALUES (?, ?, ?, 'failed', ?, ?, ?, NULL)`,
    ).run(
      input.scopeType,
      input.scopeId,
      input.dbRevision,
      input.startedAt,
      finishedAt,
      input.error,
    );
    // a failed export must not advance last_export_revision — the files
    // are not at this revision. Only the status / error are updated.
    const scope = SCOPE_TABLE[input.scopeType];
    if (scope !== undefined) {
      db.prepare(
        `UPDATE ${scope.table}
           SET export_status = 'failed', last_exported_at = ?,
               last_export_error = ?
         WHERE ${scope.idColumn} = ?`,
      ).run(finishedAt, input.error, input.scopeId);
    }
  });
  txn.immediate();
}
