import type Database from "better-sqlite3";
import { DbError } from "../connection.js";
import { StateConflictError } from "../errors.js";
import type {
  BacklogItem,
  BacklogPriority,
  BacklogStatus,
} from "../../core/backlog.js";

/**
 * Backlog write repository (Phase 7-8).
 *
 * A backlog item has no body — it is purely structured data — so it is
 * fully DB-canonical: the DB row is the source of truth and `backlog/
 * <status>/<id>.yaml` is a compatibility export. These write methods are
 * the canonical mutations; `exportBacklogItem` mirrors them onto files.
 *
 * `insertItem` allocates the `item-YYYYMMDD-NNN` id from the DB (with a
 * filesystem floor so a legacy item never imported still bumps the
 * sequence). `updateItemStatus` is the guarded status transition; a
 * mismatch against `expectedStatuses` is a `StateConflictError` rather
 * than a silent overwrite. `linkRun` records a launched run and moves the
 * item to `doing`.
 */

/** A backlog item as stored in the DB, including its migration metadata. */
export interface BacklogItemRecord extends BacklogItem {
  /**
   * The row's raw `source_mode` — `legacy-file` (pre-Phase-7 / file-first)
   * or `db-first`. Kept as the stored string (not narrowed) so an
   * unrecognised value surfaces as corruption rather than being silently
   * coerced.
   */
  sourceMode: string;
}

/** Filters supported by full backlog item reads. */
export interface BacklogItemFilter {
  status?: BacklogStatus;
  projectId?: string;
  repoId?: string;
}

/** Fields needed to create a backlog item; the id is allocated here. */
export interface InsertItemInput {
  domain: string;
  title: string;
  goal: string;
  priority: BacklogPriority;
  tags: string[];
  createdAt: string;
  projectId?: string;
}

interface ItemRow {
  item_id: string;
  project_id: string | null;
  domain: string;
  title: string;
  goal: string;
  status: string;
  priority: string;
  tags_json: string;
  created_at: string;
  source_mode: string;
}

interface ItemWithRunRow extends ItemRow {
  run_id: string | null;
}

export class BacklogRepository {
  constructor(private readonly db: Database.Database) {}

  /** A single item with its linked runs and source mode, or null. */
  getItem(itemId: string): BacklogItemRecord | null {
    const row = this.db
      .prepare(
        `SELECT item_id, project_id, domain, title, goal, status, priority,
                tags_json, created_at, source_mode
         FROM backlog_items WHERE item_id = ?`,
      )
      .get(itemId) as ItemRow | undefined;
    if (row === undefined) return null;
    return { ...rowToItem(row), sourceMode: row.source_mode };
  }

  /** A single item with its linked runs and source mode, or null. */
  getItemWithRuns(itemId: string): BacklogItemRecord | null {
    const item = this.getItem(itemId);
    if (item === null) return null;
    const links = this.db
      .prepare(
        "SELECT run_id FROM backlog_run_links WHERE item_id = ? ORDER BY linked_at, run_id",
      )
      .all(itemId) as { run_id: string }[];
    return { ...item, linkedRuns: links.map((l) => l.run_id) };
  }

  /** Full backlog items, including goal/tags/createdAt/linkedRuns. */
  listItemsWithRuns(filter: BacklogItemFilter = {}): BacklogItemRecord[] {
    const { whereSql, params } = backlogWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT b.item_id, b.project_id, b.domain, b.title, b.goal, b.status,
                b.priority, b.tags_json, b.created_at, b.source_mode, l.run_id
           FROM backlog_items b
           LEFT JOIN backlog_run_links l ON l.item_id = b.item_id
           ${whereSql}
          ORDER BY b.item_id DESC, l.linked_at, l.run_id`,
      )
      .all(...params) as ItemWithRunRow[];
    const byId = new Map<string, BacklogItemRecord>();
    for (const row of rows) {
      let item = byId.get(row.item_id);
      if (item === undefined) {
        item = { ...rowToItem(row), sourceMode: row.source_mode };
        byId.set(row.item_id, item);
      }
      if (row.run_id !== null) item.linkedRuns.push(row.run_id);
    }
    return Array.from(byId.values());
  }

  /**
   * Highest `NNN` sequence among `item-<day>-NNN` ids in the DB, or 0.
   * Used together with the filesystem floor to allocate the next id.
   */
  maxDaySequence(day: string): number {
    const prefix = `item-${day}-`;
    const rows = this.db
      .prepare("SELECT item_id FROM backlog_items WHERE item_id LIKE ?")
      .all(`${prefix}%`) as { item_id: string }[];
    let max = 0;
    for (const r of rows) {
      const m = r.item_id.match(/^item-\d{8}-(\d{3})$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  /**
   * Create a new `db-first` backlog item, allocating its id for `day`.
   * `fsFloor` is the highest sequence already present in the exported
   * files — the allocated sequence starts above both it and the DB max,
   * and a PK collision (a concurrent add that grabbed the same id) retries
   * with the next sequence.
   */
  insertItem(
    input: InsertItemInput,
    day: string,
    fsFloor: number,
  ): BacklogItemRecord {
    const repoId =
      input.projectId !== undefined
        ? ((
            this.db
              .prepare("SELECT repo_id FROM projects WHERE project_id = ?")
              .get(input.projectId) as { repo_id: string | null } | undefined
          )?.repo_id ?? null)
        : null;
    const insert = this.db.prepare(
      `INSERT INTO backlog_items (item_id, project_id, repo_id, domain, title,
         goal, status, priority, tags_json, created_at, updated_at,
         source_mode, db_revision, export_status)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 'db-first', 1, 'dirty')`,
    );
    let seq = Math.max(this.maxDaySequence(day), fsFloor) + 1;
    for (let attempt = 0; attempt < 1000; attempt += 1, seq += 1) {
      const itemId = `item-${day}-${String(seq).padStart(3, "0")}`;
      try {
        insert.run(
          itemId,
          input.projectId ?? null,
          repoId,
          input.domain,
          input.title,
          input.goal,
          input.priority,
          JSON.stringify(input.tags),
          input.createdAt,
          input.createdAt,
        );
        const created = this.getItem(itemId);
        if (created === null) {
          throw new DbError(`insertItem: row '${itemId}' vanished after insert`);
        }
        return created;
      } catch (e) {
        if (isPrimaryKeyConflict(e)) continue;
        throw e;
      }
    }
    throw new DbError("insertItem: could not allocate a backlog item id");
  }

  /**
   * Guarded status transition for `done` / `defer`.
   *
   * A transition into the status the item already holds is an idempotent
   * no-op. Otherwise the current status must be one of `expectedStatuses`
   * — a mismatch (a concurrent writer moved the item, or the requested
   * transition is not allowed from the current status) is a
   * `StateConflictError`. On success the row's `db_revision` is bumped and
   * it is marked `export_status = 'dirty'`.
   */
  updateItemStatus(input: {
    itemId: string;
    expectedStatuses: BacklogStatus[];
    nextStatus: BacklogStatus;
  }): { changed: boolean; status: BacklogStatus } {
    const txn = this.db.transaction(
      (): { changed: boolean; status: BacklogStatus } => {
        const current = this.requireStatus(input.itemId);
        if (current === input.nextStatus) {
          return { changed: false, status: current };
        }
        if (!input.expectedStatuses.includes(current)) {
          throw new StateConflictError(
            input.itemId,
            input.expectedStatuses,
            current,
          );
        }
        const placeholders = input.expectedStatuses.map(() => "?").join(", ");
        const info = this.db
          .prepare(
            `UPDATE backlog_items
               SET status = ?, updated_at = ?, db_revision = db_revision + 1,
                   export_status = 'dirty', last_export_error = NULL
             WHERE item_id = ? AND status IN (${placeholders})`,
          )
          .run(
            input.nextStatus,
            new Date().toISOString(),
            input.itemId,
            ...input.expectedStatuses,
          );
        if (info.changes === 0) {
          throw new StateConflictError(
            input.itemId,
            input.expectedStatuses,
            current,
          );
        }
        return { changed: true, status: input.nextStatus };
      },
    );
    return txn.immediate();
  }

  /**
   * Link a launched run to a backlog item and move the item to `doing`.
   *
   * Idempotent: re-linking the same run is absorbed by the
   * `(item_id, run_id)` primary key, and an item already in `doing` is not
   * re-written. `changed` is false only when nothing moved (the link
   * existed and the item was already `doing`).
   */
  linkRun(input: {
    itemId: string;
    runId: string;
    linkedAt?: string;
  }): { changed: boolean } {
    const linkedAt = input.linkedAt ?? new Date().toISOString();
    const txn = this.db.transaction((): { changed: boolean } => {
      const current = this.requireStatus(input.itemId);
      const linkInfo = this.db
        .prepare(
          `INSERT INTO backlog_run_links (item_id, run_id, linked_at)
           VALUES (?, ?, ?)
           ON CONFLICT (item_id, run_id) DO NOTHING`,
        )
        .run(input.itemId, input.runId, linkedAt);
      const linkAdded = linkInfo.changes > 0;
      const needsMove = current !== "doing";
      if (linkAdded || needsMove) {
        this.db
          .prepare(
            `UPDATE backlog_items
               SET status = 'doing', updated_at = ?,
                   db_revision = db_revision + 1, export_status = 'dirty',
                   last_export_error = NULL
             WHERE item_id = ?`,
          )
          .run(linkedAt, input.itemId);
      }
      return { changed: linkAdded || needsMove };
    });
    return txn.immediate();
  }

  /** Current status of an item, or a `DbError` when it does not exist. */
  private requireStatus(itemId: string): BacklogStatus {
    const r = this.db
      .prepare("SELECT status FROM backlog_items WHERE item_id = ?")
      .get(itemId) as { status: string } | undefined;
    if (r === undefined) {
      throw new DbError(`backlog item '${itemId}' not found in the DB`);
    }
    return r.status as BacklogStatus;
  }
}

/** Build a `BacklogItem` from a row; reads the item's linked runs. */
function rowToItem(row: ItemRow): BacklogItem {
  return {
    id: row.item_id,
    title: row.title,
    domain: row.domain,
    goal: row.goal,
    status: normaliseStatus(row.status),
    priority: normalisePriority(row.priority),
    tags: parseTags(row.tags_json),
    createdAt: row.created_at,
    linkedRuns: [],
    ...(row.project_id !== null && row.project_id !== ""
      ? { projectId: row.project_id }
      : {}),
  };
}

/**
 * A `BacklogItemRecord` plus its linked runs, ordered the way the file
 * model orders `linkedRuns` (insertion order). Kept separate from
 * `getItem` because most callers do not need the run list.
 */
export function getItemWithRuns(
  db: Database.Database,
  itemId: string,
): BacklogItemRecord | null {
  return new BacklogRepository(db).getItemWithRuns(itemId);
}

function backlogWhere(filter: BacklogItemFilter): {
  whereSql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    clauses.push("b.status = ?");
    params.push(filter.status);
  }
  if (filter.projectId !== undefined) {
    clauses.push("b.project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.repoId !== undefined) {
    clauses.push("b.repo_id = ?");
    params.push(filter.repoId);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function normaliseStatus(s: string): BacklogStatus {
  return s === "doing" || s === "done" || s === "deferred" ? s : "open";
}

function normalisePriority(p: string): BacklogPriority {
  return p === "high" || p === "low" ? p : "medium";
}

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

/** True when `e` is a SQLite primary-key uniqueness violation. */
function isPrimaryKeyConflict(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}
