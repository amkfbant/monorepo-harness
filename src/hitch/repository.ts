import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BacklogItem } from "../core/backlog.js";
import {
  insertBacklogItemInTransaction,
  type PreparedAddBacklogItemInput,
} from "../core/backlog-db.js";
import { DbError } from "../db/connection.js";
import { hitchFindingStableKey } from "./stable-key.js";
import {
  parseHitchCloseConditions,
  parseHitchPolicy,
  parseHitchScope,
} from "./schemas.js";
import {
  DEFAULT_HITCH_POLICY,
  type HitchAttempt,
  type HitchAttemptStatus,
  type HitchAttemptType,
  type HitchCloseCheck,
  type HitchCloseCheckStatus,
  type HitchCloseCondition,
  type HitchConvergenceDecision,
  type HitchConvergenceDecisionRecord,
  type HitchCreatedSource,
  type HitchFinding,
  type HitchFindingSeverity,
  type HitchFindingSource,
  type HitchLifecycleEvent,
  type HitchLifecycleEventName,
  type HitchLifecycleStatus,
  type HitchNextAction,
  type HitchPolicy,
  type HitchReviewCycle,
  type HitchReviewMode,
  type HitchScope,
  type HitchScopeStatus,
  type HitchSession,
  type HitchStatus,
} from "./types.js";

export interface CreateHitchSessionInput {
  hitchId?: string;
  title: string;
  description?: string;
  projectId?: string;
  repoId?: string;
  domain?: string;
  backlogItemId?: string;
  scope?: HitchScope;
  closeConditions?: HitchCloseCondition[];
  policy?: HitchPolicy;
  maxIterations?: number;
  maxReviewCycles?: number;
  maxReruns?: number;
  maxTotalNewFindings?: number;
  createdBy: string;
  createdSource: HitchCreatedSource;
  createdAt?: string;
}

export interface HitchSessionFilter {
  status?: HitchStatus;
  projectId?: string;
  repoId?: string;
  domain?: string;
  limit?: number;
}

export interface CreateHitchAttemptInput {
  attemptId?: string;
  hitchId: string;
  iteration?: number;
  attemptType: HitchAttemptType;
  status?: HitchAttemptStatus;
  operationId?: string;
  runId?: string;
  parentAttemptId?: string;
  input?: Record<string, unknown>;
  startedAt?: string;
  createdAt?: string;
}

export interface CompleteHitchAttemptInput {
  attemptId: string;
  status: Exclude<HitchAttemptStatus, "pending" | "running">;
  operationId?: string;
  runId?: string;
  result?: Record<string, unknown>;
  errorMessage?: string;
  completedAt?: string;
}

export interface StartHitchReviewCycleInput {
  cycleId?: string;
  hitchId: string;
  cycleNumber?: number;
  reviewMode: HitchReviewMode;
  triggerAttemptId?: string;
  sourceReviewId?: string;
  sourceRunId?: string;
  createdAt?: string;
}

export interface CompleteHitchReviewCycleInput {
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

export interface UpsertHitchFindingInput {
  findingId?: string;
  hitchId: string;
  stableKey?: string;
  duplicateOf?: string;
  source: HitchFindingSource;
  sourceRef?: string;
  sourceAttemptId?: string;
  sourceCycleId?: string;
  severity: HitchFindingSeverity;
  category: string;
  scopeStatus?: HitchScopeStatus;
  lifecycleStatus?: HitchLifecycleStatus;
  summary: string;
  detail?: string;
  filePath?: string;
  symbol?: string;
  suggestedFix?: string;
  seenAt?: string;
  classificationReason?: string;
}

export interface UpsertHitchFindingResult {
  finding: HitchFinding;
  created: boolean;
  reopened: boolean;
}

export interface ClassifyHitchFindingInput {
  findingId: string;
  scopeStatus: HitchScopeStatus;
  reason: string;
  duplicateOf?: string;
  classifiedAt?: string;
}

export interface MarkHitchFindingFixedInput {
  findingId: string;
  note?: string;
  fixedAt?: string;
}

export interface DeferHitchFindingInput {
  findingId: string;
  note?: string;
  backlogItemId?: string;
  deferredAt?: string;
}

export interface ClassifyAndDeferHitchFindingInput {
  findingId: string;
  reason: string;
  now?: Date;
  backlogItem?: {
    input: PreparedAddBacklogItemInput;
    fsFloor: number;
  };
}

export interface ClassifyAndDeferHitchFindingResult {
  finding: HitchFinding;
  backlogItemId: string | null;
  backlogItem?: BacklogItem;
  createdBacklogItem: boolean;
}

export interface HitchFindingFilter {
  hitchId?: string;
  scopeStatus?: HitchScopeStatus;
  scopeStatusIn?: readonly HitchScopeStatus[];
  lifecycleStatus?: HitchLifecycleStatus;
  lifecycleStatusIn?: readonly HitchLifecycleStatus[];
  severity?: HitchFindingSeverity;
  severityIn?: readonly HitchFindingSeverity[];
  limit?: number;
}

export interface HitchFindingSummaryCounts {
  openInScopeP0: number;
  openInScopeP1: number;
  openInScopeP2: number;
  openUnknownScope: number;
  openOutOfScope: number;
}

export interface RecordHitchCloseCheckInput {
  checkId?: string;
  hitchId: string;
  conditionId: string;
  status: HitchCloseCheckStatus;
  checkedAt?: string;
  checkedBy: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

export interface RecordHitchConvergenceDecisionInput {
  decisionId?: string;
  hitchId: string;
  cycleId?: string;
  attemptId?: string;
  decision: HitchConvergenceDecision;
  reason: string;
  metrics?: Record<string, unknown>;
  recommendedNextAction?: HitchNextAction;
  createdAt?: string;
  createdBy: string;
}

export interface UpdateHitchStatusOptions {
  createdBy: string;
  now?: string;
}

export interface ReopenHitchSessionOptions {
  reason: string;
  createdBy: string;
  extendIterations?: number;
  extendReviewCycles?: number;
  extendReruns?: number;
  now?: string;
}

interface HitchSessionRow {
  hitch_id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  repo_id: string | null;
  domain: string | null;
  backlog_item_id: string | null;
  status: HitchStatus;
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
  created_source: HitchCreatedSource;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_summary: string | null;
  escalation_reason: string | null;
}

interface HitchAttemptRow {
  attempt_id: string;
  hitch_id: string;
  iteration: number;
  attempt_type: HitchAttemptType;
  status: HitchAttemptStatus;
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

interface HitchReviewCycleRow {
  cycle_id: string;
  hitch_id: string;
  cycle_number: number;
  review_mode: HitchReviewMode;
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

interface HitchFindingRow {
  finding_id: string;
  hitch_id: string;
  stable_key: string;
  duplicate_of: string | null;
  source: HitchFindingSource;
  source_ref: string | null;
  source_attempt_id: string | null;
  source_cycle_id: string | null;
  severity: HitchFindingSeverity;
  category: string;
  scope_status: HitchScopeStatus;
  lifecycle_status: HitchLifecycleStatus;
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

interface HitchFindingSummaryRow {
  scope_status: HitchScopeStatus;
  severity: HitchFindingSeverity;
  lifecycle_status: HitchLifecycleStatus;
  n: number;
}

interface HitchCloseCheckRow {
  check_id: string;
  hitch_id: string;
  condition_id: string;
  status: HitchCloseCheckStatus;
  checked_at: string;
  checked_by: string;
  evidence_json: string;
  message: string | null;
}

interface HitchDecisionRow {
  decision_id: string;
  hitch_id: string;
  cycle_id: string | null;
  attempt_id: string | null;
  decision: HitchConvergenceDecision;
  reason: string;
  metrics_json: string;
  recommended_next_action: string | null;
  created_at: string;
  created_by: string;
}

interface HitchLifecycleEventRow {
  event_id: string;
  hitch_id: string;
  event: HitchLifecycleEventName;
  reason: string;
  detail_json: string | null;
  created_at: string;
  created_by: string;
}

/** Clamp a budget extension to a non-negative integer; non-finite (e.g. a NaN
 * from a bad CLI string) becomes 0 rather than reaching the SQL bind. */
function nonNegInt(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;
}

/** Terminal statuses a hitch can be reopened from (#76). `cancelled` is a
 * deliberate abandon and is excluded.
 *
 * `diverging` is intentionally NOT reopenable: divergence triggers
 * (totalNewFindings, maxReopenCount, non-decreasing finding counts) derive from
 * immutable history, and `reopenSession` only extends iteration/review/rerun
 * budgets — not the divergence budget. A reopened diverging hitch would re-fire
 * `diverging` on its very next convergence evaluation and re-block every
 * mutation, leaving the operator no way out. Reopening a diverging hitch needs a
 * divergence-budget extension design (see docs/future-features.md). */
const REOPENABLE_STATUSES: ReadonlySet<HitchStatus> = new Set<HitchStatus>([
  "closed",
  "budget_exhausted",
  "escalated",
]);

export const OPEN_FINDING_LIFECYCLES = [
  "open",
  "reopened",
  "escalated",
] as const satisfies readonly HitchLifecycleStatus[];

export const UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES = [
  "open",
  "reopened",
  "out_of_scope",
  "escalated",
] as const satisfies readonly HitchLifecycleStatus[];

const OPEN_FINDING_LIFECYCLE_SET = new Set<HitchLifecycleStatus>(
  OPEN_FINDING_LIFECYCLES,
);
const UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET =
  new Set<HitchLifecycleStatus>(UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES);

export class HitchRepository {
  constructor(private readonly db: Database.Database) {}

  createSession(input: CreateHitchSessionInput): HitchSession {
    const now = input.createdAt ?? new Date().toISOString();
    const hitchId = input.hitchId ?? `hitch-${randomUUID()}`;
    const policy = input.policy ?? DEFAULT_HITCH_POLICY;
    const maxTotalNewFindings =
      input.maxTotalNewFindings ??
      policy.divergence.maxTotalNewFindings;
    this.db
      .prepare(
        `INSERT INTO hitch_sessions (
           hitch_id, title, description, project_id, repo_id, domain,
           backlog_item_id, status, scope_json, close_conditions_json,
           policy_json, max_iterations, max_review_cycles, max_reruns,
           max_total_new_findings, current_iteration, current_review_cycle,
           created_by, created_source, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 0, 0,
           ?, ?, ?, ?)`,
      )
      .run(
        hitchId,
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
    return this.requireSession(hitchId);
  }

  getSession(hitchId: string): HitchSession | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_sessions WHERE hitch_id = ?")
      .get(hitchId) as HitchSessionRow | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  requireSession(hitchId: string): HitchSession {
    const session = this.getSession(hitchId);
    if (session === null) throw new DbError(`hitch not found: ${hitchId}`);
    return session;
  }

  listSessions(filter: HitchSessionFilter = {}): HitchSession[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    addWhere(clauses, args, "status", filter.status);
    addWhere(clauses, args, "project_id", filter.projectId);
    addWhere(clauses, args, "repo_id", filter.repoId);
    addWhere(clauses, args, "domain", filter.domain);
    const limit = filter.limit ?? 50;
    const sql =
      "SELECT * FROM hitch_sessions" +
      whereSql(clauses) +
      " ORDER BY updated_at DESC, hitch_id DESC LIMIT ?";
    const rows = this.db.prepare(sql).all(...args, limit) as HitchSessionRow[];
    return rows.map(rowToSession);
  }

  updateStatus(
    hitchId: string,
    status: HitchStatus,
    note: string | undefined,
    opts: UpdateHitchStatusOptions,
  ): HitchSession {
    const now = opts.now ?? new Date().toISOString();
    const closedAt =
      status === "closed" || status === "cancelled" ? now : null;
    const escalationReason = status === "escalated" ? note ?? null : null;
    const closeSummary = status === "closed" ? note ?? null : null;
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE hitch_sessions
              SET status = ?, updated_at = ?,
                  closed_at = COALESCE(?, closed_at),
                  close_summary = COALESCE(?, close_summary),
                  escalation_reason = COALESCE(?, escalation_reason)
            WHERE hitch_id = ?`,
        )
        .run(status, now, closedAt, closeSummary, escalationReason, hitchId);
      if (result.changes !== 1) throw new DbError(`hitch not found: ${hitchId}`);
      if (status === "closed" || status === "cancelled") {
        this.insertLifecycleEvent({
          hitchId,
          event: status,
          reason: note ?? "",
          detail: null,
          createdAt: now,
          createdBy: opts.createdBy,
        });
      }
      return this.requireSession(hitchId);
    });
    return tx.immediate();
  }

  /**
   * #76 / #104 — resume a terminal hitch (closed / budget_exhausted / escalated /
   * diverging) so a late-discovered finding can be fixed on the existing branch
   * instead of closing the PR and re-implementing. Transitions back to `open`,
   * clears the terminal markers `updateStatus` would COALESCE-preserve
   * (`closed_at` / `close_summary` / `escalation_reason`), and extends the
   * budget (existing columns — no schema change) so a budget_exhausted hitch does
   * not immediately re-exhaust. State transition only (harness-driven, audited
   * by the caller). `cancelled` is a deliberate abandon and is NOT reopenable.
   */
  reopenSession(
    hitchId: string,
    opts: ReopenHitchSessionOptions,
  ): HitchSession {
    const session = this.requireSession(hitchId);
    if (!REOPENABLE_STATUSES.has(session.status)) {
      throw new Error(
        `hitch ${hitchId} is "${session.status}", not a reopenable terminal ` +
          `status (${[...REOPENABLE_STATUSES].join(", ")})`,
      );
    }
    const now = opts.now ?? new Date().toISOString();
    const extendIterations = nonNegInt(opts.extendIterations);
    const extendReviewCycles = nonNegInt(opts.extendReviewCycles);
    const extendReruns = nonNegInt(opts.extendReruns);
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE hitch_sessions
              SET status = 'open', updated_at = ?,
                  closed_at = NULL, close_summary = NULL, escalation_reason = NULL,
                  max_iterations = max_iterations + ?,
                  max_review_cycles = max_review_cycles + ?,
                  max_reruns = max_reruns + ?
            WHERE hitch_id = ?`,
        )
        .run(
          now,
          extendIterations,
          extendReviewCycles,
          extendReruns,
          hitchId,
        );
      if (result.changes !== 1) throw new DbError(`hitch not found: ${hitchId}`);
      this.insertLifecycleEvent({
        hitchId,
        event: "reopened",
        reason: opts.reason,
        detail: {
          previousStatus: session.status,
          budgetExtensions: {
            iterations: extendIterations,
            reviewCycles: extendReviewCycles,
            reruns: extendReruns,
          },
        },
        createdAt: now,
        createdBy: opts.createdBy,
      });
      return this.requireSession(hitchId);
    });
    return tx.immediate();
  }

  listLifecycleEvents(hitchId: string): HitchLifecycleEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_lifecycle_events
          WHERE hitch_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(hitchId) as HitchLifecycleEventRow[];
    return rows.map(rowToLifecycleEvent);
  }

  createAttempt(input: CreateHitchAttemptInput): HitchAttempt {
    const now = input.createdAt ?? new Date().toISOString();
    const attemptId = input.attemptId ?? `attempt-${randomUUID()}`;
    const iteration = input.iteration ?? this.nextIteration(input.hitchId);
    this.db
      .prepare(
        `INSERT INTO hitch_attempts (
           attempt_id, hitch_id, iteration, attempt_type, status,
           operation_id, run_id, parent_attempt_id, input_json,
           result_json, started_at, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        attemptId,
        input.hitchId,
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
    this.touchSession(input.hitchId, now);
    return this.requireAttempt(attemptId);
  }

  completeAttempt(input: CompleteHitchAttemptInput): HitchAttempt {
    const now = input.completedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE hitch_attempts
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
    this.touchSession(attempt.hitchId, now);
    return attempt;
  }

  discardAttempt(attemptId: string, now = new Date().toISOString()): void {
    const tx = this.db.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (attempt === null) return;
      this.db
        .prepare("DELETE FROM hitch_attempts WHERE attempt_id = ?")
        .run(attemptId);
      this.db
        .prepare(
          `UPDATE hitch_sessions
              SET current_iteration = (
                    SELECT COALESCE(MAX(iteration), 0)
                      FROM hitch_attempts
                     WHERE hitch_id = ?
                  ),
                  updated_at = ?
            WHERE hitch_id = ?`,
        )
        .run(attempt.hitchId, now, attempt.hitchId);
    });
    tx.immediate();
  }

  getAttempt(attemptId: string): HitchAttempt | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_attempts WHERE attempt_id = ?")
      .get(attemptId) as HitchAttemptRow | undefined;
    return row === undefined ? null : rowToAttempt(row);
  }

  requireAttempt(attemptId: string): HitchAttempt {
    const attempt = this.getAttempt(attemptId);
    if (attempt === null) throw new DbError(`hitch attempt not found: ${attemptId}`);
    return attempt;
  }

  listAttempts(hitchId: string): HitchAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_attempts
          WHERE hitch_id = ?
          ORDER BY iteration ASC, created_at ASC`,
      )
      .all(hitchId) as HitchAttemptRow[];
    return rows.map(rowToAttempt);
  }

  startReviewCycle(input: StartHitchReviewCycleInput): HitchReviewCycle {
    const now = input.createdAt ?? new Date().toISOString();
    const cycleId = input.cycleId ?? `cycle-${randomUUID()}`;
    const cycleNumber =
      input.cycleNumber ?? this.nextReviewCycleNumber(input.hitchId);
    this.db
      .prepare(
        `INSERT INTO hitch_review_cycles (
           cycle_id, hitch_id, cycle_number, review_mode, trigger_attempt_id,
           source_review_id, source_run_id, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cycleId,
        input.hitchId,
        cycleNumber,
        input.reviewMode,
        input.triggerAttemptId ?? null,
        input.sourceReviewId ?? null,
        input.sourceRunId ?? null,
        now,
      );
    this.db
      .prepare(
        `UPDATE hitch_sessions
            SET current_review_cycle = MAX(current_review_cycle, ?),
                updated_at = ?
          WHERE hitch_id = ?`,
      )
      .run(cycleNumber, now, input.hitchId);
    return this.requireReviewCycle(cycleId);
  }

  completeReviewCycle(input: CompleteHitchReviewCycleInput): HitchReviewCycle {
    const now = input.completedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE hitch_review_cycles
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
    this.touchSession(cycle.hitchId, now);
    return cycle;
  }

  getReviewCycle(cycleId: string): HitchReviewCycle | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_review_cycles WHERE cycle_id = ?")
      .get(cycleId) as HitchReviewCycleRow | undefined;
    return row === undefined ? null : rowToReviewCycle(row);
  }

  requireReviewCycle(cycleId: string): HitchReviewCycle {
    const cycle = this.getReviewCycle(cycleId);
    if (cycle === null) throw new DbError(`hitch review cycle not found: ${cycleId}`);
    return cycle;
  }

  listReviewCycles(hitchId: string): HitchReviewCycle[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_review_cycles
          WHERE hitch_id = ?
          ORDER BY cycle_number ASC`,
      )
      .all(hitchId) as HitchReviewCycleRow[];
    return rows.map(rowToReviewCycle);
  }

  upsertFinding(input: UpsertHitchFindingInput): UpsertHitchFindingResult {
    const now = input.seenAt ?? new Date().toISOString();
    const stableKey =
      input.stableKey ??
      hitchFindingStableKey({
        filePath: input.filePath,
        symbol: input.symbol,
        category: input.category,
        summary: input.summary,
      });
    const scopeStatus = input.scopeStatus ?? "unknown";
    const duplicateOf =
      scopeStatus === "duplicate"
        ? this.requireCanonicalDuplicateFinding(
            input.hitchId,
            input.findingId,
            input.duplicateOf,
          )
        : null;
    const lifecycleStatus =
      input.lifecycleStatus ?? defaultLifecycleForScope(scopeStatus);
    const tx = this.db.transaction((): UpsertHitchFindingResult => {
      const existing = this.db
        .prepare(
          `SELECT finding_id, lifecycle_status, severity, duplicate_of
             FROM hitch_findings
            WHERE hitch_id = ? AND stable_key = ?
            ORDER BY
              CASE WHEN duplicate_of IS NULL THEN 0 ELSE 1 END,
              first_seen_at ASC,
              finding_id ASC
            LIMIT 1`,
        )
        .get(input.hitchId, stableKey) as
        | {
            finding_id: string;
            lifecycle_status: HitchLifecycleStatus;
            severity: HitchFindingSeverity;
            duplicate_of: string | null;
          }
        | undefined;
      if (existing !== undefined) {
        const duplicateCanonical = duplicateOf ?? existing.duplicate_of;
        let canonicalReopened = false;
        if (duplicateCanonical !== null) {
          canonicalReopened = this.promoteDuplicateCanonical(
            duplicateCanonical,
            input.severity,
            now,
          );
        }
        const reopened = existing.lifecycle_status === "fixed" || canonicalReopened;
        const severity = moreSevere(existing.severity, input.severity);
        this.db
          .prepare(
            `UPDATE hitch_findings
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
        this.touchSession(input.hitchId, now);
        return {
          finding: this.requireFinding(existing.finding_id),
          created: false,
          reopened,
        };
      }

      const reopened =
        duplicateOf !== null
          ? this.promoteDuplicateCanonical(duplicateOf, input.severity, now)
          : false;
      const findingId = input.findingId ?? `finding-${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO hitch_findings (
             finding_id, hitch_id, stable_key, duplicate_of, source,
             source_ref, source_attempt_id, source_cycle_id, severity,
             category, scope_status, lifecycle_status, summary, detail,
             file_path, symbol, suggested_fix, first_seen_at, last_seen_at,
             classification_reason
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          findingId,
          input.hitchId,
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
      this.touchSession(input.hitchId, now);
      return {
        finding: this.requireFinding(findingId),
        created: true,
        reopened,
      };
    });
    return tx.immediate();
  }

  classifyFinding(input: ClassifyHitchFindingInput): HitchFinding {
    const now = input.classifiedAt ?? new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    const duplicateOf =
      input.scopeStatus === "duplicate"
        ? this.requireCanonicalDuplicateFinding(
            current.hitchId,
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
        `UPDATE hitch_findings
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
    this.touchSession(current.hitchId, now);
    if (duplicateOf !== null) {
      this.promoteDuplicateCanonical(duplicateOf, current.severity, now);
    }
    return this.requireFinding(input.findingId);
  }

  classifyAndDeferFinding(
    input: ClassifyAndDeferHitchFindingInput,
  ): ClassifyAndDeferHitchFindingResult {
    const nowDate = input.now ?? new Date();
    const now = nowDate.toISOString();
    const tx = this.db.transaction((): ClassifyAndDeferHitchFindingResult => {
      const current = this.requireFinding(input.findingId);
      this.classifyFinding({
        findingId: input.findingId,
        scopeStatus: "out_of_scope",
        reason: input.reason,
        classifiedAt: now,
      });
      const backlogItem =
        input.backlogItem === undefined
          ? null
          : insertBacklogItemInTransaction(
              this.db,
              input.backlogItem.input,
              nowDate,
              input.backlogItem.fsFloor,
            );
      const backlogItemId =
        backlogItem?.id ?? current.deferredBacklogItemId ?? undefined;
      const finding = this.deferFinding({
        findingId: input.findingId,
        note: input.reason,
        deferredAt: now,
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
      });
      return {
        finding,
        backlogItemId: finding.deferredBacklogItemId,
        ...(backlogItem !== null ? { backlogItem } : {}),
        createdBacklogItem: backlogItem !== null,
      };
    });
    return tx.immediate();
  }

  private requireCanonicalDuplicateFinding(
    hitchId: string,
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
    if (canonical.hitchId !== hitchId) {
      throw new DbError(
        `duplicate finding target belongs to a different hitch: ${duplicateOf}`,
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
    incomingSeverity: HitchFindingSeverity,
    now: string,
  ): boolean {
    const canonical = this.requireFinding(canonicalFindingId);
    const severity = moreSevere(canonical.severity, incomingSeverity);
    const reopened = canonical.lifecycleStatus === "fixed";
    this.db
      .prepare(
        `UPDATE hitch_findings
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
    return reopened;
  }

  markFindingFixed(input: MarkHitchFindingFixedInput): HitchFinding {
    const now = input.fixedAt ?? new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    this.db
      .prepare(
        `UPDATE hitch_findings
            SET lifecycle_status = 'fixed', fixed_at = ?,
                resolution_note = COALESCE(?, resolution_note),
                deferred_at = NULL,
                deferred_backlog_item_id = NULL,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(now, input.note ?? null, now, input.findingId);
    this.touchSession(current.hitchId, now);
    return this.requireFinding(input.findingId);
  }

  deferFinding(input: DeferHitchFindingInput): HitchFinding {
    const now = input.deferredAt ?? new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    if (current.scopeStatus !== "out_of_scope") {
      throw new DbError(
        `hitch finding ${input.findingId} cannot be deferred while scope is ${current.scopeStatus}; classify it out_of_scope first`,
      );
    }
    this.db
      .prepare(
        `UPDATE hitch_findings
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
    this.touchSession(current.hitchId, now);
    return this.requireFinding(input.findingId);
  }

  getFinding(findingId: string): HitchFinding | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_findings WHERE finding_id = ?")
      .get(findingId) as HitchFindingRow | undefined;
    return row === undefined ? null : rowToFinding(row);
  }

  requireFinding(findingId: string): HitchFinding {
    const finding = this.getFinding(findingId);
    if (finding === null) throw new DbError(`hitch finding not found: ${findingId}`);
    return finding;
  }

  listFindings(filter: HitchFindingFilter = {}): HitchFinding[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    addFindingWhereClauses(clauses, args, filter);
    const limit = filter.limit ?? 200;
    const rows = this.db
      .prepare(
        "SELECT * FROM hitch_findings" +
          whereSql(clauses) +
          " ORDER BY first_seen_at ASC, finding_id ASC LIMIT ?",
      )
      .all(...args, limit) as HitchFindingRow[];
    return rows.map(rowToFinding);
  }

  countFindings(filter: HitchFindingFilter = {}): number {
    const clauses: string[] = [];
    const args: unknown[] = [];
    addFindingWhereClauses(clauses, args, filter);
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM hitch_findings" + whereSql(clauses),
      )
      .get(...args) as { n: number };
    return row.n;
  }

  countFindingSummary(hitchId: string): HitchFindingSummaryCounts {
    const activePlaceholders = placeholders(OPEN_FINDING_LIFECYCLES.length);
    const outOfScopePlaceholders = placeholders(
      UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES.length,
    );
    const rows = this.db
      .prepare(
        `SELECT scope_status, severity, lifecycle_status, COUNT(*) AS n
           FROM hitch_findings
          WHERE hitch_id = ?
            AND (
              lifecycle_status IN (${activePlaceholders})
              OR (
                scope_status = 'out_of_scope'
                AND lifecycle_status IN (${outOfScopePlaceholders})
              )
            )
          GROUP BY scope_status, severity, lifecycle_status`,
      )
      .all(
        hitchId,
        ...OPEN_FINDING_LIFECYCLES,
        ...UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
      ) as HitchFindingSummaryRow[];

    const counts: HitchFindingSummaryCounts = {
      openInScopeP0: 0,
      openInScopeP1: 0,
      openInScopeP2: 0,
      openUnknownScope: 0,
      openOutOfScope: 0,
    };
    for (const row of rows) {
      if (row.scope_status === "out_of_scope") {
        if (
          UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET.has(
            row.lifecycle_status,
          )
        ) {
          counts.openOutOfScope += row.n;
        }
        continue;
      }
      if (!OPEN_FINDING_LIFECYCLE_SET.has(row.lifecycle_status)) continue;
      if (row.scope_status === "unknown") {
        counts.openUnknownScope += row.n;
      } else if (row.scope_status === "in_scope") {
        if (row.severity === "P0") counts.openInScopeP0 += row.n;
        else if (row.severity === "P1") counts.openInScopeP1 += row.n;
        else if (row.severity === "P2") counts.openInScopeP2 += row.n;
      }
    }
    return counts;
  }

  maxFindingReopenCount(hitchId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(reopen_count), 0) AS n
           FROM hitch_findings
          WHERE hitch_id = ?`,
      )
      .get(hitchId) as { n: number };
    return row.n;
  }

  latestFindingMutationAt(hitchId: string): string | null {
    const row = this.db
      .prepare(
        `WITH finding_mutations(ts) AS (
           SELECT last_seen_at FROM hitch_findings WHERE hitch_id = ?
           UNION ALL
           SELECT fixed_at FROM hitch_findings
            WHERE hitch_id = ? AND fixed_at IS NOT NULL
           UNION ALL
           SELECT deferred_at FROM hitch_findings
            WHERE hitch_id = ? AND deferred_at IS NOT NULL
           UNION ALL
           SELECT escalated_at FROM hitch_findings
            WHERE hitch_id = ? AND escalated_at IS NOT NULL
         )
         SELECT MAX(ts) AS latest FROM finding_mutations`,
      )
      .get(hitchId, hitchId, hitchId, hitchId) as { latest: string | null };
    return row.latest;
  }

  recordCloseCheck(input: RecordHitchCloseCheckInput): HitchCloseCheck {
    const checkedAt = input.checkedAt ?? new Date().toISOString();
    const checkId = input.checkId ?? `check-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO hitch_close_checks (
           check_id, hitch_id, condition_id, status, checked_at, checked_by,
           evidence_json, message
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkId,
        input.hitchId,
        input.conditionId,
        input.status,
        checkedAt,
        input.checkedBy,
        json(input.evidence ?? {}),
        input.message ?? null,
      );
    this.touchSession(input.hitchId, checkedAt);
    return this.requireCloseCheck(checkId);
  }

  getCloseCheck(checkId: string): HitchCloseCheck | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_close_checks WHERE check_id = ?")
      .get(checkId) as HitchCloseCheckRow | undefined;
    return row === undefined ? null : rowToCloseCheck(row);
  }

  requireCloseCheck(checkId: string): HitchCloseCheck {
    const check = this.getCloseCheck(checkId);
    if (check === null) throw new DbError(`hitch close check not found: ${checkId}`);
    return check;
  }

  listCloseChecks(hitchId: string): HitchCloseCheck[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_close_checks
          WHERE hitch_id = ?
          ORDER BY checked_at ASC, check_id ASC`,
      )
      .all(hitchId) as HitchCloseCheckRow[];
    return rows.map(rowToCloseCheck);
  }

  recordConvergenceDecision(
    input: RecordHitchConvergenceDecisionInput,
  ): HitchConvergenceDecisionRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const decisionId = input.decisionId ?? `decision-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO hitch_convergence_decisions (
           decision_id, hitch_id, cycle_id, attempt_id, decision, reason,
           metrics_json, recommended_next_action, created_at, created_by
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decisionId,
        input.hitchId,
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
    this.touchSession(input.hitchId, createdAt);
    return this.requireDecision(decisionId);
  }

  getDecision(decisionId: string): HitchConvergenceDecisionRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM hitch_convergence_decisions WHERE decision_id = ?",
      )
      .get(decisionId) as HitchDecisionRow | undefined;
    return row === undefined ? null : rowToDecision(row);
  }

  requireDecision(decisionId: string): HitchConvergenceDecisionRecord {
    const decision = this.getDecision(decisionId);
    if (decision === null) {
      throw new DbError(`hitch convergence decision not found: ${decisionId}`);
    }
    return decision;
  }

  listDecisions(hitchId: string): HitchConvergenceDecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_convergence_decisions
          WHERE hitch_id = ?
          ORDER BY created_at ASC, decision_id ASC`,
      )
      .all(hitchId) as HitchDecisionRow[];
    return rows.map(rowToDecision);
  }

  private insertLifecycleEvent(input: {
    hitchId: string;
    event: HitchLifecycleEventName;
    reason: string;
    detail: Record<string, unknown> | null;
    createdAt: string;
    createdBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO hitch_lifecycle_events (
           event_id, hitch_id, event, reason, detail_json, created_at, created_by
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `event-${randomUUID()}`,
        input.hitchId,
        input.event,
        input.reason,
        input.detail === null ? null : json(input.detail),
        input.createdAt,
        input.createdBy,
      );
  }

  private nextIteration(hitchId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(iteration), 0) + 1 AS n FROM hitch_attempts WHERE hitch_id = ?",
      )
      .get(hitchId) as { n: number };
    this.db
      .prepare(
        `UPDATE hitch_sessions
            SET current_iteration = MAX(current_iteration, ?),
                updated_at = ?
          WHERE hitch_id = ?`,
      )
      .run(row.n, new Date().toISOString(), hitchId);
    return row.n;
  }

  private nextReviewCycleNumber(hitchId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(cycle_number), 0) + 1 AS n FROM hitch_review_cycles WHERE hitch_id = ?",
      )
      .get(hitchId) as { n: number };
    return row.n;
  }

  private touchSession(hitchId: string, updatedAt: string): void {
    this.db
      .prepare("UPDATE hitch_sessions SET updated_at = ? WHERE hitch_id = ?")
      .run(updatedAt, hitchId);
  }
}

function defaultLifecycleForScope(
  scopeStatus: HitchScopeStatus,
): HitchLifecycleStatus {
  if (scopeStatus === "out_of_scope") return "out_of_scope";
  if (scopeStatus === "duplicate") return "duplicate";
  return "open";
}

function moreSevere(
  current: HitchFindingSeverity,
  incoming: HitchFindingSeverity,
): HitchFindingSeverity {
  const rank: Record<HitchFindingSeverity, number> = {
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

function rowToSession(row: HitchSessionRow): HitchSession {
  return {
    hitchId: row.hitch_id,
    title: row.title,
    description: row.description,
    projectId: row.project_id,
    repoId: row.repo_id,
    domain: row.domain,
    backlogItemId: row.backlog_item_id,
    status: row.status,
    scope: parseHitchScope(JSON.parse(row.scope_json) as unknown),
    closeConditions: parseHitchCloseConditions(
      JSON.parse(row.close_conditions_json) as unknown,
    ),
    policy: parseHitchPolicy(JSON.parse(row.policy_json) as unknown),
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

function rowToAttempt(row: HitchAttemptRow): HitchAttempt {
  return {
    attemptId: row.attempt_id,
    hitchId: row.hitch_id,
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

function rowToReviewCycle(row: HitchReviewCycleRow): HitchReviewCycle {
  return {
    cycleId: row.cycle_id,
    hitchId: row.hitch_id,
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

function rowToFinding(row: HitchFindingRow): HitchFinding {
  return {
    findingId: row.finding_id,
    hitchId: row.hitch_id,
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

function rowToCloseCheck(row: HitchCloseCheckRow): HitchCloseCheck {
  return {
    checkId: row.check_id,
    hitchId: row.hitch_id,
    conditionId: row.condition_id,
    status: row.status,
    checkedAt: row.checked_at,
    checkedBy: row.checked_by,
    evidence: parseRecord(row.evidence_json),
    message: row.message,
  };
}

function rowToDecision(row: HitchDecisionRow): HitchConvergenceDecisionRecord {
  return {
    decisionId: row.decision_id,
    hitchId: row.hitch_id,
    cycleId: row.cycle_id,
    attemptId: row.attempt_id,
    decision: row.decision,
    reason: row.reason,
    metrics: parseRecord(row.metrics_json),
    recommendedNextAction:
      row.recommended_next_action === null
        ? null
        : (JSON.parse(row.recommended_next_action) as HitchNextAction),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function rowToLifecycleEvent(row: HitchLifecycleEventRow): HitchLifecycleEvent {
  return {
    eventId: row.event_id,
    hitchId: row.hitch_id,
    event: row.event,
    reason: row.reason,
    detail: row.detail_json === null ? null : parseRecord(row.detail_json),
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

function addWhereIn(
  clauses: string[],
  args: unknown[],
  column: string,
  values: readonly string[] | undefined,
): void {
  if (values === undefined) return;
  if (values.length === 0) {
    clauses.push("0 = 1");
    return;
  }
  clauses.push(`${column} IN (${placeholders(values.length)})`);
  args.push(...values);
}

function addFindingWhereClauses(
  clauses: string[],
  args: unknown[],
  filter: HitchFindingFilter,
): void {
  addWhere(clauses, args, "hitch_id", filter.hitchId);
  addWhere(clauses, args, "scope_status", filter.scopeStatus);
  addWhereIn(clauses, args, "scope_status", filter.scopeStatusIn);
  addWhere(clauses, args, "lifecycle_status", filter.lifecycleStatus);
  addWhereIn(clauses, args, "lifecycle_status", filter.lifecycleStatusIn);
  addWhere(clauses, args, "severity", filter.severity);
  addWhereIn(clauses, args, "severity", filter.severityIn);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function whereSql(clauses: string[]): string {
  return clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
}
