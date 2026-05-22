import { rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { DbError } from "./connection.js";
import { atomicWriteFile, beginExporting, endExporting } from "./atomic-write.js";
import {
  describeExportedFile,
  recordExportSuccess,
  recordExportFailure,
  type ExportedFileInfo,
} from "./export-records.js";
import {
  serialiseBacklogItem,
  type BacklogItem,
  type BacklogStatus,
} from "../core/backlog.js";

/** The four backlog status dirs — the one a db-first item is exported to. */
const BACKLOG_STATUSES: readonly BacklogStatus[] = [
  "open",
  "doing",
  "done",
  "deferred",
];

/**
 * Scoped export engine (Phase 7-2) — the inverse of `import-files.ts`.
 *
 * A DB-first command commits to the DB (canonical) then calls an export
 * function to write the affected scope's files (compatibility export).
 * Files are written atomically; the outcome is tracked in
 * `export_records` / `exported_files`. An export failure does NOT throw:
 * the DB is already correct, so the failure is recorded as a warning and
 * `check-consistency` / a re-export recovers the stale files.
 *
 * `exportRun` reconstructs `meta.json` from the `runs` row (+
 * `command_results`) and `events.jsonl` from `run_events`. Artifact
 * bodies (codex logs, patches) stay file-backed storage — they are not
 * in the DB and `exportRun` does not touch them.
 */

export interface ExportResult {
  scopeType: "run" | "backlog_item" | "knowledge_entry";
  scopeId: string;
  status: "synced" | "failed";
  /** the `db_revision` the export targeted */
  dbRevision: number;
  files: ExportedFileInfo[];
  /** present only when `status === "failed"` */
  error?: string;
}

/**
 * Export one run's DB-canonical state to `runs/<runId>/`. Never throws on
 * a file-write failure — returns `status: "failed"` with the recorded
 * error. Throws `DbError` only when the run does not exist in the DB.
 */
export function exportRun(
  db: Database.Database,
  runId: string,
  opts: { runsDir: string },
): ExportResult {
  // read the run + its events as one consistent snapshot, so an export
  // can never mix a row at one revision with events at another.
  const snapshot = db.transaction(
    (): { row: Record<string, unknown>; eventLines: string[] } | undefined => {
      const r = db
        .prepare("SELECT * FROM runs WHERE run_id = ?")
        .get(runId) as Record<string, unknown> | undefined;
      if (r === undefined) return undefined;
      const eventLines = (
        db
          .prepare(
            "SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq",
          )
          .all(runId) as { payload_json: string }[]
      ).map((e) => e.payload_json);
      return { row: r, eventLines };
    },
  )();
  if (snapshot === undefined) {
    throw new DbError(`exportRun: no run '${runId}'`);
  }
  const { row, eventLines } = snapshot;
  const dbRevision = (row.db_revision as number | null) ?? 0;
  const runDir = join(opts.runsDir, runId);
  const startedAt = new Date().toISOString();

  try {
    beginExporting(runDir);
    const files: ExportedFileInfo[] = [];

    // a DB-first run stores its canonical meta.json verbatim in
    // `meta_json` (lossless); a legacy / file-imported row has none, so
    // meta.json is reconstructed from the flattened columns.
    const metaJson = row.meta_json;
    const metaContent =
      typeof metaJson === "string"
        ? `${metaJson}\n`
        : `${JSON.stringify(reconstructMeta(db, row), null, 2)}\n`;
    atomicWriteFile(join(runDir, "meta.json"), metaContent);
    files.push(describeExportedFile("meta.json", metaContent));

    const eventsPath = join(runDir, "events.jsonl");
    if (eventLines.length > 0) {
      const eventsContent = `${eventLines.join("\n")}\n`;
      atomicWriteFile(eventsPath, eventsContent);
      files.push(describeExportedFile("events.jsonl", eventsContent));
    } else {
      // a run with no events must not keep a stale events.jsonl that a
      // later file import would resurrect events from.
      rmSync(eventsPath, { force: true });
    }

    endExporting(runDir);
    recordExportSuccess(db, {
      scopeType: "run",
      scopeId: runId,
      dbRevision,
      startedAt,
      files,
    });
    return { scopeType: "run", scopeId: runId, status: "synced", dbRevision, files };
  } catch (e) {
    const error = (e as Error).message;
    recordExportFailure(db, {
      scopeType: "run",
      scopeId: runId,
      dbRevision,
      startedAt,
      error,
    });
    return {
      scopeType: "run",
      scopeId: runId,
      status: "failed",
      dbRevision,
      files: [],
      error,
    };
  }
}

/**
 * Export one backlog item's DB-canonical state to `backlog/<status>/
 * <itemId>.yaml`.
 *
 * A backlog item carries its status in the directory it lives in, so the
 * export is a move: the YAML is written (atomically) into the dir for the
 * item's current DB status, then any stale copy in the other three status
 * dirs is removed. The new file is written before the old ones are
 * deleted, so a crash mid-export leaves the item discoverable (in two
 * dirs at worst) rather than lost — a re-export then reconciles it.
 *
 * Like `exportRun`, never throws on a file-write failure: the DB is
 * canonical, so the failure is recorded and returned as `status: failed`.
 * Throws `DbError` only when the item does not exist in the DB.
 */
export function exportBacklogItem(
  db: Database.Database,
  itemId: string,
  opts: { backlogDir: string },
): ExportResult {
  // read the item row + its links as one consistent snapshot.
  const snapshot = db.transaction(
    ():
      | { item: BacklogItem; status: BacklogStatus; dbRevision: number }
      | undefined => {
      const r = db
        .prepare(
          `SELECT item_id, project_id, domain, title, goal, status, priority,
                  tags_json, created_at, db_revision
           FROM backlog_items WHERE item_id = ?`,
        )
        .get(itemId) as Record<string, unknown> | undefined;
      if (r === undefined) return undefined;
      const links = (
        db
          .prepare(
            `SELECT run_id FROM backlog_run_links WHERE item_id = ?
             ORDER BY linked_at, run_id`,
          )
          .all(itemId) as { run_id: string }[]
      ).map((l) => l.run_id);
      const status = backlogStatusOf(r.status);
      const tags = parseTagsJson(r.tags_json);
      const item: BacklogItem = {
        id: r.item_id as string,
        title: (r.title as string | null) ?? "",
        domain: (r.domain as string | null) ?? "",
        goal: (r.goal as string | null) ?? "",
        status,
        priority: backlogPriorityOf(r.priority),
        tags,
        createdAt: (r.created_at as string | null) ?? "",
        linkedRuns: links,
        ...(typeof r.project_id === "string" && r.project_id !== ""
          ? { projectId: r.project_id }
          : {}),
      };
      return { item, status, dbRevision: (r.db_revision as number | null) ?? 0 };
    },
  )();
  if (snapshot === undefined) {
    throw new DbError(`exportBacklogItem: no backlog item '${itemId}'`);
  }
  const { item, status, dbRevision } = snapshot;
  const startedAt = new Date().toISOString();
  const relativePath = join(status, `${itemId}.yaml`);

  try {
    const content = serialiseBacklogItem(item);
    atomicWriteFile(join(opts.backlogDir, relativePath), content);
    // remove any stale copy left in the other status dirs — the DB status
    // is authoritative for which dir the item belongs in.
    for (const other of BACKLOG_STATUSES) {
      if (other === status) continue;
      rmSync(join(opts.backlogDir, other, `${itemId}.yaml`), { force: true });
    }
    const files = [describeExportedFile(relativePath, content)];
    recordExportSuccess(db, {
      scopeType: "backlog_item",
      scopeId: itemId,
      dbRevision,
      startedAt,
      files,
    });
    return {
      scopeType: "backlog_item",
      scopeId: itemId,
      status: "synced",
      dbRevision,
      files,
    };
  } catch (e) {
    const error = (e as Error).message;
    recordExportFailure(db, {
      scopeType: "backlog_item",
      scopeId: itemId,
      dbRevision,
      startedAt,
      error,
    });
    return {
      scopeType: "backlog_item",
      scopeId: itemId,
      status: "failed",
      dbRevision,
      files: [],
      error,
    };
  }
}

function backlogStatusOf(v: unknown): BacklogStatus {
  return v === "doing" || v === "done" || v === "deferred" ? v : "open";
}

function backlogPriorityOf(v: unknown): BacklogItem["priority"] {
  return v === "high" || v === "low" ? v : "medium";
}

function parseTagsJson(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Export one promoted knowledge entry's DB-canonical manifest to its
 * `docs/knowledge/<kind>/*.md` file (Phase 7-11 bulk re-export).
 *
 * The markdown is reconstructed from the `knowledge_entries` row — the
 * frontmatter from `frontmatter_json`, the body from `body`. Like the
 * other exporters it never throws on a file-write failure; throws
 * `DbError` only when the entry does not exist.
 */
export function exportKnowledgeEntry(
  db: Database.Database,
  entryId: string,
  opts: { harnessRoot: string },
): ExportResult {
  const row = db
    .prepare(
      `SELECT path, body, frontmatter_json, db_revision
       FROM knowledge_entries WHERE entry_id = ?`,
    )
    .get(entryId) as
    | {
        path: string | null;
        body: string;
        frontmatter_json: string | null;
        db_revision: number | null;
      }
    | undefined;
  if (row === undefined) {
    throw new DbError(`exportKnowledgeEntry: no knowledge entry '${entryId}'`);
  }
  const dbRevision = row.db_revision ?? 0;
  const relPath = row.path ?? entryId;
  const startedAt = new Date().toISOString();
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed =
      row.frontmatter_json !== null
        ? (JSON.parse(row.frontmatter_json) as unknown)
        : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    frontmatter = {};
  }

  try {
    const content = `${renderKnowledgeFrontmatter(frontmatter)}${row.body}`;
    atomicWriteFile(join(opts.harnessRoot, relPath), content);
    const files = [describeExportedFile(relPath, content)];
    recordExportSuccess(db, {
      scopeType: "knowledge_entry",
      scopeId: entryId,
      dbRevision,
      startedAt,
      files,
    });
    return {
      scopeType: "knowledge_entry",
      scopeId: entryId,
      status: "synced",
      dbRevision,
      files,
    };
  } catch (e) {
    const error = (e as Error).message;
    recordExportFailure(db, {
      scopeType: "knowledge_entry",
      scopeId: entryId,
      dbRevision,
      startedAt,
      error,
    });
    return {
      scopeType: "knowledge_entry",
      scopeId: entryId,
      status: "failed",
      dbRevision,
      files: [],
      error,
    };
  }
}

/**
 * Serialise a knowledge entry's frontmatter as the `--- ... ---\n` block.
 * The standard promote keys are rendered in their canonical order and
 * format (matching `buildPromotedMarkdown`); any other key is appended
 * as JSON so a hand-edited entry still round-trips.
 */
function renderKnowledgeFrontmatter(fm: Record<string, unknown>): string {
  const RAW = new Set(["kind", "source_run", "source_index", "hash"]);
  const ORDER = [
    "kind",
    "domain",
    "title",
    "source_run",
    "source_index",
    "confidence",
    "source_status",
    "promoted_by",
    "promoted_at",
    "deprecated",
    "hash",
  ];
  const lines: string[] = ["---"];
  const emit = (k: string, v: unknown): void => {
    if (v === undefined) return;
    if (k === "deprecated") lines.push(`deprecated: ${v === true}`);
    else if (RAW.has(k)) lines.push(`${k}: ${String(v)}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  };
  for (const k of ORDER) if (k in fm) emit(k, fm[k]);
  for (const k of Object.keys(fm)) if (!ORDER.includes(k)) emit(k, fm[k]);
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/** ---- meta.json reconstruction ------------------------------------- */

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * Rebuild a `meta.json` object from a `runs` row. The inverse of the
 * importer's `runRow`: only fields the v1 `runs` columns hold are
 * reproduced, and a null column is omitted (mirroring how `createRunLog`
 * omits absent optional fields). Fields the columns cannot hold (the full
 * `project` provenance, the `reviewed` fingerprint) are necessarily
 * lossy — round-trip equality is therefore normalized, not byte-exact.
 */
function reconstructMeta(
  db: Database.Database,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined) meta[key] = value;
  };

  put("runId", str(row.run_id));
  put("repoId", str(row.repo_id));
  put("repoPath", str(row.repo_path));
  put("domain", str(row.domain));
  put("workflow", str(row.workflow));
  put("baseBranch", str(row.base_branch));
  put("baseSha", str(row.base_sha));
  put("runBranch", str(row.run_branch));
  put("status", str(row.status));
  put("safetyStatus", str(row.safety_status));
  put("ignoredUntrackedCount", num(row.ignored_untracked_count));
  put("secretSuspectCount", num(row.secret_suspect_count));
  put("reviewer", str(row.reviewer));
  put("reviewedAt", str(row.reviewed_at));

  const commands = db
    .prepare(
      `SELECT command, exit_code, duration_ms, timed_out
       FROM command_results WHERE run_id = ? ORDER BY command_index`,
    )
    .all(row.run_id as string) as {
    command: string;
    exit_code: number | null;
    duration_ms: number | null;
    timed_out: number;
  }[];
  if (commands.length > 0) {
    meta.commandResults = commands.map((c) => ({
      command: c.command,
      exitCode: c.exit_code ?? 0,
      durationMs: c.duration_ms ?? 0,
      timedOut: c.timed_out === 1,
    }));
  }

  put("changedFilesCount", num(row.changed_files_count));
  put("parentRunId", str(row.parent_run_id));
  put("rootRunId", str(row.root_run_id));
  put("rerunAttempt", num(row.rerun_attempt));

  const knowledgeContextPath = str(row.knowledge_context_path);
  if (knowledgeContextPath !== null) {
    meta.knowledgeContext = { enabled: true, contextFile: knowledgeContextPath };
  }
  const templateName = str(row.prompt_template_name);
  const templateVersion = num(row.prompt_template_version);
  if (templateName !== null && templateVersion !== null) {
    meta.promptTemplate = { name: templateName, version: templateVersion };
  }
  put("prUrl", str(row.pr_url));
  put("prNumber", num(row.pr_number));

  const projectId = str(row.project_id);
  if (projectId !== null) meta.project = { projectId };

  put("startedAt", str(row.started_at));
  put("finishedAt", str(row.finished_at));
  return meta;
}
