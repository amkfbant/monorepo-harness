import type Database from "better-sqlite3";
import { openManagedDb, withManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { SourceModeError } from "../db/errors.js";
import {
  BacklogRepository,
  getItemWithRuns,
} from "../db/repositories/backlog.js";
import { exportBacklogItem } from "../db/export-files.js";
import {
  BacklogError,
  setItemStatus,
  recordBacklogRun,
  showItem,
  dayKey,
  maxDaySequenceFromFiles,
  isBacklogItemId,
  isLinkableRunId,
  type BacklogItem,
  type BacklogPriority,
  type BacklogStatus,
} from "./backlog.js";

/**
 * Backlog DB-first write path (Phase 7-8).
 *
 * A backlog item is pure structured data (no body), so it is fully
 * DB-canonical: every mutation commits to the DB first, then exports
 * `backlog/<status>/<id>.yaml` as a compatibility view.
 *
 * `add` always creates a `db-first` item. `done` / `defer` / `run` route
 * by the existing item's `source_mode`: a `db-first` item is mutated
 * through the DB and re-exported; a `legacy-file` item (a pre-Phase-7
 * file, or one the DB never imported) keeps the original file-only path.
 * A row carrying an unrecognised `source_mode` is corruption — surfaced
 * as a `SourceModeError`, never silently picked.
 *
 * The DB write is canonical; the file export is best-effort. When the
 * export fails the DB is still correct, so the operation succeeds but
 * carries an `exportWarning` the CLI surfaces to stderr.
 */

export interface BacklogDbContext {
  /** `backlog/` dir holding the {open,doing,done,deferred} status dirs. */
  backlogDir: string;
  /** harness DB path — items are canonical here. */
  dbPath: string;
}

export interface AddBacklogItemInput {
  title: string;
  domain: string;
  goal: string;
  priority?: BacklogPriority;
  tags?: string[];
  projectId?: string;
}

/** The outcome of a backlog write: the item, plus any export warning. */
export interface BacklogWriteResult {
  item: BacklogItem;
  /** set when the DB write succeeded but the file export failed. */
  exportWarning?: string;
}

const PRIORITIES: readonly BacklogPriority[] = ["high", "medium", "low"];

/**
 * Add a new backlog item. A new item is always `db-first`: the row is
 * inserted (canonical) and `backlog/open/<id>.yaml` is exported. The id is
 * allocated above both the DB max and the highest sequence already in the
 * exported files, so it never collides with a legacy item.
 */
export async function addBacklogItem(
  ctx: BacklogDbContext,
  input: AddBacklogItemInput,
  now: Date = new Date(),
): Promise<BacklogWriteResult> {
  const title = input.title.trim();
  const domain = input.domain.trim();
  const goal = input.goal.trim();
  if (title === "") throw new BacklogError("backlog add: --title is required");
  if (domain === "") throw new BacklogError("backlog add: --domain is required");
  if (goal === "") throw new BacklogError("backlog add: --goal is required");
  const priority = input.priority ?? "medium";
  if (!PRIORITIES.includes(priority)) {
    throw new BacklogError(
      `backlog add: invalid priority ${JSON.stringify(priority)} (high|medium|low)`,
    );
  }
  const day = dayKey(now);
  const fsFloor = await maxDaySequenceFromFiles(ctx.backlogDir, day);

  return withDb(ctx.dbPath, (db) => {
    // Phase 9-11: legacy-file rows must be migrated before runtime writes.
    assertNoLegacyRuntimeRows(db);
    const record = new BacklogRepository(db).insertItem(
      {
        domain,
        title,
        goal,
        priority,
        tags: input.tags ?? [],
        createdAt: now.toISOString(),
        ...(input.projectId !== undefined && input.projectId !== ""
          ? { projectId: input.projectId }
          : {}),
      },
      day,
      fsFloor,
    );
    return result(toItem(record), exportItem(db, record.id, ctx.backlogDir));
  });
}

/**
 * Move an item to `done` / `deferred`.
 *
 * A `db-first` item goes through the guarded DB transition (an invalid
 * transition — e.g. deferring an item that is already `done` — or a
 * concurrent writer is a `StateConflictError`) and is re-exported. A
 * `legacy-file` item, or one not in the DB, uses the file-only path.
 */
export async function transitionBacklogItem(
  ctx: BacklogDbContext,
  itemId: string,
  target: "done" | "deferred",
): Promise<BacklogWriteResult> {
  assertItemId(itemId);
  // The DB write runs while the connection is open; the legacy fallback
  // touches only files, so it runs after the DB is closed (the `return`
  // inside the try short-circuits the db-first path).
  const dbHandle = openManagedDb({ dbPath: ctx.dbPath });
  const db = dbHandle.db;
  try {
    runMigrations(db);
    // Phase 9-11: refuse runtime writes while legacy-file rows linger.
    assertNoLegacyRuntimeRows(db);
    const repo = new BacklogRepository(db);
    const existing = repo.getItem(itemId);
    if (existing !== null && existing.sourceMode === "db-first") {
      // `done` is reachable from any non-done status; `deferred` only from
      // an active status — deferring a finished item is an invalid move.
      const expectedStatuses: BacklogStatus[] =
        target === "done" ? ["open", "doing", "deferred"] : ["open", "doing"];
      repo.updateItemStatus({ itemId, expectedStatuses, nextStatus: target });
      return result(
        requireItem(db, itemId),
        exportItem(db, itemId, ctx.backlogDir),
      );
    }
    assertLegacyOrAbsent(existing, itemId);
  } finally {
    dbHandle.close();
  }
  // legacy / not-in-DB item — keep the original file-only path.
  return result(await setItemStatus(ctx.backlogDir, itemId, target));
}

/**
 * Link a launched run to a backlog item and move the item to `doing`.
 *
 * A `db-first` item records the link in `backlog_run_links` and is
 * re-exported; a `legacy-file` item appends to the YAML's `linkedRuns`.
 * Re-linking the same run is idempotent on either path.
 */
export async function linkBacklogRun(
  ctx: BacklogDbContext,
  itemId: string,
  runId: string,
): Promise<BacklogWriteResult> {
  assertItemId(itemId);
  if (!isLinkableRunId(runId)) {
    throw new BacklogError(`invalid runId: ${JSON.stringify(runId)}`);
  }
  const dbHandle = openManagedDb({ dbPath: ctx.dbPath });
  const db = dbHandle.db;
  try {
    runMigrations(db);
    // Phase 9-11: refuse runtime writes while legacy-file rows linger.
    assertNoLegacyRuntimeRows(db);
    const repo = new BacklogRepository(db);
    const existing = repo.getItem(itemId);
    if (existing !== null && existing.sourceMode === "db-first") {
      repo.linkRun({ itemId, runId });
      return result(
        requireItem(db, itemId),
        exportItem(db, itemId, ctx.backlogDir),
      );
    }
    assertLegacyOrAbsent(existing, itemId);
  } finally {
    dbHandle.close();
  }
  // legacy / not-in-DB item — append to the YAML's linkedRuns.
  return result(await recordBacklogRun(ctx.backlogDir, itemId, runId));
}

/**
 * Resolve the canonical `BacklogItem` for `backlog run`, before the run
 * is launched. A `db-first` item is read from the DB row (canonical),
 * never from a possibly-stale exported YAML; a `legacy-file` item, or one
 * not in the DB, is read from its file. An unrecognised `source_mode` is
 * a `SourceModeError` raised up-front, not after a run has been created.
 */
export async function resolveBacklogItemForRun(
  ctx: BacklogDbContext,
  itemId: string,
): Promise<BacklogItem> {
  assertItemId(itemId);
  const dbHandle = openManagedDb({ dbPath: ctx.dbPath });
  const db = dbHandle.db;
  try {
    runMigrations(db);
    const existing = getItemWithRuns(db, itemId);
    if (existing !== null && existing.sourceMode === "db-first") {
      return toItem(existing);
    }
    assertLegacyOrAbsent(existing, itemId);
  } finally {
    dbHandle.close();
  }
  return showItem(ctx.backlogDir, itemId);
}

function assertItemId(itemId: string): void {
  if (!isBacklogItemId(itemId)) {
    throw new BacklogError(
      `invalid backlog item id: ${JSON.stringify(itemId)}`,
    );
  }
}

/**
 * Confirm a row is safe for the file-only path: `legacy-file` or absent.
 * Anything else is an unrecognised `source_mode` — corruption — and is
 * surfaced rather than silently treated as legacy.
 */
function assertLegacyOrAbsent(
  existing: { sourceMode: string } | null,
  itemId: string,
): void {
  if (existing !== null && existing.sourceMode !== "legacy-file") {
    throw new SourceModeError(
      itemId,
      existing.sourceMode,
      "db-first | legacy-file",
    );
  }
}

/** Export a db-first item; return a warning string when the export failed. */
function exportItem(
  db: Database.Database,
  itemId: string,
  backlogDir: string,
): string | undefined {
  const exported = exportBacklogItem(db, itemId, { backlogDir });
  if (exported.status === "failed") {
    return (
      `backlog item ${itemId}: the DB was updated but exporting ` +
      `backlog/<status>/${itemId}.yaml failed: ${exported.error ?? "unknown error"}`
    );
  }
  return undefined;
}

/** Read an item back from the DB after a write — a missing row is a bug. */
function requireItem(db: Database.Database, itemId: string): BacklogItem {
  const record = getItemWithRuns(db, itemId);
  if (record === null) {
    throw new BacklogError(`backlog item ${itemId} vanished after write`);
  }
  return toItem(record);
}

/** Strip the DB-only `sourceMode` field down to a plain `BacklogItem`. */
function toItem(record: BacklogItem & { sourceMode?: string }): BacklogItem {
  const { sourceMode: _sourceMode, ...item } = record;
  return item;
}

/** Build a `BacklogWriteResult`, attaching `exportWarning` only when set. */
function result(
  item: BacklogItem,
  exportWarning?: string,
): BacklogWriteResult {
  return { item, ...(exportWarning !== undefined ? { exportWarning } : {}) };
}

/**
 * Open the DB (running migrations), run `fn`, and always close. The DB is
 * opened lazily here rather than kept by the caller so a backlog command
 * never leaks a connection on an error path. Phase 9 post-close P0 fix:
 * the managed wrapper holds the DB-wide shared maintenance lock for the
 * lifetime of the call so a concurrent `db restore` can't swap the DB
 * out under us.
 */
function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  return withManagedDb({ dbPath }, (db) => {
    runMigrations(db);
    return fn(db);
  });
}
