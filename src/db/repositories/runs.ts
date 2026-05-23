import type Database from "better-sqlite3";
import { DbError } from "../connection.js";
import { StateConflictError } from "../errors.js";
import { sha256 } from "../import/common.js";
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

/** One row of `run_changed_files` — a path the run touched. */
export interface ChangedFileInput {
  path: string;
  /** `tracked` | `untracked` | `ignored` */
  status: string;
  /** false when path policy denied the path */
  allowed: boolean;
  /** `post-codex` | `post-command` — which diff pass produced this */
  source: string;
}

/** One row of `policy_violations` — a path path-policy rejected. */
export interface ViolationInput {
  path: string;
  /** the rule kind: `deny_write` | `not_in_write_scope` | `unsafe_path` */
  rule: string;
  reason?: string;
}

/** Input to the guarded review-decision transition (Phase 7-5). */
export interface ApplyReviewDecisionInput {
  runId: string;
  /**
   * the reviewer's decision — also the run's target status, since the
   * three decision values map identically onto run statuses.
   */
  decision: "approved" | "changes_requested" | "rejected";
  reviewer: string | null;
  reviewedAt: string;
  requiredChanges: string[];
  /** raw review-decision.yaml content, stored in review_decisions */
  decisionYaml: string;
  /**
   * Phase 9 post-close P1 #1 fix — when the verdict came from a DB
   * `review_proposals` row, mark it processed inside the SAME transaction
   * as the decision promotion. If the process crashes between the run
   * status update and a later `markProcessed`, the proposal would
   * otherwise stay active-but-unprocessed and a retry would fail the
   * `status === needs_review` gate.
   */
  markProposalProcessed?: {
    proposalId: number;
    reviewDecisionId: string;
  };
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
          // a recorded id only short-circuits when it is THIS operation
          // replaying. The same id recorded against a different run /
          // command means the caller reused an operation id — a bug we
          // must surface, not silently swallow the new write.
          if (
            prior.scopeType !== "run" ||
            prior.scopeId !== input.runId ||
            prior.command !== input.eventType
          ) {
            throw new DbError(
              `operation id '${input.operationId}' was already used for ` +
                `${prior.command} on ${prior.scopeType} '${prior.scopeId}'`,
            );
          }
          return { changed: false, status: this.requireRunStatus(input.runId) };
        }
      }
      const current = this.requireRunStatus(input.runId);
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const placeholders = input.expectedStatuses.map(() => "?").join(", ");
      // the write also marks the run `export_status = 'dirty'`: the DB has
      // moved ahead of its exported files until the command re-exports.
      const info = this.db
        .prepare(
          `UPDATE runs
             SET status = ?, db_revision = db_revision + 1, updated_at = ?,
                 export_status = 'dirty', last_export_error = NULL
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

  /**
   * Replace a run's `run_changed_files` rows with the diff-verification
   * result. Phase 6 left this table empty (the importer cannot derive it
   * from files); a DB-first run populates it directly (Phase 7-4).
   */
  upsertChangedFiles(runId: string, files: ChangedFileInput[]): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM run_changed_files WHERE run_id = ?")
        .run(runId);
      const insert = this.db.prepare(
        `INSERT INTO run_changed_files (run_id, path, status, allowed, source)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const f of files) {
        insert.run(runId, f.path, f.status, f.allowed ? 1 : 0, f.source);
      }
    });
    txn();
  }

  /**
   * Replace a run's `policy_violations` rows with the validation result.
   * Like `run_changed_files`, deferred in Phase 6 and populated directly
   * by a DB-first run.
   */
  upsertViolations(runId: string, violations: ViolationInput[]): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM policy_violations WHERE run_id = ?")
        .run(runId);
      // OR IGNORE: the (run_id, path, rule) PK absorbs a path that would
      // otherwise be reported twice with the same rule.
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO policy_violations (run_id, path, rule, reason)
         VALUES (?, ?, ?, ?)`,
      );
      for (const v of violations) {
        insert.run(runId, v.path, v.rule, v.reason ?? null);
      }
    });
    txn();
  }

  /**
   * Apply a review decision to a DB-first run (Phase 7-5).
   *
   * In one transaction: guards the run is still `needs_review` (a
   * concurrent reviewer that already moved it is a `StateConflictError`,
   * not a silent overwrite), moves it to `newStatus`, patches the
   * `meta_json` reviewer fields, appends a `review_processed` event, and
   * records the decision in `review_decisions` /
   * `review_required_changes`. Returns the prior status.
   */
  applyReviewDecision(input: ApplyReviewDecisionInput): {
    previousStatus: string;
  } {
    const txn = this.db.transaction((): { previousStatus: string } => {
      const row = this.db
        .prepare("SELECT status, meta_json FROM runs WHERE run_id = ?")
        .get(input.runId) as
        | { status: string; meta_json: string | null }
        | undefined;
      if (row === undefined) {
        throw new DbError(`applyReviewDecision: no run '${input.runId}'`);
      }
      if (row.status !== "needs_review") {
        throw new StateConflictError(
          input.runId,
          ["needs_review"],
          row.status,
        );
      }
      const meta =
        row.meta_json !== null
          ? (JSON.parse(row.meta_json) as Record<string, unknown>)
          : {};
      // the three decision values are also the target run statuses.
      const newStatus = input.decision;
      const patchedMeta = {
        ...meta,
        status: newStatus,
        reviewer: input.reviewer,
        reviewedAt: input.reviewedAt,
      };
      const info = this.db
        .prepare(
          `UPDATE runs
             SET status = ?, reviewer = ?, reviewed_at = ?, meta_json = ?,
                 db_revision = db_revision + 1, export_status = 'dirty',
                 last_export_error = NULL, updated_at = ?
           WHERE run_id = ? AND status = 'needs_review'`,
        )
        .run(
          newStatus,
          input.reviewer,
          input.reviewedAt,
          JSON.stringify(patchedMeta, null, 2),
          input.reviewedAt,
          input.runId,
        );
      if (info.changes === 0) {
        throw new StateConflictError(
          input.runId,
          ["needs_review"],
          row.status,
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
           VALUES (?, ?, 'review_processed', ?, ?)`,
        )
        .run(
          input.runId,
          seq,
          input.reviewedAt,
          JSON.stringify({
            type: "review_processed",
            runId: input.runId,
            decision: input.decision,
            previousStatus: row.status,
            newStatus,
            reviewer: input.reviewer,
            reviewedAt: input.reviewedAt,
          }),
        );
      this.db
        .prepare(
          `INSERT INTO review_decisions (run_id, decision, reviewer, summary,
             reviewed_at, source_yaml, source_sha256)
           VALUES (?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT (run_id) DO UPDATE SET
             decision = excluded.decision, reviewer = excluded.reviewer,
             reviewed_at = excluded.reviewed_at,
             source_yaml = excluded.source_yaml,
             source_sha256 = excluded.source_sha256`,
        )
        .run(
          input.runId,
          input.decision,
          input.reviewer,
          input.reviewedAt,
          input.decisionYaml,
          sha256(input.decisionYaml),
        );
      this.db
        .prepare("DELETE FROM review_required_changes WHERE run_id = ?")
        .run(input.runId);
      const insChange = this.db.prepare(
        `INSERT INTO review_required_changes (run_id, idx, change_text)
         VALUES (?, ?, ?)`,
      );
      input.requiredChanges.forEach((c, i) => {
        insChange.run(input.runId, i, c);
      });
      // Phase 9 post-close P1 #1 fix — mark the source proposal processed
      // in the same transaction as the decision promotion. `processed_at
      // IS NULL` guard makes the UPDATE idempotent against a retry: a
      // proposal already processed by a prior crash-survived transaction
      // stays exactly as it was.
      if (input.markProposalProcessed !== undefined) {
        this.db
          .prepare(
            `UPDATE review_proposals
                SET processed_at = ?, review_decision_id = ?
              WHERE proposal_id = ? AND processed_at IS NULL`,
          )
          .run(
            input.reviewedAt,
            input.markProposalProcessed.reviewDecisionId,
            input.markProposalProcessed.proposalId,
          );
      }
      return { previousStatus: row.status };
    });
    return txn.immediate();
  }

  /**
   * Record a cleanup against a DB-first run (Phase 7-7).
   *
   * Cleanup does NOT delete the canonical `runs` row — it flips status to
   * `cleaned` (unless already cleaned, an idempotent no-op), appends a
   * `cleaned` event, and records the already-completed worktree/branch
   * actions. The status update is guarded by `expectedStatus` (the status
   * read under the domain lock); a mismatch is a `StateConflictError`.
   *
   * `run_dir_remove` is NOT recorded here — the caller records it via
   * `recordCleanupAction` only after the `rm` actually succeeds, so the
   * audit log never claims a deletion that did not happen.
   */
  recordCleanup(input: {
    runId: string;
    scope: string;
    expectedStatus: string;
    worktreeRemoved: boolean;
    branchRemoved: boolean;
  }): { previousStatus: string } {
    const txn = this.db.transaction((): { previousStatus: string } => {
      const row = this.db
        .prepare("SELECT status, meta_json FROM runs WHERE run_id = ?")
        .get(input.runId) as
        | { status: string; meta_json: string | null }
        | undefined;
      if (row === undefined) {
        throw new DbError(`recordCleanup: no run '${input.runId}'`);
      }
      const now = new Date().toISOString();
      if (row.status !== "cleaned") {
        const meta =
          row.meta_json !== null
            ? (JSON.parse(row.meta_json) as Record<string, unknown>)
            : {};
        const info = this.db
          .prepare(
            `UPDATE runs
               SET status = 'cleaned', meta_json = ?,
                   db_revision = db_revision + 1, export_status = 'dirty',
                   last_export_error = NULL, updated_at = ?
             WHERE run_id = ? AND status = ?`,
          )
          .run(
            JSON.stringify({ ...meta, status: "cleaned" }, null, 2),
            now,
            input.runId,
            input.expectedStatus,
          );
        if (info.changes === 0) {
          throw new StateConflictError(
            input.runId,
            [input.expectedStatus],
            row.status,
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
             VALUES (?, ?, 'cleaned', ?, ?)`,
          )
          .run(
            input.runId,
            seq,
            now,
            JSON.stringify({
              type: "cleaned",
              runId: input.runId,
              scope: input.scope,
              previousStatus: row.status,
              worktreeRemoved: input.worktreeRemoved,
              branchRemoved: input.branchRemoved,
            }),
          );
      }
      if (input.worktreeRemoved) {
        this.recordCleanupAction(input.runId, "worktree_remove", "done");
      }
      if (input.branchRemoved) {
        this.recordCleanupAction(input.runId, "branch_delete", "done");
      }
      return { previousStatus: row.status };
    });
    return txn.immediate();
  }

  /**
   * Record one cleanup_actions row. Used for `run_dir_remove` after the
   * filesystem delete actually succeeds (Phase 7-7).
   *
   * When a `run_dir_remove` succeeds, the run's exported files are gone on
   * purpose: the `exported_files` rows are cleared and `export_status` is
   * set `removed` so `db export-files` does not resurrect the dir and
   * `check-consistency` does not flag the intentional deletion (P1-4).
   */
  recordCleanupAction(
    runId: string,
    actionType: string,
    status: string,
    errorMessage: string | null = null,
  ): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cleanup_actions (run_id, action_type, target, status,
             executed_at, error_message)
           VALUES (?, ?, NULL, ?, ?, ?)`,
        )
        .run(runId, actionType, status, new Date().toISOString(), errorMessage);
      if (actionType === "run_dir_remove" && status === "done") {
        // both the run's own files and its knowledge-decisions.yaml live
        // under runs/<runId>/ and were just deleted (P1-4 / P1-a).
        this.db
          .prepare(
            `DELETE FROM exported_files
             WHERE scope_type IN ('run', 'knowledge_decisions')
               AND scope_id = ?`,
          )
          .run(runId);
        // `removed` — the exported run dir is intentionally gone; the
        // absent files are not drift (Phase 8-5 export_status state).
        this.db
          .prepare(
            `UPDATE runs SET export_status = 'removed', last_export_error = NULL
             WHERE run_id = ?`,
          )
          .run(runId);
      }
    });
    txn();
  }

  /**
   * Record a created pull request against a DB-first run (Phase 7-10).
   *
   * `pr create` does not change the run's status — an `approved` run
   * stays `approved` — so this writes `pr_url` / `pr_number`, patches the
   * `meta_json` PR fields, appends a `pr_created` event and bumps
   * `db_revision`. The write is guarded on the run still being `approved`
   * (a concurrent cleanup that moved it is a `StateConflictError`).
   */
  recordPrCreated(input: {
    runId: string;
    prUrl: string;
    prNumber: number;
    head: string;
    base: string;
    occurredAt: string;
  }): void {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT status, meta_json FROM runs WHERE run_id = ?")
        .get(input.runId) as
        | { status: string; meta_json: string | null }
        | undefined;
      if (row === undefined) {
        throw new DbError(`recordPrCreated: no run '${input.runId}'`);
      }
      if (row.status !== "approved") {
        throw new StateConflictError(input.runId, ["approved"], row.status);
      }
      const meta =
        row.meta_json !== null
          ? (JSON.parse(row.meta_json) as Record<string, unknown>)
          : {};
      const patchedMeta = {
        ...meta,
        prUrl: input.prUrl,
        prNumber: input.prNumber,
      };
      const info = this.db
        .prepare(
          `UPDATE runs
             SET pr_url = ?, pr_number = ?, meta_json = ?,
                 db_revision = db_revision + 1, export_status = 'dirty',
                 last_export_error = NULL, updated_at = ?
           WHERE run_id = ? AND status = 'approved'`,
        )
        .run(
          input.prUrl,
          input.prNumber,
          JSON.stringify(patchedMeta, null, 2),
          input.occurredAt,
          input.runId,
        );
      if (info.changes === 0) {
        throw new StateConflictError(input.runId, ["approved"], row.status);
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
           VALUES (?, ?, 'pr_created', ?, ?)`,
        )
        .run(
          input.runId,
          seq,
          input.occurredAt,
          JSON.stringify({
            type: "pr_created",
            runId: input.runId,
            prUrl: input.prUrl,
            prNumber: input.prNumber,
            head: input.head,
            base: input.base,
            createdAt: input.occurredAt,
          }),
        );
    });
    txn.immediate();
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
