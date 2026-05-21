import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { RunEvent } from "../logging/events.js";
import type { RunLog, RunMeta } from "../logging/run-log.js";
import { bumpRevision } from "./scopes.js";
import { exportRun } from "./export-files.js";

/**
 * DB-backed run log (Phase 7-3) — the DB-first replacement for
 * `createRunLog`.
 *
 * `runDomainCoding` drives a run through stages (run create → codex done
 * → diff verified → finalize). With this `RunLog`, each stage writes the
 * canonical state to the DB (`runs` row + `run_events`) and then exports
 * `meta.json` / `events.jsonl` from the DB via `exportRun`. The DB is the
 * source of truth; the files are its compatibility export.
 *
 * Artifact bodies (`codex-*.log`, `final-diff.patch`, `summary.md`, …)
 * are NOT handled here — they stay file-backed storage written directly
 * into `runDir`, exactly as before. Only run state + events move to the
 * DB in Phase 7.
 *
 * `meta_json` stores the full `meta.json` document losslessly, so the
 * export round-trips even fields the flattened `runs` columns cannot hold
 * (full `project` provenance, the `reviewed` fingerprint).
 */

export interface CreateDbRunLogOpts {
  db: Database.Database;
  runsDir: string;
  runId: string;
  meta: RunMeta;
}

/** snake_case `runs` columns derived from a `RunMeta`. */
function runColumns(meta: RunMeta): Record<string, unknown> {
  return {
    repo_id: meta.repoId,
    project_id: meta.project?.projectId ?? null,
    repo_path: meta.repoPath,
    domain: meta.domain,
    workflow: meta.workflow,
    base_branch: meta.baseBranch,
    base_sha: meta.baseSha,
    run_branch: meta.runBranch,
    status: meta.status,
    safety_status: meta.safetyStatus ?? null,
    reviewer: meta.reviewer ?? null,
    reviewed_at: meta.reviewedAt ?? null,
    started_at: meta.startedAt,
    finished_at: meta.finishedAt ?? null,
    parent_run_id: meta.parentRunId ?? null,
    root_run_id: meta.rootRunId ?? null,
    rerun_attempt: meta.rerunAttempt ?? null,
    changed_files_count: meta.changedFilesCount ?? null,
    ignored_untracked_count: meta.ignoredUntrackedCount ?? null,
    secret_suspect_count: meta.secretSuspectCount ?? null,
    pr_url: meta.prUrl ?? null,
    pr_number: meta.prNumber ?? null,
    prompt_template_name: meta.promptTemplate?.name ?? null,
    prompt_template_version: meta.promptTemplate?.version ?? null,
    knowledge_context_path: meta.knowledgeContext?.contextFile ?? null,
    meta_json: JSON.stringify(meta, null, 2),
  };
}

function insertRunRow(
  db: Database.Database,
  runId: string,
  meta: RunMeta,
): void {
  const cols = runColumns(meta);
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, project_id, repo_path, domain,
       workflow, base_branch, base_sha, run_branch, status, safety_status,
       reviewer, reviewed_at, started_at, finished_at, parent_run_id,
       root_run_id, rerun_attempt, changed_files_count,
       ignored_untracked_count, secret_suspect_count, pr_url, pr_number,
       prompt_template_name, prompt_template_version, knowledge_context_path,
       meta_json, imported_from, updated_at, source_mode, db_revision,
       export_status)
     VALUES (@run_id, @repo_id, @project_id, @repo_path, @domain, @workflow,
       @base_branch, @base_sha, @run_branch, @status, @safety_status,
       @reviewer, @reviewed_at, @started_at, @finished_at, @parent_run_id,
       @root_run_id, @rerun_attempt, @changed_files_count,
       @ignored_untracked_count, @secret_suspect_count, @pr_url, @pr_number,
       @prompt_template_name, @prompt_template_version,
       @knowledge_context_path, @meta_json, 'runtime', @updated_at,
       'db-first', 1, 'dirty')`,
  ).run({ ...cols, run_id: runId, updated_at: new Date().toISOString() });
}

function updateRunRow(
  db: Database.Database,
  runId: string,
  meta: RunMeta,
): void {
  const cols = runColumns(meta);
  db.prepare(
    `UPDATE runs SET
       repo_id = @repo_id, project_id = @project_id, repo_path = @repo_path,
       domain = @domain, workflow = @workflow, base_branch = @base_branch,
       base_sha = @base_sha, run_branch = @run_branch, status = @status,
       safety_status = @safety_status, reviewer = @reviewer,
       reviewed_at = @reviewed_at, started_at = @started_at,
       finished_at = @finished_at, parent_run_id = @parent_run_id,
       root_run_id = @root_run_id, rerun_attempt = @rerun_attempt,
       changed_files_count = @changed_files_count,
       ignored_untracked_count = @ignored_untracked_count,
       secret_suspect_count = @secret_suspect_count, pr_url = @pr_url,
       pr_number = @pr_number, prompt_template_name = @prompt_template_name,
       prompt_template_version = @prompt_template_version,
       knowledge_context_path = @knowledge_context_path,
       meta_json = @meta_json, updated_at = @updated_at
     WHERE run_id = @run_id`,
  ).run({ ...cols, run_id: runId, updated_at: new Date().toISOString() });
}

function appendEvent(
  db: Database.Database,
  runId: string,
  event: RunEvent,
): void {
  const seq = (
    db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?",
      )
      .get(runId) as { next: number }
  ).next;
  // `events.jsonl` lines carry no timestamp; mirror the importer which
  // reads `occurredAt` / `at` when present and otherwise stores null.
  const occurredAt =
    typeof event.occurredAt === "string"
      ? event.occurredAt
      : typeof event.at === "string"
        ? event.at
        : null;
  db.prepare(
    `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, seq, event.type, occurredAt, JSON.stringify(event));
}

function writeCommandResults(
  db: Database.Database,
  runId: string,
  results: NonNullable<RunMeta["commandResults"]>,
): void {
  db.prepare("DELETE FROM command_results WHERE run_id = ?").run(runId);
  const insert = db.prepare(
    `INSERT INTO command_results (run_id, command_index, command, exit_code,
       duration_ms, timed_out)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  results.forEach((r, i) => {
    insert.run(runId, i, r.command, r.exitCode, r.durationMs, r.timedOut ? 1 : 0);
  });
}

/**
 * Create a DB-first run log. Inserts the `runs` row (`source_mode =
 * 'db-first'`), creates the run directory for artifact bodies, and
 * exports the initial `meta.json`. Every later mutation writes the DB and
 * re-exports the affected files.
 */
export function createDbRunLog(opts: CreateDbRunLogOpts): RunLog {
  const { db, runsDir, runId } = opts;
  const runDir = join(runsDir, runId);
  // exclusive create on the run dir: a run-id collision must fail loudly,
  // not silently reuse a directory with stale artifact bodies.
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(runDir, { recursive: false });

  let meta: RunMeta = opts.meta;
  insertRunRow(db, runId, meta);
  exportRun(db, runId, { runsDir });

  /** apply a DB write in one transaction, then export the files. */
  function commitThenExport(write: () => void): void {
    db.transaction(write).immediate();
    exportRun(db, runId, { runsDir });
  }

  function persist(next: RunMeta): void {
    meta = next;
    commitThenExport(() => {
      updateRunRow(db, runId, meta);
      bumpRevision(db, "run", runId);
    });
  }

  return {
    runDir,
    // `async` so any synchronous DB throw surfaces as a Promise rejection
    // (callers `.catch()` these on the failure path).
    async emit(event: RunEvent): Promise<void> {
      commitThenExport(() => {
        appendEvent(db, runId, event);
        bumpRevision(db, "run", runId);
      });
    },
    async setStatus(status): Promise<void> {
      persist({ ...meta, status });
    },
    async setSafetyStatus(safetyStatus): Promise<void> {
      persist({ ...meta, safetyStatus });
    },
    async setReviewerInfo({ reviewer, reviewedAt }): Promise<void> {
      persist({ ...meta, reviewer, reviewedAt });
    },
    async finalize(p): Promise<void> {
      meta = {
        ...meta,
        status: p.status,
        safetyStatus: p.safetyStatus,
        ignoredUntrackedCount: p.ignoredUntrackedCount,
        secretSuspectCount: p.secretSuspectCount,
        commandResults: p.commandResults,
        changedFilesCount: p.changedFilesCount,
        ...(p.reviewed ? { reviewed: p.reviewed } : {}),
        finishedAt: p.finishedAt,
      };
      commitThenExport(() => {
        writeCommandResults(db, runId, p.commandResults);
        updateRunRow(db, runId, meta);
        bumpRevision(db, "run", runId);
      });
    },
  };
}
