import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { openManagedDb, withManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { SourceModeError } from "../db/errors.js";
import { runFullImport } from "../db/import-files.js";
import {
  BacklogRepository,
  getItemWithRuns,
  type BacklogItemFilter,
} from "../db/repositories/backlog.js";
import { exportBacklogItem } from "../db/export-files.js";
import {
  BacklogError,
  listItems,
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

export interface PreparedAddBacklogItemInput {
  title: string;
  domain: string;
  goal: string;
  priority: BacklogPriority;
  tags: string[];
  projectId?: string;
}

/** The outcome of a backlog write: the item, plus any export warning. */
export interface BacklogWriteResult {
  item: BacklogItem;
  /** set when the DB write succeeded but the file export failed. */
  exportWarning?: string;
}

export type BacklogReadFilter = BacklogItemFilter;

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
  const prepared = prepareAddBacklogItemInput(input);
  const fsFloor = await maxDaySequenceFromFiles(ctx.backlogDir, dayKey(now));

  return withDb(ctx.dbPath, (db) => {
    const item = insertBacklogItemInTransaction(db, prepared, now, fsFloor);
    return result(item, exportItem(db, item.id, ctx.backlogDir));
  });
}

export function prepareAddBacklogItemInput(
  input: AddBacklogItemInput,
): PreparedAddBacklogItemInput {
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
  return {
    domain,
    title,
    goal,
    priority,
    tags: input.tags ?? [],
    ...(input.projectId !== undefined && input.projectId !== ""
      ? { projectId: input.projectId }
      : {}),
  };
}

export function insertBacklogItemInTransaction(
  db: Database.Database,
  input: PreparedAddBacklogItemInput,
  now: Date,
  fsFloor: number,
): BacklogItem {
  // Phase 9-11: legacy-file rows must be migrated before runtime writes.
  assertNoLegacyRuntimeRows(db);
  const record = new BacklogRepository(db).insertItem(
    {
      domain: input.domain,
      title: input.title,
      goal: input.goal,
      priority: input.priority,
      tags: input.tags,
      createdAt: now.toISOString(),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    },
    dayKey(now),
    fsFloor,
  );
  return toItem(record);
}

export function exportBacklogItemForContext(
  ctx: BacklogDbContext,
  itemId: string,
): string | undefined {
  return withDb(ctx.dbPath, (db) => exportItem(db, itemId, ctx.backlogDir));
}

/**
 * List backlog items through the DB-canonical read path when the harness DB
 * exists. Before the read, import/refresh file-derived legacy rows so
 * file-only backlog items stay visible alongside DB-first rows. Old harness
 * roots without `.harness/harness.sqlite` keep the previous file-only path.
 */
export async function listBacklogItems(
  ctx: BacklogDbContext,
  filter: BacklogReadFilter = {},
): Promise<BacklogItem[]> {
  if (!existsSync(ctx.dbPath)) {
    // repo scoping is resolved through the DB (project→repo). Without a DB we
    // cannot honour it, so fail closed rather than silently returning nothing.
    if (filter.repoId !== undefined) {
      throw new BacklogError(
        "backlog --repo-id filter requires the harness DB; none found at this root",
      );
    }
    return filterFileItems(await listItems(ctx.backlogDir, filter.status), filter);
  }
  return withManagedDb({ dbPath: ctx.dbPath }, (db) => {
    runMigrations(db);
    runFullImport(db, { harnessRoot: harnessRootOf(ctx), reset: true });
    return new BacklogRepository(db)
      .listItemsWithRuns(filter)
      .map((record) => toItem(record));
  });
}

/**
 * Show one backlog item through the DB-canonical read path. Old roots without
 * a DB keep the legacy YAML reader. When the DB exists it is canonical: the
 * refresh import pulls every legacy file in first, so a missing record means
 * the item genuinely does not exist — we never fall back to the file reader,
 * which could otherwise surface a stale/unimported row off the DB path.
 */
export async function showBacklogItem(
  ctx: BacklogDbContext,
  itemId: string,
): Promise<BacklogItem> {
  assertItemId(itemId);
  if (!existsSync(ctx.dbPath)) return showItem(ctx.backlogDir, itemId);
  return withManagedDb({ dbPath: ctx.dbPath }, (db) => {
    runMigrations(db);
    runFullImport(db, { harnessRoot: harnessRootOf(ctx), reset: true });
    const record = new BacklogRepository(db).getItemWithRuns(itemId);
    if (record === null) {
      throw new BacklogError(`backlog item ${itemId} not found`);
    }
    return toItem(record);
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

function harnessRootOf(ctx: BacklogDbContext): string {
  return dirname(ctx.backlogDir);
}

function filterFileItems(
  items: BacklogItem[],
  filter: BacklogReadFilter,
): BacklogItem[] {
  // repoId is rejected before this point when no DB exists, so only the
  // project filter applies here.
  return items.filter(
    (item) =>
      filter.projectId === undefined || item.projectId === filter.projectId,
  );
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
