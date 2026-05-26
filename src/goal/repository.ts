import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DbError } from "../db/connection.js";
import { goalFindingStableKey } from "./stable-key.js";
import {
  parseGoalCloseConditions,
  parseGoalPolicy,
  parseGoalScope,
} from "./schemas.js";
import {
  DEFAULT_GOAL_POLICY,
  type GoalAttempt,
  type GoalAttemptStatus,
  type GoalAttemptType,
  type GoalCloseCheck,
  type GoalCloseCheckStatus,
  type GoalCloseCondition,
  type GoalConvergenceDecision,
  type GoalConvergenceDecisionRecord,
  type GoalCreatedSource,
  type GoalFinding,
  type GoalFindingSeverity,
  type GoalFindingSource,
  type GoalLifecycleStatus,
  type GoalNextAction,
  type GoalPolicy,
  type GoalReviewCycle,
  type GoalReviewMode,
  type GoalScope,
  type GoalScopeStatus,
  type GoalSession,
  type GoalStatus,
} from "./types.js";

export interface CreateGoalSessionInput {
  goalId?: string;
  title: string;
  description?: string;
  projectId?: string;
  repoId?: string;
  domain?: string;
  backlogItemId?: string;
  scope?: GoalScope;
  closeConditions?: GoalCloseCondition[];
  policy?: GoalPolicy;
  maxIterations?: number;
  maxReviewCycles?: number;
  maxReruns?: number;
  maxTotalNewFindings?: number;
  createdBy: string;
  createdSource: GoalCreatedSource;
  createdAt?: string;
}

export interface GoalSessionFilter {
  status?: GoalStatus;
  projectId?: string;
  repoId?: string;
  domain?: string;
  limit?: number;
}

export interface CreateGoalAttemptInput {
  attemptId?: string;
  goalId: string;
  iteration?: number;
  attemptType: GoalAttemptType;
  status?: GoalAttemptStatus;
  operationId?: string;
  runId?: string;
  parentAttemptId?: string;
  input?: Record<string, unknown>;
  startedAt?: string;
  createdAt?: string;
}

export interface CompleteGoalAttemptInput {
  attemptId: string;
  status: Exclude<GoalAttemptStatus, "pending" | "running">;
  operationId?: string;
  runId?: string;
  result?: Record<string, unknown>;
  errorMessage?: string;
  completedAt?: string;
}

export interface StartReviewCycleInput {
  cycleId?: string;
  goalId: string;
  cycleNumber?: number;
  reviewMode: GoalReviewMode;
  triggerAttemptId?: string;
  sourceReviewId?: string;
  sourceRunId?: string;
  createdAt?: string;
}

export interface CompleteReviewCycleInput {
  cycleId: string;
  findingsSeen?: number;
  findingsNew?: number;
  findingsReopened?: number;
  findingsFixed?: number;
  findingsDeferred?: number;
  findingsInScopeOpen?: number;
  summary?: string;
  completedAt?: string;
}

export interface UpsertGoalFindingInput {
  findingId?: string;
  goalId: string;
  stableKey?: string;
  duplicateOf?: string;
  source: GoalFindingSource;
  sourceRef?: string;
  sourceAttemptId?: string;
  sourceCycleId?: string;
  severity: GoalFindingSeverity;
  category: string;
  scopeStatus?: GoalScopeStatus;
  lifecycleStatus?: GoalLifecycleStatus;
  summary: string;
  detail?: string;
  filePath?: string;
  symbol?: string;
  suggestedFix?: string;
  seenAt?: string;
  classificationReason?: string;
}

export interface UpsertGoalFindingResult {
  finding: GoalFinding;
  created: boolean;
  reopened: boolean;
}

export interface ClassifyFindingInput {
  findingId: string;
  scopeStatus: GoalScopeStatus;
  reason: string;
  duplicateOf?: string;
}

export interface MarkFindingFixedInput {
  findingId: string;
  note?: string;
  fixedAt?: string;
}

export interface DeferFindingInput {
  findingId: string;
  note?: string;
  backlogItemId?: string;
  deferredAt?: string;
}

export interface GoalFindingFilter {
  goalId?: string;
  scopeStatus?: GoalScopeStatus;
  lifecycleStatus?: GoalLifecycleStatus;
  severity?: GoalFindingSeverity;
  limit?: number;
}

export interface RecordCloseCheckInput {
  checkId?: string;
  goalId: string;
  conditionId: string;
  status: GoalCloseCheckStatus;
  checkedAt?: string;
  checkedBy: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

export interface RecordConvergenceDecisionInput {
  decisionId?: string;
  goalId: string;
  cycleId?: string;
  attemptId?: string;
  decision: GoalConvergenceDecision;
  reason: string;
  metrics?: Record<string, unknown>;
  recommendedNextAction?: GoalNextAction;
  createdAt?: string;
  createdBy: string;
}

interface GoalSessionRow {
  goal_id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  repo_id: string | null;
  domain: string | null;
  backlog_item_id: string | null;
  status: GoalStatus;
  scope_json: string;
  close_conditions_json: string;
  policy_json: string;
  max_iterations: number;
  max_review_cycles: number;
  max_reruns: number;
  max_total_new_findings: number;
  current_iteration: number;
  current_review_cycle: number;
  created_by: string;
  created_source: GoalCreatedSource;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_summary: string | null;
  escalation_reason: string | null;
}

interface GoalAttemptRow {
  attempt_id: string;
  goal_id: string;
  iteration: number;
  attempt_type: GoalAttemptType;
  status: GoalAttemptStatus;
  operation_id: string | null;
  run_id: string | null;
  parent_attempt_id: string | null;
  input_json: string;
  result_json: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface GoalReviewCycleRow {
  cycle_id: string;
  goal_id: string;
  cycle_number: number;
  review_mode: GoalReviewMode;
  trigger_attempt_id: string | null;
  source_review_id: string | null;
  source_run_id: string | null;
  findings_seen: number;
  findings_new: number;
  findings_reopened: number;
  findings_fixed: number;
  findings_deferred: number;
  findings_in_scope_open: number;
  created_at: string;
  completed_at: string | null;
  summary: string | null;
}

interface GoalFindingRow {
  finding_id: string;
  goal_id: string;
  stable_key: string;
  duplicate_of: string | null;
  source: GoalFindingSource;
  source_ref: string | null;
  source_attempt_id: string | null;
  source_cycle_id: string | null;
  severity: GoalFindingSeverity;
  category: string;
  scope_status: GoalScopeStatus;
  lifecycle_status: GoalLifecycleStatus;
  summary: string;
  detail: string | null;
  file_path: string | null;
  symbol: string | null;
  suggested_fix: string | null;
  first_seen_at: string;
  last_seen_at: string;
  fixed_at: string | null;
  deferred_at: string | null;
  escalated_at: string | null;
  reopen_count: number;
  deferred_backlog_item_id: string | null;
  classification_reason: string | null;
  resolution_note: string | null;
}

interface GoalCloseCheckRow {
  check_id: string;
  goal_id: string;
  condition_id: string;
  status: GoalCloseCheckStatus;
  checked_at: string;
  checked_by: string;
  evidence_json: string;
  message: string | null;
}

interface GoalDecisionRow {
  decision_id: string;
  goal_id: string;
  cycle_id: string | null;
  attempt_id: string | null;
  decision: GoalConvergenceDecision;
  reason: string;
  metrics_json: string;
  recommended_next_action: string | null;
  created_at: string;
  created_by: string;
}

export class GoalRepository {
  constructor(private readonly db: Database.Database) {}

  createSession(input: CreateGoalSessionInput): GoalSession {
    const now = input.createdAt ?? new Date().toISOString();
    const goalId = input.goalId ?? `goal-${randomUUID()}`;
    const policy = input.policy ?? DEFAULT_GOAL_POLICY;
    const maxTotalNewFindings =
      input.maxTotalNewFindings ??
      policy.divergence.maxTotalNewFindings;
    this.db
      .prepare(
        `INSERT INTO goal_sessions (
           goal_id, title, description, project_id, repo_id, domain,
           backlog_item_id, status, scope_json, close_conditions_json,
           policy_json, max_iterations, max_review_cycles, max_reruns,
           max_total_new_findings, current_iteration, current_review_cycle,
           created_by, created_source, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 0, 0,
           ?, ?, ?, ?)`,
      )
      .run(
        goalId,
        input.title,
        input.description ?? null,
        input.projectId ?? null,
        input.repoId ?? null,
        input.domain ?? null,
        input.backlogItemId ?? null,
        json(input.scope ?? {}),
        json(input.closeConditions ?? []),
        json(policy),
        input.maxIterations ?? 3,
        input.maxReviewCycles ?? 3,
        input.maxReruns ?? 2,
        maxTotalNewFindings,
        input.createdBy,
        input.createdSource,
        now,
        now,
      );
    return this.requireSession(goalId);
  }

  getSession(goalId: string): GoalSession | null {
    const row = this.db
      .prepare("SELECT * FROM goal_sessions WHERE goal_id = ?")
      .get(goalId) as GoalSessionRow | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  requireSession(goalId: string): GoalSession {
    const session = this.getSession(goalId);
    if (session === null) throw new DbError(`goal not found: ${goalId}`);
    return session;
  }

  listSessions(filter: GoalSessionFilter = {}): GoalSession[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    addWhere(clauses, args, "status", filter.status);
    addWhere(clauses, args, "project_id", filter.projectId);
    addWhere(clauses, args, "repo_id", filter.repoId);
    addWhere(clauses, args, "domain", filter.domain);
    const limit = filter.limit ?? 50;
    const sql =
      "SELECT * FROM goal_sessions" +
      whereSql(clauses) +
      " ORDER BY updated_at DESC, goal_id DESC LIMIT ?";
    const rows = this.db.prepare(sql).all(...args, limit) as GoalSessionRow[];
    return rows.map(rowToSession);
  }

  updateStatus(
    goalId: string,
    status: GoalStatus,
    note?: string,
    now = new Date().toISOString(),
  ): GoalSession {
    const closedAt =
      status === "closed" || status === "cancelled" ? now : null;
    const escalationReason = status === "escalated" ? note ?? null : null;
    const closeSummary = status === "closed" ? note ?? null : null;
    this.db
      .prepare(
        `UPDATE goal_sessions
            SET status = ?, updated_at = ?,
                closed_at = COALESCE(?, closed_at),
                close_summary = COALESCE(?, close_summary),
                escalation_reason = COALESCE(?, escalation_reason)
          WHERE goal_id = ?`,
      )
      .run(status, now, closedAt, closeSummary, escalationReason, goalId);
    return this.requireSession(goalId);
  }

  createAttempt(input: CreateGoalAttemptInput): GoalAttempt {
    const now = input.createdAt ?? new Date().toISOString();
    const attemptId = input.attemptId ?? `attempt-${randomUUID()}`;
    const iteration = input.iteration ?? this.nextIteration(input.goalId);
    this.db
      .prepare(
        `INSERT INTO goal_attempts (
           attempt_id, goal_id, iteration, attempt_type, status,
           operation_id, run_id, parent_attempt_id, input_json,
           result_json, started_at, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        attemptId,
        input.goalId,
        iteration,
        input.attemptType,
        input.status ?? "running",
        input.operationId ?? null,
        input.runId ?? null,
        input.parentAttemptId ?? null,
        json(input.input ?? {}),
        input.startedAt ?? now,
        now,
      );
    this.touchSession(input.goalId, now);
    return this.requireAttempt(attemptId);
  }

  completeAttempt(input: CompleteGoalAttemptInput): GoalAttempt {
    const now = input.completedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE goal_attempts
            SET status = ?, operation_id = COALESCE(?, operation_id),
                run_id = COALESCE(?, run_id), result_json = ?,
                error_message = ?, completed_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        input.status,
        input.operationId ?? null,
        input.runId ?? null,
        json(input.result ?? {}),
        input.errorMessage ?? null,
        now,
        input.attemptId,
      );
    const attempt = this.requireAttempt(input.attemptId);
    this.touchSession(attempt.goalId, now);
    return attempt;
  }

  getAttempt(attemptId: string): GoalAttempt | null {
    const row = this.db
      .prepare("SELECT * FROM goal_attempts WHERE attempt_id = ?")
      .get(attemptId) as GoalAttemptRow | undefined;
    return row === undefined ? null : rowToAttempt(row);
  }

  requireAttempt(attemptId: string): GoalAttempt {
    const attempt = this.getAttempt(attemptId);
    if (attempt === null) throw new DbError(`goal attempt not found: ${attemptId}`);
    return attempt;
  }

  listAttempts(goalId: string): GoalAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM goal_attempts
          WHERE goal_id = ?
          ORDER BY iteration ASC, created_at ASC`,
      )
      .all(goalId) as GoalAttemptRow[];
    return rows.map(rowToAttempt);
  }

  startReviewCycle(input: StartReviewCycleInput): GoalReviewCycle {
    const now = input.createdAt ?? new Date().toISOString();
    const cycleId = input.cycleId ?? `cycle-${randomUUID()}`;
    const cycleNumber =
      input.cycleNumber ?? this.nextReviewCycleNumber(input.goalId);
    this.db
      .prepare(
        `INSERT INTO goal_review_cycles (
           cycle_id, goal_id, cycle_number, review_mode, trigger_attempt_id,
           source_review_id, source_run_id, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cycleId,
        input.goalId,
        cycleNumber,
        input.reviewMode,
        input.triggerAttemptId ?? null,
        input.sourceReviewId ?? null,
        input.sourceRunId ?? null,
        now,
      );
    this.db
      .prepare(
        `UPDATE goal_sessions
            SET current_review_cycle = MAX(current_review_cycle, ?),
                updated_at = ?
          WHERE goal_id = ?`,
      )
      .run(cycleNumber, now, input.goalId);
    return this.requireReviewCycle(cycleId);
  }

  completeReviewCycle(input: CompleteReviewCycleInput): GoalReviewCycle {
    const now = input.completedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE goal_review_cycles
            SET findings_seen = ?, findings_new = ?, findings_reopened = ?,
                findings_fixed = ?, findings_deferred = ?,
                findings_in_scope_open = ?, summary = ?, completed_at = ?
          WHERE cycle_id = ?`,
      )
      .run(
        input.findingsSeen ?? 0,
        input.findingsNew ?? 0,
        input.findingsReopened ?? 0,
        input.findingsFixed ?? 0,
        input.findingsDeferred ?? 0,
        input.findingsInScopeOpen ?? 0,
        input.summary ?? null,
        now,
        input.cycleId,
      );
    const cycle = this.requireReviewCycle(input.cycleId);
    this.touchSession(cycle.goalId, now);
    return cycle;
  }

  getReviewCycle(cycleId: string): GoalReviewCycle | null {
    const row = this.db
      .prepare("SELECT * FROM goal_review_cycles WHERE cycle_id = ?")
      .get(cycleId) as GoalReviewCycleRow | undefined;
    return row === undefined ? null : rowToReviewCycle(row);
  }

  requireReviewCycle(cycleId: string): GoalReviewCycle {
    const cycle = this.getReviewCycle(cycleId);
    if (cycle === null) throw new DbError(`goal review cycle not found: ${cycleId}`);
    return cycle;
  }

  listReviewCycles(goalId: string): GoalReviewCycle[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM goal_review_cycles
          WHERE goal_id = ?
          ORDER BY cycle_number ASC`,
      )
      .all(goalId) as GoalReviewCycleRow[];
    return rows.map(rowToReviewCycle);
  }

  upsertFinding(input: UpsertGoalFindingInput): UpsertGoalFindingResult {
    const now = input.seenAt ?? new Date().toISOString();
    const stableKey =
      input.stableKey ??
      goalFindingStableKey({
        filePath: input.filePath,
        symbol: input.symbol,
        category: input.category,
        summary: input.summary,
      });
    const scopeStatus = input.scopeStatus ?? "unknown";
    const duplicateOf =
      scopeStatus === "duplicate"
        ? this.requireCanonicalDuplicateFinding(
            input.goalId,
            input.findingId,
            input.duplicateOf,
          )
        : null;
    const lifecycleStatus =
      input.lifecycleStatus ?? defaultLifecycleForScope(scopeStatus);
    const tx = this.db.transaction((): UpsertGoalFindingResult => {
      const existing = this.db
        .prepare(
          `SELECT finding_id, lifecycle_status, severity
             FROM goal_findings
            WHERE goal_id = ? AND stable_key = ?
            ORDER BY
              CASE WHEN duplicate_of IS NULL THEN 0 ELSE 1 END,
              first_seen_at ASC,
              finding_id ASC
            LIMIT 1`,
        )
        .get(input.goalId, stableKey) as
        | {
            finding_id: string;
            lifecycle_status: GoalLifecycleStatus;
            severity: GoalFindingSeverity;
          }
        | undefined;
      if (existing !== undefined) {
        const reopened = existing.lifecycle_status === "fixed";
        const severity = moreSevere(existing.severity, input.severity);
        if (duplicateOf !== null) {
          this.promoteDuplicateCanonical(duplicateOf, input.severity, now);
        }
        this.db
          .prepare(
            `UPDATE goal_findings
                SET last_seen_at = ?, source = ?, source_ref = ?,
                    source_attempt_id = ?, source_cycle_id = ?,
                    severity = ?,
                    detail = COALESCE(?, detail),
                    suggested_fix = COALESCE(?, suggested_fix),
                    lifecycle_status = CASE
                      WHEN lifecycle_status = 'fixed' THEN 'reopened'
                      ELSE lifecycle_status
                    END,
                    fixed_at = CASE
                      WHEN lifecycle_status = 'fixed' THEN NULL
                      ELSE fixed_at
                    END,
                    reopen_count = CASE
                      WHEN lifecycle_status = 'fixed' THEN reopen_count + 1
                      ELSE reopen_count
                    END
              WHERE finding_id = ?`,
          )
          .run(
            now,
            input.source,
            input.sourceRef ?? null,
            input.sourceAttemptId ?? null,
            input.sourceCycleId ?? null,
            severity,
            input.detail ?? null,
            input.suggestedFix ?? null,
            existing.finding_id,
          );
        this.touchSession(input.goalId, now);
        return {
          finding: this.requireFinding(existing.finding_id),
          created: false,
          reopened,
        };
      }

      if (duplicateOf !== null) {
        this.promoteDuplicateCanonical(duplicateOf, input.severity, now);
      }
      const findingId = input.findingId ?? `finding-${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO goal_findings (
             finding_id, goal_id, stable_key, duplicate_of, source,
             source_ref, source_attempt_id, source_cycle_id, severity,
             category, scope_status, lifecycle_status, summary, detail,
             file_path, symbol, suggested_fix, first_seen_at, last_seen_at,
             classification_reason
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          findingId,
          input.goalId,
          stableKey,
          duplicateOf,
          input.source,
          input.sourceRef ?? null,
          input.sourceAttemptId ?? null,
          input.sourceCycleId ?? null,
          input.severity,
          input.category,
          scopeStatus,
          lifecycleStatus,
          input.summary,
          input.detail ?? null,
          input.filePath ?? null,
          input.symbol ?? null,
          input.suggestedFix ?? null,
          now,
          now,
          input.classificationReason ?? null,
        );
      this.touchSession(input.goalId, now);
      return {
        finding: this.requireFinding(findingId),
        created: true,
        reopened: false,
      };
    });
    return tx.immediate();
  }

  classifyFinding(input: ClassifyFindingInput): GoalFinding {
    const now = new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    const duplicateOf =
      input.scopeStatus === "duplicate"
        ? this.requireCanonicalDuplicateFinding(
            current.goalId,
            current.findingId,
            input.duplicateOf,
          )
        : null;
    const lifecycleStatus =
      input.scopeStatus === "duplicate"
        ? "duplicate"
        : input.scopeStatus === "out_of_scope" &&
            current.lifecycleStatus !== "deferred"
          ? "out_of_scope"
          : input.scopeStatus === "unknown" &&
              current.lifecycleStatus !== "open" &&
              current.lifecycleStatus !== "reopened" &&
              current.lifecycleStatus !== "escalated"
            ? "open"
          : input.scopeStatus === "in_scope" &&
              (current.lifecycleStatus === "out_of_scope" ||
                current.lifecycleStatus === "duplicate" ||
                current.lifecycleStatus === "deferred")
            ? "open"
            : current.lifecycleStatus;
    this.db
      .prepare(
        `UPDATE goal_findings
            SET scope_status = ?, lifecycle_status = ?, duplicate_of = ?,
                classification_reason = ?,
                deferred_at = CASE
                  WHEN ? IN ('in_scope', 'unknown') THEN NULL
                  ELSE deferred_at
                END,
                deferred_backlog_item_id = CASE
                  WHEN ? IN ('in_scope', 'unknown') THEN NULL
                  ELSE deferred_backlog_item_id
                END,
                fixed_at = CASE
                  WHEN ? IN ('in_scope', 'unknown') THEN NULL
                  ELSE fixed_at
                END,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(
        input.scopeStatus,
        lifecycleStatus,
        duplicateOf,
        input.reason,
        input.scopeStatus,
        input.scopeStatus,
        input.scopeStatus,
        now,
        input.findingId,
      );
    this.touchSession(current.goalId, now);
    if (duplicateOf !== null) {
      this.promoteDuplicateCanonical(duplicateOf, current.severity, now);
    }
    return this.requireFinding(input.findingId);
  }

  private requireCanonicalDuplicateFinding(
    goalId: string,
    findingId: string | undefined,
    duplicateOf: string | undefined,
  ): string {
    if (duplicateOf === undefined) {
      throw new DbError("duplicate finding requires duplicateOf");
    }
    if (duplicateOf === findingId) {
      throw new DbError("duplicate finding cannot reference itself");
    }
    const canonical = this.requireFinding(duplicateOf);
    if (canonical.goalId !== goalId) {
      throw new DbError(
        `duplicate finding target belongs to a different goal: ${duplicateOf}`,
      );
    }
    if (
      canonical.scopeStatus === "duplicate" ||
      canonical.lifecycleStatus === "duplicate" ||
      canonical.duplicateOf !== null
    ) {
      throw new DbError(
        `duplicate finding target is also a duplicate: ${duplicateOf}`,
      );
    }
    return canonical.findingId;
  }

  private promoteDuplicateCanonical(
    canonicalFindingId: string,
    incomingSeverity: GoalFindingSeverity,
    now: string,
  ): void {
    const canonical = this.requireFinding(canonicalFindingId);
    const severity = moreSevere(canonical.severity, incomingSeverity);
    this.db
      .prepare(
        `UPDATE goal_findings
            SET severity = ?,
                lifecycle_status = CASE
                  WHEN lifecycle_status = 'fixed' THEN 'reopened'
                  ELSE lifecycle_status
                END,
                fixed_at = CASE
                  WHEN lifecycle_status = 'fixed' THEN NULL
                  ELSE fixed_at
                END,
                reopen_count = CASE
                  WHEN lifecycle_status = 'fixed' THEN reopen_count + 1
                  ELSE reopen_count
                END,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(severity, now, canonicalFindingId);
  }

  markFindingFixed(input: MarkFindingFixedInput): GoalFinding {
    const now = input.fixedAt ?? new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    this.db
      .prepare(
        `UPDATE goal_findings
            SET lifecycle_status = 'fixed', fixed_at = ?,
                resolution_note = COALESCE(?, resolution_note),
                deferred_at = NULL,
                deferred_backlog_item_id = NULL,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(now, input.note ?? null, now, input.findingId);
    this.touchSession(current.goalId, now);
    return this.requireFinding(input.findingId);
  }

  deferFinding(input: DeferFindingInput): GoalFinding {
    const now = input.deferredAt ?? new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    if (current.scopeStatus !== "out_of_scope") {
      throw new DbError(
        `goal finding ${input.findingId} cannot be deferred while scope is ${current.scopeStatus}; classify it out_of_scope first`,
      );
    }
    this.db
      .prepare(
        `UPDATE goal_findings
            SET lifecycle_status = 'deferred', deferred_at = ?,
                deferred_backlog_item_id = COALESCE(?, deferred_backlog_item_id),
                resolution_note = COALESCE(?, resolution_note),
                fixed_at = NULL,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(
        now,
        input.backlogItemId ?? null,
        input.note ?? null,
        now,
        input.findingId,
      );
    this.touchSession(current.goalId, now);
    return this.requireFinding(input.findingId);
  }

  getFinding(findingId: string): GoalFinding | null {
    const row = this.db
      .prepare("SELECT * FROM goal_findings WHERE finding_id = ?")
      .get(findingId) as GoalFindingRow | undefined;
    return row === undefined ? null : rowToFinding(row);
  }

  requireFinding(findingId: string): GoalFinding {
    const finding = this.getFinding(findingId);
    if (finding === null) throw new DbError(`goal finding not found: ${findingId}`);
    return finding;
  }

  listFindings(filter: GoalFindingFilter = {}): GoalFinding[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    addWhere(clauses, args, "goal_id", filter.goalId);
    addWhere(clauses, args, "scope_status", filter.scopeStatus);
    addWhere(clauses, args, "lifecycle_status", filter.lifecycleStatus);
    addWhere(clauses, args, "severity", filter.severity);
    const limit = filter.limit ?? 200;
    const rows = this.db
      .prepare(
        "SELECT * FROM goal_findings" +
          whereSql(clauses) +
          " ORDER BY first_seen_at ASC, finding_id ASC LIMIT ?",
      )
      .all(...args, limit) as GoalFindingRow[];
    return rows.map(rowToFinding);
  }

  recordCloseCheck(input: RecordCloseCheckInput): GoalCloseCheck {
    const checkedAt = input.checkedAt ?? new Date().toISOString();
    const checkId = input.checkId ?? `check-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO goal_close_checks (
           check_id, goal_id, condition_id, status, checked_at, checked_by,
           evidence_json, message
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkId,
        input.goalId,
        input.conditionId,
        input.status,
        checkedAt,
        input.checkedBy,
        json(input.evidence ?? {}),
        input.message ?? null,
      );
    this.touchSession(input.goalId, checkedAt);
    return this.requireCloseCheck(checkId);
  }

  getCloseCheck(checkId: string): GoalCloseCheck | null {
    const row = this.db
      .prepare("SELECT * FROM goal_close_checks WHERE check_id = ?")
      .get(checkId) as GoalCloseCheckRow | undefined;
    return row === undefined ? null : rowToCloseCheck(row);
  }

  requireCloseCheck(checkId: string): GoalCloseCheck {
    const check = this.getCloseCheck(checkId);
    if (check === null) throw new DbError(`goal close check not found: ${checkId}`);
    return check;
  }

  listCloseChecks(goalId: string): GoalCloseCheck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM goal_close_checks
          WHERE goal_id = ?
          ORDER BY checked_at ASC, check_id ASC`,
      )
      .all(goalId) as GoalCloseCheckRow[];
    return rows.map(rowToCloseCheck);
  }

  recordConvergenceDecision(
    input: RecordConvergenceDecisionInput,
  ): GoalConvergenceDecisionRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const decisionId = input.decisionId ?? `decision-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO goal_convergence_decisions (
           decision_id, goal_id, cycle_id, attempt_id, decision, reason,
           metrics_json, recommended_next_action, created_at, created_by
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decisionId,
        input.goalId,
        input.cycleId ?? null,
        input.attemptId ?? null,
        input.decision,
        input.reason,
        json(input.metrics ?? {}),
        input.recommendedNextAction === undefined
          ? null
          : json(input.recommendedNextAction),
        createdAt,
        input.createdBy,
      );
    this.touchSession(input.goalId, createdAt);
    return this.requireDecision(decisionId);
  }

  getDecision(decisionId: string): GoalConvergenceDecisionRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM goal_convergence_decisions WHERE decision_id = ?",
      )
      .get(decisionId) as GoalDecisionRow | undefined;
    return row === undefined ? null : rowToDecision(row);
  }

  requireDecision(decisionId: string): GoalConvergenceDecisionRecord {
    const decision = this.getDecision(decisionId);
    if (decision === null) {
      throw new DbError(`goal convergence decision not found: ${decisionId}`);
    }
    return decision;
  }

  listDecisions(goalId: string): GoalConvergenceDecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM goal_convergence_decisions
          WHERE goal_id = ?
          ORDER BY created_at ASC, decision_id ASC`,
      )
      .all(goalId) as GoalDecisionRow[];
    return rows.map(rowToDecision);
  }

  private nextIteration(goalId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(iteration), 0) + 1 AS n FROM goal_attempts WHERE goal_id = ?",
      )
      .get(goalId) as { n: number };
    this.db
      .prepare(
        `UPDATE goal_sessions
            SET current_iteration = MAX(current_iteration, ?),
                updated_at = ?
          WHERE goal_id = ?`,
      )
      .run(row.n, new Date().toISOString(), goalId);
    return row.n;
  }

  private nextReviewCycleNumber(goalId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(cycle_number), 0) + 1 AS n FROM goal_review_cycles WHERE goal_id = ?",
      )
      .get(goalId) as { n: number };
    return row.n;
  }

  private touchSession(goalId: string, updatedAt: string): void {
    this.db
      .prepare("UPDATE goal_sessions SET updated_at = ? WHERE goal_id = ?")
      .run(updatedAt, goalId);
  }
}

function defaultLifecycleForScope(
  scopeStatus: GoalScopeStatus,
): GoalLifecycleStatus {
  if (scopeStatus === "out_of_scope") return "out_of_scope";
  if (scopeStatus === "duplicate") return "duplicate";
  return "open";
}

function moreSevere(
  current: GoalFindingSeverity,
  incoming: GoalFindingSeverity,
): GoalFindingSeverity {
  const rank: Record<GoalFindingSeverity, number> = {
    P0: 0,
    P1: 1,
    P2: 2,
    P3: 3,
    info: 4,
  };
  return rank[incoming] < rank[current] ? incoming : current;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseRecord(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function rowToSession(row: GoalSessionRow): GoalSession {
  return {
    goalId: row.goal_id,
    title: row.title,
    description: row.description,
    projectId: row.project_id,
    repoId: row.repo_id,
    domain: row.domain,
    backlogItemId: row.backlog_item_id,
    status: row.status,
    scope: parseGoalScope(JSON.parse(row.scope_json) as unknown),
    closeConditions: parseGoalCloseConditions(
      JSON.parse(row.close_conditions_json) as unknown,
    ),
    policy: parseGoalPolicy(JSON.parse(row.policy_json) as unknown),
    maxIterations: row.max_iterations,
    maxReviewCycles: row.max_review_cycles,
    maxReruns: row.max_reruns,
    maxTotalNewFindings: row.max_total_new_findings,
    currentIteration: row.current_iteration,
    currentReviewCycle: row.current_review_cycle,
    createdBy: row.created_by,
    createdSource: row.created_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closeSummary: row.close_summary,
    escalationReason: row.escalation_reason,
  };
}

function rowToAttempt(row: GoalAttemptRow): GoalAttempt {
  return {
    attemptId: row.attempt_id,
    goalId: row.goal_id,
    iteration: row.iteration,
    attemptType: row.attempt_type,
    status: row.status,
    operationId: row.operation_id,
    runId: row.run_id,
    parentAttemptId: row.parent_attempt_id,
    input: parseRecord(row.input_json),
    result: parseRecord(row.result_json),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function rowToReviewCycle(row: GoalReviewCycleRow): GoalReviewCycle {
  return {
    cycleId: row.cycle_id,
    goalId: row.goal_id,
    cycleNumber: row.cycle_number,
    reviewMode: row.review_mode,
    triggerAttemptId: row.trigger_attempt_id,
    sourceReviewId: row.source_review_id,
    sourceRunId: row.source_run_id,
    findingsSeen: row.findings_seen,
    findingsNew: row.findings_new,
    findingsReopened: row.findings_reopened,
    findingsFixed: row.findings_fixed,
    findingsDeferred: row.findings_deferred,
    findingsInScopeOpen: row.findings_in_scope_open,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    summary: row.summary,
  };
}

function rowToFinding(row: GoalFindingRow): GoalFinding {
  return {
    findingId: row.finding_id,
    goalId: row.goal_id,
    stableKey: row.stable_key,
    duplicateOf: row.duplicate_of,
    source: row.source,
    sourceRef: row.source_ref,
    sourceAttemptId: row.source_attempt_id,
    sourceCycleId: row.source_cycle_id,
    severity: row.severity,
    category: row.category,
    scopeStatus: row.scope_status,
    lifecycleStatus: row.lifecycle_status,
    summary: row.summary,
    detail: row.detail,
    filePath: row.file_path,
    symbol: row.symbol,
    suggestedFix: row.suggested_fix,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    fixedAt: row.fixed_at,
    deferredAt: row.deferred_at,
    escalatedAt: row.escalated_at,
    reopenCount: row.reopen_count,
    deferredBacklogItemId: row.deferred_backlog_item_id,
    classificationReason: row.classification_reason,
    resolutionNote: row.resolution_note,
  };
}

function rowToCloseCheck(row: GoalCloseCheckRow): GoalCloseCheck {
  return {
    checkId: row.check_id,
    goalId: row.goal_id,
    conditionId: row.condition_id,
    status: row.status,
    checkedAt: row.checked_at,
    checkedBy: row.checked_by,
    evidence: parseRecord(row.evidence_json),
    message: row.message,
  };
}

function rowToDecision(row: GoalDecisionRow): GoalConvergenceDecisionRecord {
  return {
    decisionId: row.decision_id,
    goalId: row.goal_id,
    cycleId: row.cycle_id,
    attemptId: row.attempt_id,
    decision: row.decision,
    reason: row.reason,
    metrics: parseRecord(row.metrics_json),
    recommendedNextAction:
      row.recommended_next_action === null
        ? null
        : (JSON.parse(row.recommended_next_action) as GoalNextAction),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function addWhere(
  clauses: string[],
  args: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  clauses.push(`${column} = ?`);
  args.push(value);
}

function whereSql(clauses: string[]): string {
  return clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
}
