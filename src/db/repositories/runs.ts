import type Database from "better-sqlite3";
import { DbError } from "../connection.js";
import { StateConflictError } from "../errors.js";
import { findOperation, recordOperation } from "./operations.js";

/**
 * Run repository (Phase 6-5, write methods Phase 7).
 *
 * The DB-backed query layer for runs. SQL lives here; the dashboard and
 * CLI summaries see only these methods. All filtering goes through
 * `RunFilter`, so a stale-index problem cannot arise — the source is the
 * DB read model, rebuilt by `db import`.
 *
 * Phase 7 adds write methods. `updateRunStatus` is the guarded
 * status-transition primitive every DB-first command shares.
 */

export interface RunFilter {
  projectId?: string;
  repoId?: string;
  domain?: string;
  statuses?: string[];
  /** ISO lower bound on started_at (inclusive) */
  since?: string;
  /** ISO upper bound on started_at (inclusive) */
  until?: string;
  reviewer?: string;
  safetyStatus?: string;
  limit?: number;
  offset?: number;
}

/** One row of the dashboard run list. */
export interface DashboardRunSummary {
  runId: string;
  repoId: string;
  projectId: string | null;
  domain: string;
  status: string;
  safetyStatus: string | null;
  reviewer: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  rerunAttempt: number | null;
  prUrl: string | null;
}

/** Full run row for the run-detail view. */
export interface RunDetail extends DashboardRunSummary {
  repoPath: string | null;
  workflow: string;
  baseBranch: string;
  baseSha: string | null;
  runBranch: string | null;
  reviewedAt: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  changedFilesCount: number | null;
  ignoredUntrackedCount: number | null;
  secretSuspectCount: number | null;
  prNumber: number | null;
  promptTemplateName: string | null;
  promptTemplateVersion: number | null;
  knowledgeContextPath: string | null;
}

export interface RunTimelineEvent {
  seq: number;
  type: string;
  occurredAt: string | null;
  payload: unknown;
}

export interface RerunChainNode {
  runId: string;
  parentRunId: string | null;
  rootRunId: string | null;
  rerunAttempt: number | null;
  status: string;
}

export interface CommandResultRow {
  commandIndex: number;
  command: string;
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
}

export interface ReviewDecisionRow {
  decision: string;
  reviewer: string | null;
  summary: string | null;
  reviewedAt: string | null;
  requiredChanges: string[];
}

/** Input to the guarded run status transition. */
export interface UpdateRunStatusInput {
  runId: string;
  /** the transition succeeds only if the current status is one of these */
  expectedStatuses: string[];
  nextStatus: string;
  /** `run_events.type` for the appended lifecycle event */
  eventType: string;
  actor?: string;
  /** when set, a replay of the same id is an idempotent no-op */
  operationId?: string;
  /** ISO timestamp; defaults to now */
  occurredAt?: string;
}

export interface UpdateRunStatusResult {
  /** false when an operation-id replay made this an idempotent no-op */
  changed: boolean;
  /** the run's status after the call */
  status: string;
}

const SUMMARY_COLUMNS = `run_id, repo_id, project_id, domain, status,
  safety_status, reviewer, started_at, finished_at, rerun_attempt, pr_url`;

interface SummaryRow {
  run_id: string;
  repo_id: string;
  project_id: string | null;
  domain: string;
  status: string;
  safety_status: string | null;
  reviewer: string | null;
  started_at: string | null;
  finished_at: string | null;
  rerun_attempt: number | null;
  pr_url: string | null;
}

/** Build the parameterized WHERE clause shared by listRuns / countRuns. */
function buildWhere(filter: RunFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.repoId !== undefined) {
    where.push("repo_id = ?");
    params.push(filter.repoId);
  }
  if (filter.domain !== undefined) {
    where.push("domain = ?");
    params.push(filter.domain);
  }
  if (filter.statuses !== undefined) {
    if (filter.statuses.length === 0) {
      // an explicit empty status set matches nothing (undefined = no filter)
      where.push("0 = 1");
    } else {
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
  }
  if (filter.since !== undefined) {
    where.push("started_at >= ?");
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push("started_at <= ?");
    params.push(filter.until);
  }
  if (filter.reviewer !== undefined) {
    where.push("reviewer = ?");
    params.push(filter.reviewer);
  }
  if (filter.safetyStatus !== undefined) {
    where.push("safety_status = ?");
    params.push(filter.safetyStatus);
  }
  return {
    sql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function toSummary(r: SummaryRow): DashboardRunSummary {
  return {
    runId: r.run_id,
    repoId: r.repo_id,
    projectId: r.project_id,
    domain: r.domain,
    status: r.status,
    safetyStatus: r.safety_status,
    reviewer: r.reviewer,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    rerunAttempt: r.rerun_attempt,
    prUrl: r.pr_url,
  };
}

export class RunRepository {
  constructor(private readonly db: Database.Database) {}

  /** List runs newest-first, filtered by `RunFilter`. */
  listRuns(filter: RunFilter = {}): DashboardRunSummary[] {
    const { sql, params } = buildWhere(filter);
    // a run with a null started_at sorts last (NULLS LAST is not portable).
    const limit = clampInt(filter.limit, 100);
    const offset = clampInt(filter.offset, 0);
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM runs ${sql}
         ORDER BY (started_at IS NULL), started_at DESC, run_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as SummaryRow[];
    return rows.map(toSummary);
  }

  /** Total runs matching a filter, ignoring limit/offset (for paging). */
  countRuns(filter: RunFilter = {}): number {
    const { sql, params } = buildWhere(filter);
    const row = this.db
      .prepare(`SELECT count(*) AS n FROM runs ${sql}`)
      .get(...params) as { n: number };
    return row.n;
  }

  getRun(runId: string): RunDetail | null {
    const r = this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (r === undefined) return null;
    return {
      runId: r.run_id as string,
      repoId: r.repo_id as string,
      projectId: (r.project_id as string | null) ?? null,
      repoPath: (r.repo_path as string | null) ?? null,
      domain: r.domain as string,
      workflow: r.workflow as string,
      baseBranch: r.base_branch as string,
      baseSha: (r.base_sha as string | null) ?? null,
      runBranch: (r.run_branch as string | null) ?? null,
      status: r.status as string,
      safetyStatus: (r.safety_status as string | null) ?? null,
      reviewer: (r.reviewer as string | null) ?? null,
      reviewedAt: (r.reviewed_at as string | null) ?? null,
      startedAt: (r.started_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      parentRunId: (r.parent_run_id as string | null) ?? null,
      rootRunId: (r.root_run_id as string | null) ?? null,
      rerunAttempt: (r.rerun_attempt as number | null) ?? null,
      changedFilesCount: (r.changed_files_count as number | null) ?? null,
      ignoredUntrackedCount:
        (r.ignored_untracked_count as number | null) ?? null,
      secretSuspectCount: (r.secret_suspect_count as number | null) ?? null,
      prUrl: (r.pr_url as string | null) ?? null,
      prNumber: (r.pr_number as number | null) ?? null,
      promptTemplateName: (r.prompt_template_name as string | null) ?? null,
      promptTemplateVersion:
        (r.prompt_template_version as number | null) ?? null,
      knowledgeContextPath:
        (r.knowledge_context_path as string | null) ?? null,
    };
  }

  getTimeline(runId: string): RunTimelineEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, type, occurred_at, payload_json FROM run_events
         WHERE run_id = ? ORDER BY seq`,
      )
      .all(runId) as {
      seq: number;
      type: string;
      occurred_at: string | null;
      payload_json: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      occurredAt: r.occurred_at,
      payload: safeJson(r.payload_json),
    }));
  }

  /**
   * Every run in the rerun chain `runId` belongs to, ordered by attempt.
   *
   * Walks `parent_run_id` links — up from `runId` to the chain root, then
   * down to every descendant — so it works for legacy reruns that carry
   * `parent_run_id` but no `root_run_id` (Phase 2-4 era). A run with no
   * chain links is its own single-node chain.
   */
  getRerunChain(runId: string): RerunChainNode[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE
           up(run_id, parent_run_id) AS (
             SELECT run_id, parent_run_id FROM runs WHERE run_id = ?
             UNION
             SELECT r.run_id, r.parent_run_id FROM runs r
               JOIN up ON r.run_id = up.parent_run_id
           ),
           chain(run_id) AS (
             SELECT run_id FROM up
             UNION
             SELECT r.run_id FROM runs r
               JOIN chain ON r.parent_run_id = chain.run_id
           )
         SELECT run_id, parent_run_id, root_run_id, rerun_attempt, status
         FROM runs
         WHERE run_id IN (SELECT run_id FROM chain)
         ORDER BY (rerun_attempt IS NULL), rerun_attempt, run_id`,
      )
      .all(runId) as {
      run_id: string;
      parent_run_id: string | null;
      root_run_id: string | null;
      rerun_attempt: number | null;
      status: string;
    }[];
    return rows.map((r) => ({
      runId: r.run_id,
      parentRunId: r.parent_run_id,
      rootRunId: r.root_run_id,
      rerunAttempt: r.rerun_attempt,
      status: r.status,
    }));
  }

  getCommandResults(runId: string): CommandResultRow[] {
    const rows = this.db
      .prepare(
        `SELECT command_index, command, exit_code, duration_ms, timed_out
         FROM command_results WHERE run_id = ? ORDER BY command_index`,
      )
      .all(runId) as {
      command_index: number;
      command: string;
      exit_code: number | null;
      duration_ms: number | null;
      timed_out: number;
    }[];
    return rows.map((r) => ({
      commandIndex: r.command_index,
      command: r.command,
      exitCode: r.exit_code,
      durationMs: r.duration_ms,
      timedOut: r.timed_out === 1,
    }));
  }

  getReviewDecision(runId: string): ReviewDecisionRow | null {
    const r = this.db
      .prepare(
        `SELECT decision, reviewer, summary, reviewed_at
         FROM review_decisions WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          decision: string;
          reviewer: string | null;
          summary: string | null;
          reviewed_at: string | null;
        }
      | undefined;
    if (r === undefined) return null;
    const changes = this.db
      .prepare(
        `SELECT change_text FROM review_required_changes
         WHERE run_id = ? ORDER BY idx`,
      )
      .all(runId) as { change_text: string }[];
    return {
      decision: r.decision,
      reviewer: r.reviewer,
      summary: r.summary,
      reviewedAt: r.reviewed_at,
      requiredChanges: changes.map((c) => c.change_text),
    };
  }

  // --- write methods (Phase 7) ---------------------------------------

  /**
   * Guarded run status transition — the optimistic-concurrency primitive
   * every DB-first command (review / rerun / cleanup) shares.
   *
   * In one IMMEDIATE transaction it: replays an idempotent no-op when
   * `operationId` was already recorded; UPDATEs `status` only WHERE the
   * current status is in `expectedStatuses` (a mismatch — another writer
   * moved the run — is a `StateConflictError`, not a silent overwrite);
   * bumps `db_revision`; appends a `run_events` row at `MAX(seq)+1`; and
   * records the operation. A missing run is a `DbError`.
   */
  updateRunStatus(input: UpdateRunStatusInput): UpdateRunStatusResult {
    const txn = this.db.transaction((): UpdateRunStatusResult => {
      if (input.operationId !== undefined) {
        const prior = findOperation(this.db, input.operationId);
        if (prior !== undefined) {
          return { changed: false, status: this.requireRunStatus(input.runId) };
        }
      }
      const current = this.requireRunStatus(input.runId);
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const placeholders = input.expectedStatuses.map(() => "?").join(", ");
      const info = this.db
        .prepare(
          `UPDATE runs
             SET status = ?, db_revision = db_revision + 1, updated_at = ?
           WHERE run_id = ? AND status IN (${placeholders})`,
        )
        .run(input.nextStatus, occurredAt, input.runId, ...input.expectedStatuses);
      if (info.changes === 0) {
        throw new StateConflictError(
          input.runId,
          input.expectedStatuses,
          current,
        );
      }
      const seq = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events
             WHERE run_id = ?`,
          )
          .get(input.runId) as { next: number }
      ).next;
      this.db
        .prepare(
          `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          seq,
          input.eventType,
          occurredAt,
          JSON.stringify({
            previousStatus: current,
            newStatus: input.nextStatus,
            actor: input.actor ?? null,
          }),
        );
      if (input.operationId !== undefined) {
        recordOperation(this.db, {
          operationId: input.operationId,
          command: input.eventType,
          scopeType: "run",
          scopeId: input.runId,
          result: { status: input.nextStatus },
        });
      }
      return { changed: true, status: input.nextStatus };
    });
    return txn.immediate();
  }

  /** Current status of a run, or a `DbError` when it does not exist. */
  private requireRunStatus(runId: string): string {
    const r = this.db
      .prepare("SELECT status FROM runs WHERE run_id = ?")
      .get(runId) as { status: string } | undefined;
    if (r === undefined) {
      throw new DbError(`updateRunStatus: no run '${runId}'`);
    }
    return r.status;
  }
}

/**
 * Clamp a caller-supplied limit/offset to a finite non-negative integer.
 * A fractional / NaN / Infinity value would otherwise reach SQLite and
 * throw a `datatype mismatch`.
 */
function clampInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
