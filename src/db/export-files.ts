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
  scopeType: "run";
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
  const row = db
    .prepare("SELECT * FROM runs WHERE run_id = ?")
    .get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new DbError(`exportRun: no run '${runId}'`);
  }
  const dbRevision = (row.db_revision as number | null) ?? 0;
  const runDir = join(opts.runsDir, runId);
  const startedAt = new Date().toISOString();

  try {
    beginExporting(runDir);
    const files: ExportedFileInfo[] = [];

    const metaContent = `${JSON.stringify(reconstructMeta(db, row), null, 2)}\n`;
    atomicWriteFile(join(runDir, "meta.json"), metaContent);
    files.push(describeExportedFile("meta.json", metaContent));

    const eventLines = (
      db
        .prepare(
          "SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq",
        )
        .all(runId) as { payload_json: string }[]
    ).map((r) => r.payload_json);
    if (eventLines.length > 0) {
      const eventsContent = `${eventLines.join("\n")}\n`;
      atomicWriteFile(join(runDir, "events.jsonl"), eventsContent);
      files.push(describeExportedFile("events.jsonl", eventsContent));
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
