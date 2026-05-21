import type Database from "better-sqlite3";
import { DbError } from "./connection.js";
import { SourceModeError } from "./errors.js";

/**
 * Runtime scope rows (Phase 7).
 *
 * The four runtime tables each carry two pieces of write-path metadata
 * added in schema v2: `db_revision` (bumped on every DB write, used to
 * tell whether an exported file is current) and `source_mode` (the
 * migration invariant — `legacy-file` rows belong to not-yet-migrated
 * file-first commands, `db-first` rows belong to DB-first commands).
 *
 * `SCOPE_TABLE` is a fixed allowlist: the table/column names interpolated
 * into SQL below come only from these constants, never from a caller.
 */

export type RuntimeScope =
  | "run"
  | "backlog_item"
  | "knowledge_candidate"
  | "knowledge_entry";

export type SourceMode = "legacy-file" | "db-first";

const SCOPE_TABLE: Record<
  RuntimeScope,
  { table: string; idColumn: string }
> = {
  run: { table: "runs", idColumn: "run_id" },
  backlog_item: { table: "backlog_items", idColumn: "item_id" },
  knowledge_candidate: {
    table: "knowledge_candidates",
    idColumn: "candidate_id",
  },
  knowledge_entry: { table: "knowledge_entries", idColumn: "entry_id" },
};

/**
 * Increment a row's `db_revision` and return the new value. The same
 * UPDATE marks the row `export_status = 'dirty'`: the DB has changed and
 * its files have not been re-exported yet, so a crash between the commit
 * and the export leaves an honest "needs export" marker rather than a
 * stale `synced`. Throws when the row does not exist (a write to a
 * missing row is always a bug).
 */
export function bumpRevision(
  db: Database.Database,
  scope: RuntimeScope,
  id: string,
): number {
  const { table, idColumn } = SCOPE_TABLE[scope];
  const info = db
    .prepare(
      `UPDATE ${table}
         SET db_revision = db_revision + 1,
             export_status = 'dirty', last_export_error = NULL
       WHERE ${idColumn} = ?`,
    )
    .run(id);
  if (info.changes === 0) {
    throw new DbError(`bumpRevision: no ${scope} row '${id}'`);
  }
  const row = db
    .prepare(`SELECT db_revision AS r FROM ${table} WHERE ${idColumn} = ?`)
    .get(id) as { r: number };
  return row.r;
}

/** The row's `source_mode`, or `undefined` when the row does not exist. */
export function readSourceMode(
  db: Database.Database,
  scope: RuntimeScope,
  id: string,
): SourceMode | undefined {
  const { table, idColumn } = SCOPE_TABLE[scope];
  const row = db
    .prepare(`SELECT source_mode AS m FROM ${table} WHERE ${idColumn} = ?`)
    .get(id) as { m: SourceMode } | undefined;
  return row?.m;
}

/**
 * Enforce the migration invariant: the row must be in `expected` source
 * mode. A missing row is a `DbError`; a wrong mode is a `SourceModeError`
 * — e.g. a file-first command handed a `db-first` row.
 */
export function assertSourceMode(
  db: Database.Database,
  scope: RuntimeScope,
  id: string,
  expected: SourceMode,
): void {
  const mode = readSourceMode(db, scope, id);
  if (mode === undefined) {
    throw new DbError(`assertSourceMode: no ${scope} row '${id}'`);
  }
  if (mode !== expected) {
    throw new SourceModeError(id, mode, expected);
  }
}
