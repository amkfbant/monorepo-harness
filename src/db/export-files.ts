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
import { KnowledgeRepository } from "./repositories/knowledge.js";
import { readArtifactBlob } from "./artifact-blobs.js";
import { findBlobStore } from "./blob-stores.js";
import { fileExportEnabled } from "../config/export-mode.js";
import { buildReviewDecision } from "../reporter/review-decision.js";
import { LocalBlobStore } from "../storage/local-blob-store.js";

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
 * `command_results`) and `events.jsonl` from `run_events`, and writes
 * `storage='db'` artifact bodies back from `artifact_blobs` (Phase 8).
 *
 * Phase 8-5: file export is opt-out. When `fileExportEnabled()` is false
 * the export functions skip the file writes, mark the scope row
 * `export_status='disabled'`, and return `status: "disabled"`. An
 * explicit `harness db export-files` passes `force` to export anyway.
 */

export interface ExportResult {
  scopeType: "run" | "backlog_item" | "knowledge_entry";
  scopeId: string;
  /** `disabled` — file export is opt-out and OFF (Phase 8-5, DB-only). */
  status: "synced" | "failed" | "disabled";
  /** the `db_revision` the export targeted */
  dbRevision: number;
  files: ExportedFileInfo[];
  /** present only when `status === "failed"` */
  error?: string;
}

/**
 * Mark a scope row `export_status='disabled'` — file export is opt-out
 * and OFF, so the (absent) files are not drift (Phase 8-5).
 *
 * The scope's `exported_files` rows are cleared too: a row previously
 * exported under export ON would otherwise leave stale tracked files that
 * `check-consistency` flags as `missing-file` once they are removed.
 */
function markExportDisabled(
  db: Database.Database,
  table: "runs" | "backlog_items",
  idColumn: "run_id" | "item_id",
  id: string,
): void {
  const scopeType = table === "runs" ? "run" : "backlog_item";
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE ${table} SET export_status = 'disabled', last_export_error = NULL
       WHERE ${idColumn} = ?`,
    ).run(id);
    db.prepare(
      "DELETE FROM exported_files WHERE scope_type = ? AND scope_id = ?",
    ).run(scopeType, id);
  });
  txn();
}

/**
 * Export one run's DB-canonical state to `runs/<runId>/`. Never throws on
 * a file-write failure — returns `status: "failed"` with the recorded
 * error. Throws `DbError` only when the run does not exist in the DB.
 *
 * Phase 9 post-close (second review) P1-1 fix — `trackExport: false`
 * separates a **scratch materialization** (review auto / DB-only viewer
 * fallback) from a real compatibility export. With `trackExport: false`:
 *   - files are still written
 *   - `exported_files` is **not** updated
 *   - `runs.export_status` is **not** flipped to `synced`
 *   - the run's prior export tracking is left untouched
 * This is necessary for export-OFF runtime: a materialized scratch dir
 * must not be advertised as a compatibility export, or `run show` (file
 * first) would render stale meta.json and the operator would not be able
 * to tell which is canonical.
 */
export function exportRun(
  db: Database.Database,
  runId: string,
  opts: { runsDir: string; force?: boolean; trackExport?: boolean },
): ExportResult {
  const trackExport = opts.trackExport !== false;
  if (opts.force !== true && !fileExportEnabled()) {
    const rev = db
      .prepare("SELECT db_revision FROM runs WHERE run_id = ?")
      .get(runId) as { db_revision: number | null } | undefined;
    if (rev === undefined) throw new DbError(`exportRun: no run '${runId}'`);
    if (trackExport) markExportDisabled(db, "runs", "run_id", runId);
    return {
      scopeType: "run",
      scopeId: runId,
      status: "disabled",
      dbRevision: rev.db_revision ?? 0,
      files: [],
    };
  }
  // read the run + its events as one consistent snapshot, so an export
  // can never mix a row at one revision with events at another.
  const snapshot = db.transaction(
    ():
      | {
          row: Record<string, unknown>;
          eventLines: string[];
          reviewYaml: string | null;
          proposalYaml: string | null;
          artifacts: {
            relative_path: string;
            blob_sha256: string;
            storage: string;
            uri: string | null;
            store_id: string | null;
          }[];
        }
      | undefined => {
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
      // `review-decision.yaml` is the compatibility export of the
      // DB-canonical `review_decisions` row (Phase 7 — P1-2). `source_yaml`
      // holds the normalized decision document verbatim.
      const rev = db
        .prepare(
          "SELECT source_yaml FROM review_decisions WHERE run_id = ?",
        )
        .get(runId) as { source_yaml: string | null } | undefined;
      // Phase 9 post-close (second review) P1-2 fix — when no
      // `review_decisions` row exists yet, surface the active
      // `review_proposals` row as the compatibility sidecar. Without this,
      // `db export-files` would emit a `pending` template even though
      // `review auto` already wrote a DB-canonical proposal — and the
      // operator (or a re-materialize) would see a stale pending YAML.
      const proposal = db
        .prepare(
          `SELECT source_yaml FROM review_proposals
            WHERE run_id = ?
              AND superseded_at IS NULL
              AND processed_at IS NULL
            ORDER BY reviewed_at DESC, proposal_id DESC LIMIT 1`,
        )
        .get(runId) as { source_yaml: string | null } | undefined;
      // DB/external-stored artifact bodies — exported from artifact_blobs
      // or the Phase 17 external-local object store.
      const artifacts = db
        .prepare(
          `SELECT a.relative_path, a.blob_sha256, a.storage, e.uri,
                  e.store_id
             FROM artifacts a
             LEFT JOIN external_artifact_blobs e ON e.sha256 = a.blob_sha256
            WHERE a.run_id = ?
              AND a.storage IN ('db', 'external')
              AND a.blob_sha256 IS NOT NULL
              AND a.relative_path IS NOT NULL`,
        )
        .all(runId) as {
        relative_path: string;
        blob_sha256: string;
        storage: string;
        uri: string | null;
        store_id: string | null;
      }[];
      return {
        row: r,
        eventLines,
        reviewYaml: rev?.source_yaml ?? null,
        proposalYaml: proposal?.source_yaml ?? null,
        artifacts,
      };
    },
  )();
  if (snapshot === undefined) {
    throw new DbError(`exportRun: no run '${runId}'`);
  }
  const { row, eventLines, reviewYaml, proposalYaml, artifacts } = snapshot;
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

    // a reviewed run re-exports `review-decision.yaml` from the DB
    // (Phase 7 — P1-2). Priority order:
    //   1. `review_decisions.source_yaml` (a processed proposal — final
    //      decision is canonical)
    //   2. active `review_proposals.source_yaml` (Phase 9 post-close
    //      P1-2 fix — `review auto` wrote the verdict to the DB, sidecar
    //      reflects it)
    //   3. pending template for a `needs_review` run with no proposal yet
    if (reviewYaml !== null) {
      const reviewContent = reviewYaml.endsWith("\n")
        ? reviewYaml
        : `${reviewYaml}\n`;
      atomicWriteFile(join(runDir, "review-decision.yaml"), reviewContent);
      files.push(describeExportedFile("review-decision.yaml", reviewContent));
    } else if (proposalYaml !== null) {
      const proposalContent = proposalYaml.endsWith("\n")
        ? proposalYaml
        : `${proposalYaml}\n`;
      atomicWriteFile(join(runDir, "review-decision.yaml"), proposalContent);
      files.push(
        describeExportedFile("review-decision.yaml", proposalContent),
      );
    } else if (row.status === "needs_review") {
      // not yet reviewed — synthesize the pending `review-decision.yaml`
      // template (runId + domain) so `db export-files` can materialize it
      // for the operator in DB-only mode (Phase 8 — 8-2 P1-2).
      const pending = buildReviewDecision({
        runId,
        domain: String(row.domain ?? ""),
      });
      const pendingContent = pending.endsWith("\n")
        ? pending
        : `${pending}\n`;
      atomicWriteFile(join(runDir, "review-decision.yaml"), pendingContent);
      files.push(
        describeExportedFile("review-decision.yaml", pendingContent),
      );
    }

    // db/external-stored artifact bodies — written back so
    // `db export-files` restores them and export ON keeps the run dir
    // complete.
    for (const a of artifacts) {
      const body =
        a.storage === "external"
          ? readExternalLocalArtifact(db, a.relative_path, a.blob_sha256)
          : readArtifactBlob(db, a.blob_sha256);
      if (body === null) {
        // a `storage='db'` artifact whose blob is gone is DB corruption,
        // not recoverable drift — fail the export loudly (P1).
        throw new DbError(
          `exportRun: artifact '${a.relative_path}' references a missing ` +
            `blob ${a.blob_sha256}`,
        );
      }
      atomicWriteFile(join(runDir, a.relative_path), body);
      files.push(describeExportedFile(a.relative_path, body));
    }

    endExporting(runDir);
    if (trackExport) {
      recordExportSuccess(db, {
        scopeType: "run",
        scopeId: runId,
        dbRevision,
        startedAt,
        files,
      });
    }
    return { scopeType: "run", scopeId: runId, status: "synced", dbRevision, files };
  } catch (e) {
    const error = (e as Error).message;
    if (trackExport) {
      recordExportFailure(db, {
        scopeType: "run",
        scopeId: runId,
        dbRevision,
        startedAt,
        error,
      });
    }
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

function readExternalLocalArtifact(
  db: Database.Database,
  relativePath: string,
  blobSha256: string,
): Buffer | null {
  const external = db
    .prepare(
      `SELECT sha256, store_id, uri, status
         FROM external_artifact_blobs
        WHERE sha256 = ?`,
    )
    .get(blobSha256) as
    | { sha256: string; store_id: string; uri: string; status: string }
    | undefined;
  if (external === undefined || external.status !== "available") return null;
  const storeRow = findBlobStore(db, external.store_id);
  if (storeRow === null || storeRow.storeType !== "local") return null;
  const config = JSON.parse(storeRow.configJson) as { root?: unknown };
  if (typeof config.root !== "string") return null;
  try {
    return new LocalBlobStore({ root: config.root }).getSync({
      sha256: blobSha256,
      uri: external.uri,
    });
  } catch (e) {
    throw new DbError(
      `exportRun: external artifact '${relativePath}' references unreadable ` +
        `blob ${blobSha256}: ${(e as Error).message}`,
    );
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
  opts: { backlogDir: string; force?: boolean },
): ExportResult {
  if (opts.force !== true && !fileExportEnabled()) {
    const rev = db
      .prepare("SELECT db_revision FROM backlog_items WHERE item_id = ?")
      .get(itemId) as { db_revision: number | null } | undefined;
    if (rev === undefined) {
      throw new DbError(`exportBacklogItem: no item '${itemId}'`);
    }
    markExportDisabled(db, "backlog_items", "item_id", itemId);
    return {
      scopeType: "backlog_item",
      scopeId: itemId,
      status: "disabled",
      dbRevision: rev.db_revision ?? 0,
      files: [],
    };
  }
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
 * Surface a failed run export as a strong stderr warning (Phase 7 design:
 * a DB commit succeeds + an export fails → exit 0 + warning). The DB stays
 * canonical; `db export-files` / `check-consistency` recover the files.
 * Shared by every `exportRun` caller so the behaviour is consistent.
 */
export function warnIfExportFailed(result: ExportResult): void {
  if (result.status === "failed") {
    process.stderr.write(
      `warning: run ${result.scopeId}: the DB was updated but exporting ` +
        `runs/${result.scopeId}/ failed: ${result.error ?? "unknown error"}` +
        ` — run \`harness db export-files --scope run --id ${result.scopeId}\`\n`,
    );
  }
}

/** Per-run result of re-projecting a `knowledge-decisions.yaml` sidecar. */
export interface KnowledgeDecisionsExportResult {
  runId: string;
  status: "synced" | "failed" | "disabled";
  error?: string;
}

/**
 * Re-project a run's `knowledge-decisions.yaml` from the DB-canonical
 * candidate decision state (Phase 7-9 / 7-11 bulk re-export).
 *
 * A knowledge candidate's *decision* (reject) is DB-canonical; the sidecar
 * is its file projection. The promoted entry's `.md` body, by contrast, is
 * file-backed (the `.md` is the artifact) — it is NOT re-exported from the
 * DB. Never throws on a file-write failure: the failure is recorded on the
 * affected candidate rows so `check-consistency` / a re-run recovers it.
 */
export function exportKnowledgeDecisions(
  db: Database.Database,
  runId: string,
  opts: { runsDir: string; force?: boolean },
): KnowledgeDecisionsExportResult {
  const repo = new KnowledgeRepository(db);
  if (opts.force !== true && !fileExportEnabled()) {
    // file export OFF — the rejected candidates' decision is DB-canonical;
    // mark them disabled and clear the sidecar's tracked files so the
    // absent `knowledge-decisions.yaml` is not flagged as drift.
    const txn = db.transaction(() => {
      db.prepare(
        `UPDATE knowledge_candidates SET export_status = 'disabled',
           last_export_error = NULL
         WHERE run_id = ? AND status = 'rejected'`,
      ).run(runId);
      db.prepare(
        `DELETE FROM exported_files
         WHERE scope_type = 'knowledge_decisions' AND scope_id = ?`,
      ).run(runId);
    });
    txn();
    return { runId, status: "disabled" };
  }
  const rows = db
    .prepare(
      `SELECT candidate_id, reviewer, reason, decided_at
       FROM knowledge_candidates
       WHERE run_id = ? AND status = 'rejected'
       ORDER BY candidate_id`,
    )
    .all(runId) as {
    candidate_id: string;
    reviewer: string | null;
    reason: string | null;
    decided_at: string | null;
  }[];
  const entries = rows
    .map((r) => ({
      index: candidateIndex(r.candidate_id),
      decision: "rejected",
      reviewer: r.reviewer ?? "",
      reason: r.reason ?? "",
      decidedAt: r.decided_at ?? "",
    }))
    .sort((a, b) => a.index - b.index);
  const content =
    "decisions:\n" +
    entries
      .map((d) =>
        Object.entries(d)
          .map(
            ([k, v], idx) =>
              `${idx === 0 ? "  - " : "    "}${k}: ${JSON.stringify(v)}`,
          )
          .join("\n"),
      )
      .join("\n") +
    "\n";
  const startedAt = new Date().toISOString();
  try {
    atomicWriteFile(
      join(opts.runsDir, runId, "knowledge-decisions.yaml"),
      content,
    );
    for (const r of rows) repo.markCandidateExported(r.candidate_id);
    // record the sidecar in `exported_files` so `check-consistency` can
    // sha256-compare it and detect a hand-edited / deleted file (P1-6).
    recordExportSuccess(db, {
      scopeType: "knowledge_decisions",
      scopeId: runId,
      dbRevision: 0,
      startedAt,
      files: [describeExportedFile("knowledge-decisions.yaml", content)],
    });
    return { runId, status: "synced" };
  } catch (e) {
    const error = (e as Error).message;
    for (const r of rows) repo.markCandidateExportFailed(r.candidate_id, error);
    recordExportFailure(db, {
      scopeType: "knowledge_decisions",
      scopeId: runId,
      dbRevision: 0,
      startedAt,
      error,
    });
    return { runId, status: "failed", error };
  }
}

/** The candidate's list index, parsed from a `<runId>:<index>` id. */
function candidateIndex(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(":") + 1));
  return Number.isInteger(n) && n >= 0 ? n : 0;
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
