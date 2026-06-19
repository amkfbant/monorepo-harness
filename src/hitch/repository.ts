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
  findNearDuplicate,
  type NearDuplicateCandidate,
} from "./near-duplicate.js";
import {
  parseHitchCloseConditions,
  parseHitchPolicy,
  parseHitchScope,
} from "./schemas.js";
import { phaseSpecApprovalStatusForSpec } from "../roadmap/phase-repository.js";
import {
  CloseCheckRepository,
  type RecordHitchCloseCheckInput,
} from "./repositories/close-check-repository.js";
import {
  ConvergenceDecisionRepository,
  type RecordHitchConvergenceDecisionInput,
} from "./repositories/convergence-decision-repository.js";
import {
  closeConditionsLoosenGate,
  isScopeWidening,
} from "./spec-gates.js";
import { assertValidCloseConditions } from "./spec-validation.js";
import {
  ADVISORY_REVIEW_FINDING_CATEGORIES,
  DEFAULT_HITCH_POLICY,
  HARNESS_ORIGIN_FINDING_SOURCE_SET,
  HARNESS_ORIGIN_FINDING_SOURCES,
  REVIEW_BLOCKING_FINDING_CATEGORY_SET,
  type HitchAttempt,
  type HitchAttemptStatus,
  type HitchAttemptType,
  type HitchCloseCheck,
  type HitchCloseCondition,
  type HitchConvergenceDecisionRecord,
  type HitchCreatedSource,
  type HitchFinding,
  type HitchFindingSeverity,
  type HitchFindingSource,
  type HitchHarnessOriginDivergenceMetrics,
  type HitchLifecycleEvent,
  type HitchLifecycleEventName,
  type HitchLifecycleStatus,
  type HitchPolicy,
  type HitchReviewCycle,
  type HitchReviewMode,
  type HitchScope,
  type HitchScopeStatus,
  type HitchSession,
  type HitchStatus,
} from "./types.js";

// #125 Track C: concerns moved to per-concern sub-repos. Re-export their input
// types so the public module surface of `repository.ts` (and any consumer
// importing them from here) is unchanged.
// C1 — convergence-decision; C2 — close-check.
export type { RecordHitchConvergenceDecisionInput };
export type { RecordHitchCloseCheckInput };

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

/**
 * #278: input for {@link HitchRepository.resolveSupersededReviewFindings}. A later
 * APPROVING review cycle deterministically retires the prior cycles' review-origin
 * review-blocking findings for the SAME hitch. The trigger (canonical approve) is
 * computed by the harness from event-sourced review_decisions / review_consensus
 * rows — never an LLM "I fixed it" self-report.
 */
export interface ResolveSupersededReviewFindingsInput {
  /** Hitch whose prior review blockers are being superseded. */
  hitchId: string;
  /** The approving cycle that supersedes earlier blockers (same-cycle rows skipped). */
  supersedingCycleId: string;
  /** Allowlist of review-blocking categories to retire (REVIEW_BLOCKING_FINDING_CATEGORIES). */
  categories: readonly string[];
  /** Run id whose canonical APPROVE decision drove the supersession (audit trail). */
  decisionRunId: string;
  /** Deterministic resolution timestamp (defaults to now). */
  resolvedAt?: string;
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
  /**
   * Skip the first `offset` rows (paging). Used by the read-only classify Phase 1
   * snapshot to walk the whole unknown set deterministically without writes
   * shrinking it mid-pass (#230 round-2 FIX 1). Ignored when 0/undefined.
   */
  offset?: number;
}

export interface HitchFindingSummaryCounts {
  openInScopeP0: number;
  openInScopeP1: number;
  openInScopeP2: number;
  openUnknownScope: number;
  openOutOfScope: number;
}

export interface LinkedPhaseSpecApprovalDrift {
  phaseId: string;
  approvedSpecHash: string;
  currentSpecHash: string;
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

/** #280 — options for {@link HitchRepository.recoverDivergingSession}. The
 * deterministic open-P0/P1 + close-check gate is supplied by the CLI/caller as
 * `revalidate` and is RE-RUN INSIDE the write transaction (not just before it),
 * so a concurrent `finding add` / close-check transition / cancel-close-escalate
 * between the caller's pre-check and the commit cannot flip a stale hitch to
 * `open` (fail-closed under the shared DB lock). */
export interface RecoverDivergingSessionOptions {
  reason: string;
  createdBy: string;
  /** Amount added to `max_total_new_findings` so live re-derivation does not
   * immediately re-fire the cumulative trigger. Clamped to a non-negative int. */
  extendDivergenceBudget?: number;
  /** #280 P2#2 — deterministic gate re-validation, executed INSIDE the write
   * transaction against fresh DB state. MUST throw (fail-closed) on any unmet
   * invariant (status drift, open P0/P1/unknown, red/pending close-check,
   * non-recoverable divergence trigger, or a residual re-fire). The repo passes
   * itself so the callback recomputes from `ConvergenceService.evaluate()`
   * without the repo depending on the convergence layer. */
  revalidate?: (repo: HitchRepository) => void;
  now?: string;
}

export interface AdoptHitchPrInput {
  hitchId: string;
  prUrl?: string | null;
  prNumber?: number | null;
  reason: string;
  createdBy: string;
  now?: string;
}

export interface UpdateHitchSessionConfigInput {
  hitchId: string;
  scope?: HitchScope;
  closeConditions?: HitchCloseCondition[];
  policy?: HitchPolicy;
  reason: string;
  allowScopeWiden?: boolean;
  allowGateLoosen?: boolean;
  createdBy: string;
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

interface HitchFindingIdentityRow {
  finding_id: string;
  hitch_id: string;
  category: string;
  scope_status: HitchScopeStatus;
  summary: string;
  file_path: string | null;
  symbol: string | null;
}

interface HitchFindingSummaryRow {
  scope_status: HitchScopeStatus;
  severity: HitchFindingSeverity;
  lifecycle_status: HitchLifecycleStatus;
  n: number;
}

interface HitchDivergenceCycleFindingRow {
  cycle_id: string;
  cycle_number: number;
  findings_new: number;
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

interface LinkedPhaseSpecRow {
  phase_id: string;
  scope_json: string | null;
  close_conditions_json: string | null;
  review_state_json: string | null;
}

/** Clamp a budget extension to a non-negative integer; non-finite (e.g. a NaN
 * from a bad CLI string) becomes 0 rather than reaching the SQL bind. */
function nonNegInt(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;
}

/** Terminal statuses a hitch can be reopened from (#76). `cancelled` is a
 * deliberate abandon and is excluded.
 *
 * `diverging` is intentionally NOT reopenable — but it does not need to be:
 * since #164 a stored `diverging` status is RE-DERIVED live by the convergence
 * evaluator (it is not a cached terminal). A TRANSIENT trigger (per-cycle count /
 * non-decreasing) self-clears once a later review cycle is clean, returning the
 * hitch to normal flow with no reopen. `reopen` is still the wrong recovery for a
 * CUMULATIVE trigger (total-over-budget / max-reopen): those do not decrease, and
 * `reopenSession` extends only the iteration/review/rerun budgets — not the
 * divergence budget — so a reopened cumulatively-diverging hitch would re-fire
 * `diverging` at once. Recovering that case is handled by the separate
 * `recoverDivergingSession` / `hitch recover-diverging` path (deterministically
 * gated on open in-scope P0/P1 == 0 + all required close-checks green, then a
 * divergence-budget extension), NOT by reopen. */
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

/**
 * #278: marker prefix for the deterministic resolution_note written by
 * {@link HitchRepository.resolveSupersededReviewFindings}. The prefix lets the
 * re-resolve path distinguish a STALE prior harness auto-resolve note (which
 * names an older superseding cycle and is safe to refresh) from a genuine
 * operator-authored note (which is preserved). Changing this string would orphan
 * existing notes from the refresh path, so keep it stable.
 */
export const AUTO_RESOLVE_NOTE_PREFIX = "auto-resolved: superseded by approving review";

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

function isHarnessOriginFindingSource(source: HitchFindingSource): boolean {
  return HARNESS_ORIGIN_FINDING_SOURCE_SET.has(source);
}

const CONFIG_UPDATE_STATUSES = new Set<HitchStatus>([
  "open",
  "in_progress",
  "close_ready",
]);

const REOPEN_BEFORE_UPDATE_STATUSES = new Set<HitchStatus>([
  "closed",
  "budget_exhausted",
  "escalated",
]);

const CODING_RUN_ATTEMPT_TYPES = new Set<HitchAttemptType>([
  "implement",
  "rerun",
]);

export class HitchRepository {
  // #125 Track C: per-concern sub-repositories. Each is constructed with this
  // facade's `db` handle (no transaction of its own) so its writes compose
  // inside the facade's single-BEGIN atomic primitive (`runAtomically`). The
  // facade keeps every public method and forwards to the owning sub-repo.
  private readonly decisions: ConvergenceDecisionRepository;
  private readonly closeChecks: CloseCheckRepository;

  constructor(private readonly db: Database.Database) {
    this.decisions = new ConvergenceDecisionRepository(db);
    this.closeChecks = new CloseCheckRepository(db);
  }

  createSession(input: CreateHitchSessionInput): HitchSession {
    const now = input.createdAt ?? new Date().toISOString();
    const hitchId = input.hitchId ?? `hitch-${randomUUID()}`;
    const scope = parseHitchScope(input.scope ?? {});
    const closeConditions = parseHitchCloseConditions(
      input.closeConditions ?? [],
    );
    assertValidCloseConditions(closeConditions);
    const policy = parseHitchPolicy(input.policy ?? DEFAULT_HITCH_POLICY);
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
        json(scope),
        json(closeConditions),
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
   * #76 / #104 — resume a terminal hitch (closed / budget_exhausted / escalated)
   * so a late-discovered finding can be fixed on the existing branch instead of
   * closing the PR and re-implementing. (`diverging` is NOT reopenable — it
   * self-clears via live re-derivation; see REOPENABLE_STATUSES.) Transitions
   * back to `open`,
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

  /**
   * #280 — sanctioned recovery for a CUMULATIVELY/stickily `diverging` hitch
   * whose trigger does not self-clear via live re-derivation (a total-over-budget
   * trigger never decreases; see REOPENABLE_STATUSES). Returns it to live `open`
   * AND extends the divergence budget (`max_total_new_findings`) so re-derivation
   * does not immediately re-fire. This is NOT a gate-skip: the deterministic
   * close pre-gate (open in-scope P0/P1 == 0 AND all required close-checks green)
   * and the recoverable-trigger check are supplied by the caller (CLI) as
   * `opts.revalidate` and are RE-RUN INSIDE this write transaction against fresh
   * DB state (P2#2), so a concurrent mutation between the caller's pre-check and
   * the commit cannot land recovery on stale metrics — any unmet invariant
   * throws and aborts the whole transaction (fail-closed, no audit event).
   *
   * The status precondition is enforced ATOMICALLY (P2#1): the UPDATE is guarded
   * by `WHERE hitch_id = ? AND status = 'diverging'`, and zero changed rows is a
   * state-conflict error (a concurrent cancel/close/escalate slipped in) — never
   * a silent flip of a just-terminal hitch back to `open`. Leaves
   * `closed_at`/`close_summary`/`escalation_reason` untouched (diverging never
   * sets them). State transition only (harness-driven), audited as a
   * `diverging_recovered` lifecycle event in the immutable ledger.
   */
  recoverDivergingSession(
    hitchId: string,
    opts: RecoverDivergingSessionOptions,
  ): HitchSession {
    const session = this.requireSession(hitchId);
    if (session.status !== "diverging") {
      throw new Error(
        `hitch ${hitchId} is "${session.status}", not diverging; ` +
          `recover-diverging only applies to a diverging hitch`,
      );
    }
    const now = opts.now ?? new Date().toISOString();
    const extension = nonNegInt(opts.extendDivergenceBudget);
    const tx = this.db.transaction(() => {
      // P2#2 — re-derive the deterministic gate from fresh DB state INSIDE the
      // transaction. Throws fail-closed (aborting the tx, no mutation, no audit)
      // on any concurrent invariant violation.
      opts.revalidate?.(this);
      // Re-read under the write lock so the audit `previousMaxTotalNewFindings`
      // reflects the committed pre-state, not a value read before this tx.
      const current = this.requireSession(hitchId);
      const previousMaxTotalNewFindings = current.maxTotalNewFindings;
      // P2#1 — atomic status precondition: only flip a row that is STILL
      // diverging. A concurrent cancel/close/escalate makes this match 0 rows.
      const result = this.db
        .prepare(
          `UPDATE hitch_sessions
              SET status = 'open', updated_at = ?,
                  max_total_new_findings = max_total_new_findings + ?
            WHERE hitch_id = ? AND status = 'diverging'`,
        )
        .run(now, extension, hitchId);
      if (result.changes !== 1) {
        throw new Error(
          `hitch ${hitchId} is no longer diverging (concurrent state change); ` +
            `recover-diverging aborted (fail-closed)`,
        );
      }
      this.insertLifecycleEvent({
        hitchId,
        event: "diverging_recovered",
        reason: opts.reason,
        detail: {
          previousStatus: "diverging",
          divergenceBudgetExtension: extension,
          previousMaxTotalNewFindings,
          newMaxTotalNewFindings: previousMaxTotalNewFindings + extension,
        },
        createdAt: now,
        createdBy: opts.createdBy,
      });
      return this.requireSession(hitchId);
    });
    return tx.immediate();
  }

  adoptPr(input: AdoptHitchPrInput): HitchSession {
    if ((input.prUrl ?? null) === null && (input.prNumber ?? null) === null) {
      throw new Error("adoptPr requires prUrl or prNumber");
    }
    if (input.reason.trim() === "") {
      throw new Error("adoptPr requires a non-empty reason");
    }
    const now = input.now ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.requireSession(input.hitchId);
      const runId = this.latestCodingRunId(input.hitchId);
      const supersededPr = runId === null ? null : this.runPr(runId);
      this.insertLifecycleEvent({
        hitchId: input.hitchId,
        event: "pr_adopted",
        reason: input.reason,
        detail: {
          adoptedPr: {
            url: input.prUrl ?? null,
            number: input.prNumber ?? null,
          },
          supersededPr,
          runId,
        },
        createdAt: now,
        createdBy: input.createdBy,
      });
      this.touchSession(input.hitchId, now);
      return this.requireSession(input.hitchId);
    });
    return tx.immediate();
  }

  updateSessionConfig(input: UpdateHitchSessionConfigInput): HitchSession {
    if (
      input.scope === undefined &&
      input.closeConditions === undefined &&
      input.policy === undefined
    ) {
      throw new Error(
        "updateSessionConfig requires at least one of scope, closeConditions, or policy",
      );
    }
    if (input.reason.trim() === "") {
      throw new Error("updateSessionConfig requires a non-empty reason");
    }
    const nextScope =
      input.scope === undefined ? undefined : parseHitchScope(input.scope);
    const nextCloseConditions =
      input.closeConditions === undefined
        ? undefined
        : parseHitchCloseConditions(input.closeConditions);
    if (nextCloseConditions !== undefined) {
      assertValidCloseConditions(nextCloseConditions);
    }
    const nextPolicy =
      input.policy === undefined ? undefined : parseHitchPolicy(input.policy);
    const now = input.now ?? new Date().toISOString();

    const tx = this.db.transaction(() => {
      const session = this.requireSession(input.hitchId);
      assertConfigUpdateAllowed(session);
      if (
        nextScope !== undefined &&
        input.allowScopeWiden !== true &&
        isScopeWidening(session.scope, nextScope)
      ) {
        throw new Error(
          `hitch ${input.hitchId} scope widen requires --allow-scope-widen`,
        );
      }
      if (
        nextCloseConditions !== undefined &&
        input.allowGateLoosen !== true &&
        closeConditionsLoosenGate(session.closeConditions, nextCloseConditions)
      ) {
        throw new Error(
          `hitch ${input.hitchId} gate loosen requires --allow-gate-loosen`,
        );
      }
      if (
        nextPolicy !== undefined &&
        input.allowGateLoosen !== true &&
        policyLoosensGate(session.policy, nextPolicy)
      ) {
        throw new Error(
          `hitch ${input.hitchId} gate loosen requires --allow-gate-loosen`,
        );
      }

      const sets: string[] = [];
      const args: unknown[] = [];
      const updatedFields: string[] = [];
      const detail: Record<string, unknown> = { updatedFields };
      if (nextScope !== undefined) {
        sets.push("scope_json = ?");
        args.push(json(nextScope));
        updatedFields.push("scope");
        detail.previousScope = session.scope;
      }
      if (nextCloseConditions !== undefined) {
        sets.push("close_conditions_json = ?");
        args.push(json(nextCloseConditions));
        updatedFields.push("closeConditions");
        detail.previousCloseConditions = session.closeConditions;
      }
      if (nextPolicy !== undefined) {
        sets.push("policy_json = ?");
        args.push(json(nextPolicy));
        updatedFields.push("policy");
        detail.previousPolicy = session.policy;
      }
      sets.push("updated_at = ?");
      args.push(now, input.hitchId);
      const result = this.db
        .prepare(
          `UPDATE hitch_sessions
              SET ${sets.join(", ")}
            WHERE hitch_id = ?`,
        )
        .run(...args);
      if (result.changes !== 1) {
        throw new DbError(`hitch not found: ${input.hitchId}`);
      }
      this.insertLifecycleEvent({
        hitchId: input.hitchId,
        event: "updated",
        reason: input.reason,
        detail,
        createdAt: now,
        createdBy: input.createdBy,
      });
      return this.requireSession(input.hitchId);
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

  /**
   * Whether the hitch has an operator-adopted PR. adopt-pr is audit/status-only
   * for operator takeover, so an adopted PR is human-merge only — the merge
   * execution path (closeAndPr / auto-merge / await-merge) must refuse it. This
   * is the shared, fail-closed source for that guard.
   */
  hasAdoptedPr(hitchId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM hitch_lifecycle_events
          WHERE hitch_id = ? AND event = 'pr_adopted' LIMIT 1`,
      )
      .get(hitchId);
    return row !== undefined;
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

  /**
   * #306: run a write closure inside a SINGLE transaction so a set of
   * constituent writes commit together or not at all (all-or-nothing). The
   * closure MUST use the non-transactional `*Core` variants for any write that
   * otherwise opens its own transaction ({@link upsertFindingCore},
   * {@link resolveSupersededReviewFindingsCore}) to preserve the single-BEGIN
   * guarantee: better-sqlite3 would otherwise degrade a nested `.transaction()`
   * to a SAVEPOINT (it does NOT throw on a nested BEGIN), which still rolls back
   * to the savepoint on a throw but adds an inner boundary; using the cores keeps
   * a single BEGIN/COMMIT. Plain writers
   * that never open a transaction ({@link startReviewCycle},
   * {@link completeReviewCycle}, {@link recordCloseCheck}) may be called directly.
   * The transaction takes an immediate write lock at BEGIN (consistent with the
   * other mutating repository transactions). On any throw the whole closure rolls
   * back — no half-applied state.
   *
   * This is the atomicity primitive behind {@link importReviewProposalToHitch}:
   * its finding-import + supersede-resolve + cycle-completion (the #278
   * resolve-before-complete ordering) + review_consensus close-check evidence all
   * run inside one call here, closing the documented crash-partial windows where
   * prior review blockers could be left `fixed` while the approving cycle stayed
   * incomplete, or the cycle completed without its required close-check evidence.
   */
  runAtomically<T>(write: () => T): T {
    return this.db.transaction(write).immediate();
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
    // #306 / P3: keep the public wrapper's transaction boundary identical to the
    // pre-refactor version — run the pure prelude (now / stable-key / scope /
    // duplicate-canonical validation, which may throw) OUTSIDE the transaction, so
    // a validation throw fails before any BEGIN exactly as on main. Only the write
    // body runs inside the (same `immediate` variant) transaction.
    const prepared = this.prepareUpsertFinding(input);
    return this.db
      .transaction(
        (): UpsertHitchFindingResult =>
          this.upsertFindingWithin(input, prepared),
      )
      .immediate();
  }

  /**
   * #306: non-transactional core of {@link upsertFinding} for the atomic review
   * import (via {@link runAtomically} in `importReviewProposalToHitch`). Runs the
   * IDENTICAL prelude + read + write logic but does NOT open its own transaction,
   * so it composes inside the single outer BEGIN. Effect-equivalent to the public
   * method; the public method only differs in opening its own tx.
   */
  upsertFindingCore(input: UpsertHitchFindingInput): UpsertHitchFindingResult {
    return this.upsertFindingWithin(input, this.prepareUpsertFinding(input));
  }

  // #306 / P3: pure prelude shared by the public wrapper and the atomic-import
  // core. May throw (requireCanonicalDuplicateFinding) — the public wrapper calls
  // this BEFORE opening a transaction so the throw boundary matches main.
  private prepareUpsertFinding(input: UpsertHitchFindingInput): {
    now: string;
    stableKey: string;
    scopeStatus: HitchScopeStatus;
    explicitDuplicateOf: string | null;
  } {
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
    const explicitDuplicateOf =
      scopeStatus === "duplicate"
        ? this.requireCanonicalDuplicateFinding(
            input.hitchId,
            input.findingId,
            input.duplicateOf,
          )
        : null;
    return { now, stableKey, scopeStatus, explicitDuplicateOf };
  }

  // #306 / P3: the IDENTICAL write body of the former upsertFinding transaction —
  // no transaction is opened here, so it runs inside the caller's transaction (the
  // public wrapper's own tx, or the atomic import's outer BEGIN).
  private upsertFindingWithin(
    input: UpsertHitchFindingInput,
    prepared: {
      now: string;
      stableKey: string;
      scopeStatus: HitchScopeStatus;
      explicitDuplicateOf: string | null;
    },
  ): UpsertHitchFindingResult {
    const { now, stableKey, scopeStatus, explicitDuplicateOf } = prepared;
    {
      const existing = this.db
        .prepare(
          `SELECT finding_id, scope_status, lifecycle_status, severity,
                  duplicate_of, classification_reason
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
            scope_status: HitchScopeStatus;
            lifecycle_status: HitchLifecycleStatus;
            severity: HitchFindingSeverity;
            duplicate_of: string | null;
            classification_reason: string | null;
          }
        | undefined;
      if (existing !== undefined) {
        const duplicateCanonical = explicitDuplicateOf ?? existing.duplicate_of;
        const existingIsDuplicate = existing.duplicate_of !== null;
        let canonicalReopened = false;
        if (duplicateCanonical !== null) {
          canonicalReopened = this.promoteDuplicateCanonical(
            duplicateCanonical,
            input.severity,
            scopeStatus,
            input.lifecycleStatus ?? defaultLifecycleForScope(scopeStatus),
            input.summary,
            input.detail,
            input.source,
            now,
            {
              suppressFixedReopenCount: isNearDuplicateClassificationReason(
                existing.classification_reason,
              ),
            },
          );
        }
        const lifecycleStatus =
          input.lifecycleStatus ?? defaultLifecycleForScope(scopeStatus);
        const incomingCloseBlocker = incomingCloseBlockerCandidate(
          scopeStatus,
          lifecycleStatus,
          input.severity,
        );
        const scopeStatusToStore = existingIsDuplicate
          ? existing.scope_status
          : incomingCloseBlocker
            ? moreBlockingScope(existing.scope_status, scopeStatus)
            : existing.scope_status;
        const promoteLifecycleToReopened = existingIsDuplicate
          ? false
          : shouldReopenForIncoming(
              existing.lifecycle_status,
              scopeStatus,
              lifecycleStatus,
              input.severity,
            );
        const fixedReopen =
          !existingIsDuplicate &&
          existing.lifecycle_status === "fixed" &&
          incomingCloseBlocker;
        const promotesCanonical =
          !existingIsDuplicate &&
          (moreSevere(existing.severity, input.severity) !== existing.severity ||
            scopeStatusToStore !== existing.scope_status ||
            promoteLifecycleToReopened ||
            fixedReopen);
        const reopened = fixedReopen || promoteLifecycleToReopened || canonicalReopened;
        const severity = moreSevere(existing.severity, input.severity);
        const countReopen = isHarnessOriginFindingSource(input.source);
        this.db
          .prepare(
            `UPDATE hitch_findings
                SET last_seen_at = ?, source_ref = ?,
                    source_attempt_id = ?,
                    severity = ?,
                    scope_status = ?,
                    summary = CASE
                      WHEN ? THEN ?
                      ELSE summary
                    END,
                    detail = CASE
                      WHEN ? THEN COALESCE(?, detail)
                      ELSE detail
                    END,
                    suggested_fix = COALESCE(?, suggested_fix),
                    lifecycle_status = CASE
                      WHEN (lifecycle_status = 'fixed' AND ?) OR ? THEN 'reopened'
                      ELSE lifecycle_status
                    END,
                    fixed_at = CASE
                      WHEN (lifecycle_status = 'fixed' AND ?) OR ? THEN NULL
                      ELSE fixed_at
                    END,
                    deferred_at = CASE
                      WHEN ? THEN NULL
                      ELSE deferred_at
                    END,
                    deferred_backlog_item_id = CASE
                      WHEN ? THEN NULL
                      ELSE deferred_backlog_item_id
                    END,
                    reopen_count = CASE
                      WHEN ((lifecycle_status = 'fixed' AND ?) OR ?) AND ?
                        THEN reopen_count + 1
                      ELSE reopen_count
                    END
              WHERE finding_id = ?`,
          )
          .run(
            now,
            input.sourceRef ?? null,
            input.sourceAttemptId ?? null,
            severity,
            scopeStatusToStore,
            promotesCanonical ? 1 : 0,
            input.summary,
            promotesCanonical ? 1 : 0,
            input.detail ?? null,
            input.suggestedFix ?? null,
            fixedReopen ? 1 : 0,
            promoteLifecycleToReopened ? 1 : 0,
            fixedReopen ? 1 : 0,
            promoteLifecycleToReopened ? 1 : 0,
            promoteLifecycleToReopened ? 1 : 0,
            promoteLifecycleToReopened ? 1 : 0,
            fixedReopen ? 1 : 0,
            promoteLifecycleToReopened ? 1 : 0,
            countReopen ? 1 : 0,
            existing.finding_id,
          );
        this.touchSession(input.hitchId, now);
        return {
          finding: this.requireFinding(existing.finding_id),
          created: false,
          reopened,
        };
      }

      const nearDuplicate =
        explicitDuplicateOf === null &&
        input.stableKey === undefined &&
        scopeStatus !== "duplicate" &&
        this.requireSession(input.hitchId).policy.divergence.nearDuplicateDedup
          ? this.findNearDuplicateForInput(input)
          : null;
      const insertScopeStatus =
        nearDuplicate === null ? scopeStatus : ("duplicate" as const);
      const insertDuplicateOf =
        nearDuplicate === null ? explicitDuplicateOf : nearDuplicate.findingId;
      const insertLifecycleStatus =
        nearDuplicate === null && input.lifecycleStatus !== undefined
          ? input.lifecycleStatus
          : defaultLifecycleForScope(insertScopeStatus);
      const insertClassificationReason =
        nearDuplicate === null
          ? input.classificationReason ?? null
          : nearDuplicateClassificationReason(
              nearDuplicate.findingId,
              input.classificationReason,
            );
      const reopened =
        insertDuplicateOf !== null
          ? this.promoteDuplicateCanonical(
              insertDuplicateOf,
              input.severity,
              scopeStatus,
              input.lifecycleStatus ?? defaultLifecycleForScope(scopeStatus),
              input.summary,
              input.detail,
              input.source,
              now,
              nearDuplicate === null ? {} : { suppressFixedReopenCount: true },
            )
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
          insertDuplicateOf,
          input.source,
          input.sourceRef ?? null,
          input.sourceAttemptId ?? null,
          input.sourceCycleId ?? null,
          input.severity,
          input.category,
          insertScopeStatus,
          insertLifecycleStatus,
          input.summary,
          input.detail ?? null,
          input.filePath ?? null,
          input.symbol ?? null,
          input.suggestedFix ?? null,
          now,
          now,
          insertClassificationReason,
        );
      this.touchSession(input.hitchId, now);
      return {
        finding: this.requireFinding(findingId),
        created: true,
        reopened,
      };
    }
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
      this.promoteDuplicateCanonical(
        duplicateOf,
        current.severity,
        current.scopeStatus,
        current.lifecycleStatus,
        current.summary,
        current.detail ?? undefined,
        current.source,
        now,
      );
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
    incomingScopeStatus: HitchScopeStatus,
    incomingLifecycleStatus: HitchLifecycleStatus,
    incomingSummary: string,
    incomingDetail: string | undefined,
    incomingSource: HitchFindingSource,
    now: string,
    options: { suppressFixedReopenCount?: boolean } = {},
  ): boolean {
    const canonical = this.requireFinding(canonicalFindingId);
    const severity = moreSevere(canonical.severity, incomingSeverity);
    const incomingCloseBlocker = incomingCloseBlockerCandidate(
      incomingScopeStatus,
      incomingLifecycleStatus,
      incomingSeverity,
    );
    const scopeStatus = incomingCloseBlocker
      ? moreBlockingScope(canonical.scopeStatus, incomingScopeStatus)
      : canonical.scopeStatus;
    const promoteLifecycleToReopened = shouldReopenForIncoming(
      canonical.lifecycleStatus,
      incomingScopeStatus,
      incomingLifecycleStatus,
      incomingSeverity,
    );
    const fixedReopen =
      canonical.lifecycleStatus === "fixed" && incomingCloseBlocker;
    const reopened = fixedReopen || promoteLifecycleToReopened;
    const promotesCanonical =
      severity !== canonical.severity ||
      scopeStatus !== canonical.scopeStatus ||
      reopened;
    const countReopen =
      isHarnessOriginFindingSource(incomingSource) &&
      (promoteLifecycleToReopened ||
        (fixedReopen && options.suppressFixedReopenCount !== true));
    this.db
      .prepare(
        `UPDATE hitch_findings
            SET severity = ?,
                scope_status = ?,
                summary = CASE
                  WHEN ? THEN ?
                  ELSE summary
                END,
                detail = CASE
                  WHEN ? THEN COALESCE(?, detail)
                  ELSE detail
                END,
                lifecycle_status = CASE
                  WHEN (lifecycle_status = 'fixed' AND ?) OR ? THEN 'reopened'
                  ELSE lifecycle_status
                END,
                fixed_at = CASE
                  WHEN (lifecycle_status = 'fixed' AND ?) OR ? THEN NULL
                  ELSE fixed_at
                END,
                deferred_at = CASE
                  WHEN ? THEN NULL
                  ELSE deferred_at
                END,
                deferred_backlog_item_id = CASE
                  WHEN ? THEN NULL
                  ELSE deferred_backlog_item_id
                END,
                reopen_count = CASE
                  WHEN ((lifecycle_status = 'fixed' AND ?) OR ?) AND ?
                    THEN reopen_count + 1
                  ELSE reopen_count
                END,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(
        severity,
        scopeStatus,
        promotesCanonical ? 1 : 0,
        incomingSummary,
        promotesCanonical ? 1 : 0,
        incomingDetail ?? null,
        fixedReopen ? 1 : 0,
        promoteLifecycleToReopened ? 1 : 0,
        fixedReopen ? 1 : 0,
        promoteLifecycleToReopened ? 1 : 0,
        promoteLifecycleToReopened ? 1 : 0,
        promoteLifecycleToReopened ? 1 : 0,
        fixedReopen ? 1 : 0,
        promoteLifecycleToReopened ? 1 : 0,
        countReopen ? 1 : 0,
        now,
        canonicalFindingId,
      );
    return reopened;
  }

  private findNearDuplicateForInput(
    input: UpsertHitchFindingInput,
  ): NearDuplicateCandidate | null {
    const rows = this.db
      .prepare(
        `SELECT finding_id, hitch_id, category, scope_status, summary,
                file_path, symbol
           FROM hitch_findings
          WHERE hitch_id = ?
            AND duplicate_of IS NULL
          ORDER BY first_seen_at ASC, finding_id ASC`,
      )
      .all(input.hitchId) as HitchFindingIdentityRow[];
    return findNearDuplicate({
      hitchId: input.hitchId,
      category: input.category,
      scopeStatus: input.scopeStatus ?? "unknown",
      summary: input.summary,
      filePath: input.filePath ?? null,
      symbol: input.symbol ?? null,
      candidates: rows.map(rowToNearDuplicateCandidate),
    });
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

  /**
   * #278: deterministically retire prior cycles' review-origin review-blocking
   * findings once a later review cycle's canonical decision is APPROVED. This is
   * the harness-side equivalent of the operator running `hitch finding fixed` by
   * hand on every stale blocker after an approve — lifted into the harness and
   * bounded by a STRICT allowlist (fail-closed):
   *
   *   - source = 'review'                       (never human/mcp/test/doctor/codex/other)
   *   - category IN (caller allowlist)          (only review-blocking categories)
   *   - scope_status = 'in_scope'               (never out_of_scope/unknown/duplicate)
   *   - lifecycle_status IN ('open','reopened') (only still-open blockers)
   *   - severity <> 'P0'                         (defensive belt-and-suspenders)
   *   - duplicate_of IS NULL                    (never duplicate child rows)
   *   - source_cycle_id resolves to a SAME-hitch cycle with cycle_number STRICTLY
   *     LESS than the superseding cycle (proven-earlier; NULL/dangling/future/
   *     same-cycle ids are NOT proven-earlier and are left OPEN — fail-closed)
   *   - decisionRunId is the hitch's CURRENT review target (its latest coding run)
   *     when one exists — a stale/non-current run's approve retires nothing
   *     (fail-closed); see the current-review-target guard below
   *
   * Anything outside the allowlist is left OPEN (fail-closed). Only
   * `lifecycle_status` / `fixed_at` / `resolution_note` / `last_seen_at` change;
   * `source` and `source_cycle_id` are preserved, so the divergence audit ledger
   * (harnessOriginDivergenceMetrics, #196/#280) is unaffected. The trigger is
   * 100% harness-deterministic (canonical approve from the DB), never an LLM claim.
   * Returns the resolved findings (immutable snapshot), in first-seen order.
   */
  resolveSupersededReviewFindings(
    input: ResolveSupersededReviewFindingsInput,
  ): HitchFinding[] {
    // #306 / P3: keep the public wrapper's transaction boundary identical to the
    // pre-refactor version — run the pure prelude (allowlist filter + the
    // empty-category early-return) OUTSIDE the transaction, so the empty fast path
    // never opens a tx. Only the write core runs inside the (same `default` variant)
    // transaction.
    const prepared = this.prepareResolveSuperseded(input);
    if (prepared === null) return [];
    return this.db
      .transaction((): HitchFinding[] =>
        this.resolveSupersededReviewFindingsWithin(input, prepared),
      )
      .default();
  }

  /**
   * #306: non-transactional core of {@link resolveSupersededReviewFindings} for the
   * atomic review import (via {@link runAtomically} in
   * `importReviewProposalToHitch`). Runs the IDENTICAL prelude (allowlist filter +
   * empty-category short-circuit) and the IDENTICAL fail-closed allowlist +
   * current-target + strict-earlier-cycle write, but does NOT open its own
   * transaction so it composes inside the single outer BEGIN. Effect-equivalent to
   * the public method; the public method only differs in opening its own tx.
   */
  resolveSupersededReviewFindingsCore(
    input: ResolveSupersededReviewFindingsInput,
  ): HitchFinding[] {
    const prepared = this.prepareResolveSuperseded(input);
    if (prepared === null) return [];
    return this.resolveSupersededReviewFindingsWithin(input, prepared);
  }

  // #306 / P3: pure prelude shared by the public wrapper and the atomic-import
  // core. Returns null for the empty-category fast path (resolve nothing) so the
  // wrapper can short-circuit BEFORE opening a transaction (matching main).
  private prepareResolveSuperseded(
    input: ResolveSupersededReviewFindingsInput,
  ): { now: string; note: string; categories: string[]; categoryPlaceholders: string } | null {
    // Defense-in-depth (fail-closed): enforce the review-blocking allowlist
    // INSIDE the repository, not just at the caller. A caller can never widen the
    // set of auto-resolvable categories — any category outside
    // REVIEW_BLOCKING_FINDING_CATEGORIES is dropped here, so advisory / arbitrary
    // categories are never retired even if mistakenly passed in.
    const categories = input.categories.filter((category) =>
      REVIEW_BLOCKING_FINDING_CATEGORY_SET.has(category),
    );
    if (categories.length === 0) return null;
    const now = input.resolvedAt ?? new Date().toISOString();
    const note =
      `${AUTO_RESOLVE_NOTE_PREFIX} ` +
      `(run ${input.decisionRunId}, cycle ${input.supersedingCycleId})`;
    const categoryPlaceholders = placeholders(categories.length);
    return { now, note, categories, categoryPlaceholders };
  }

  // #306 / P3: the IDENTICAL write body of the former resolveSupersededReviewFindings
  // transaction — no transaction is opened here, so it runs inside the caller's
  // transaction (the public wrapper's own tx, or the atomic import's outer BEGIN).
  private resolveSupersededReviewFindingsWithin(
    input: ResolveSupersededReviewFindingsInput,
    prepared: { now: string; note: string; categories: string[]; categoryPlaceholders: string },
  ): HitchFinding[] {
    const { now, note, categories, categoryPlaceholders } = prepared;
    {
      // The superseding cycle must exist for this hitch; if it does not we cannot
      // prove any finding is from an EARLIER cycle, so resolve nothing (fail-closed).
      const supersedingCycle = this.db
        .prepare(
          `SELECT cycle_number FROM hitch_review_cycles
            WHERE cycle_id = ? AND hitch_id = ?`,
        )
        .get(input.supersedingCycleId, input.hitchId) as
        | { cycle_number: number }
        | undefined;
      if (supersedingCycle === undefined) return [];
      // CURRENT-REVIEW-TARGET guard (fail-closed): an approve only supersedes prior
      // blockers when it reviewed the hitch's CURRENT review target — the latest
      // coding run (newest implement/rerun attempt, ranked deterministically by
      // attempt iteration, NOT nullable runs.started_at). The earlier-cycle /
      // same-hitch predicate alone does NOT prove the approving run is current: the
      // MCP review.process path accepts any needs_review run linked by
      // project/repo/domain, so a manually-processed approve for a STALE/older run
      // could be imported as a later cycle and wrongly retire open blockers raised
      // against a DIFFERENT, NEWER run. If a coding-run target exists and the
      // approving run is not it, resolve nothing. When no coding run is recorded
      // (e.g. a direct primitive caller with no attempts) there is no target to
      // contradict, so the strict earlier-cycle predicate below governs alone.
      const currentTargetRunId = this.latestCodingRunId(input.hitchId);
      if (currentTargetRunId !== null && currentTargetRunId !== input.decisionRunId) {
        return [];
      }
      // STRICT earlier-cycle predicate (fail-closed): the finding's source_cycle_id
      // MUST reference a cycle of the SAME hitch whose cycle_number is strictly less
      // than the superseding cycle's. A NULL, dangling, future, or same source_cycle_id
      // is NOT proven-earlier and is left OPEN — the inner JOIN drops it. This is
      // tighter than `<> superseding` (which would admit null/future/foreign cycles)
      // and matches the documented "prior EARLIER cycle" semantics.
      const rows = this.db
        .prepare(
          `SELECT f.finding_id
             FROM hitch_findings f
             JOIN hitch_review_cycles c
               ON c.cycle_id = f.source_cycle_id
              AND c.hitch_id = f.hitch_id
            WHERE f.hitch_id = ?
              AND f.source = 'review'
              AND f.scope_status = 'in_scope'
              AND f.lifecycle_status IN ('open', 'reopened')
              AND f.severity <> 'P0'
              AND f.duplicate_of IS NULL
              AND f.category IN (${categoryPlaceholders})
              AND c.cycle_number < ?
            ORDER BY f.first_seen_at ASC, f.finding_id ASC`,
        )
        .all(input.hitchId, ...categories, supersedingCycle.cycle_number) as Array<{
        finding_id: string;
      }>;
      if (rows.length === 0) return [];
      // Reuse the SAME open->fixed lifecycle edge as markFindingFixed. The
      // resolution_note is written so the AUDIT record always names the CURRENT
      // superseding cycle (#278): set the fresh note when there is none OR when the
      // existing note is a prior harness auto-resolve note (which would otherwise
      // name a STALE older cycle after a reopen->approve), but PRESERVE a genuine
      // operator-authored note. The marker prefix carries no LIKE wildcards, and
      // `${prefix}%` is a bound parameter, so this stays injection-safe.
      const update = this.db.prepare(
        `UPDATE hitch_findings
            SET lifecycle_status = 'fixed', fixed_at = ?,
                resolution_note = CASE
                  WHEN resolution_note IS NULL OR resolution_note LIKE ? THEN ?
                  ELSE resolution_note
                END,
                deferred_at = NULL,
                deferred_backlog_item_id = NULL,
                last_seen_at = ?
          WHERE finding_id = ?`,
      );
      const autoNoteLikePattern = `${AUTO_RESOLVE_NOTE_PREFIX}%`;
      for (const row of rows) {
        update.run(now, autoNoteLikePattern, note, now, row.finding_id);
      }
      this.touchSession(input.hitchId, now);
      return rows.map((row) => this.requireFinding(row.finding_id));
    }
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
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        "SELECT * FROM hitch_findings" +
          whereSql(clauses) +
          " ORDER BY first_seen_at ASC, finding_id ASC LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset) as HitchFindingRow[];
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

  harnessOriginDivergenceMetrics(
    hitchId: string,
  ): HitchHarnessOriginDivergenceMetrics {
    const sourcePlaceholders = placeholders(
      HARNESS_ORIGIN_FINDING_SOURCES.length,
    );
    // #283: non-actionable advisory review categories (assigned deterministically
    // by the harness, NOT self-reported by the LLM) are RECORDED as findings but
    // EXCLUDED from the divergence churn counter — otherwise an approval/positive
    // advisory comment could inflate findingsNew and trip a FALSE `diverging` on
    // reopen. The blocking categories (review-required-change /
    // review-negative-decision) are deliberately NOT in this set, so real blockers
    // still drive divergence (and still block close) — fail-closed.
    const advisoryPlaceholders = placeholders(
      ADVISORY_REVIEW_FINDING_CATEGORIES.length,
    );
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(MAX(reopen_count), 0) AS maxReopen
           FROM hitch_findings
          WHERE hitch_id = ?
            AND duplicate_of IS NULL
            AND source IN (${sourcePlaceholders})
            AND category NOT IN (${advisoryPlaceholders})`,
      )
      .get(
        hitchId,
        ...HARNESS_ORIGIN_FINDING_SOURCES,
        ...ADVISORY_REVIEW_FINDING_CATEGORIES,
      ) as {
      total: number;
      maxReopen: number;
    };
    const cycleRows = this.db
      .prepare(
        `SELECT
            c.cycle_id,
            c.cycle_number,
            COUNT(f.finding_id) AS findings_new
           FROM hitch_review_cycles c
           LEFT JOIN hitch_findings f
             ON f.hitch_id = c.hitch_id
            AND f.source_cycle_id = c.cycle_id
            AND f.duplicate_of IS NULL
            AND f.source IN (${sourcePlaceholders})
            AND f.category NOT IN (${advisoryPlaceholders})
          WHERE c.hitch_id = ?
            -- only COMPLETED cycles are review evidence (#164): a
            -- started-but-incomplete cycle has 0 imported findings and would
            -- otherwise look like a "clean" cycle, prematurely clearing a
            -- non-decreasing divergence before any review evidence exists.
            AND c.completed_at IS NOT NULL
          GROUP BY c.cycle_id, c.cycle_number, c.created_at
          ORDER BY c.cycle_number ASC, c.created_at ASC, c.cycle_id ASC`,
      )
      // Positional binds (#283): JOIN-clause params bind BEFORE the WHERE
      // `c.hitch_id = ?` param — sources, then advisory categories (both in the
      // ON clause), THEN hitchId. Reordering would silently corrupt the counts.
      .all(
        ...HARNESS_ORIGIN_FINDING_SOURCES,
        ...ADVISORY_REVIEW_FINDING_CATEGORIES,
        hitchId,
      ) as HitchDivergenceCycleFindingRow[];
    return {
      harnessOriginNewFindings: totals.total,
      harnessOriginMaxReopenCount: totals.maxReopen,
      harnessOriginNewFindingsByCycle: cycleRows.map((row) => ({
        cycleId: row.cycle_id,
        cycleNumber: row.cycle_number,
        findingsNew: row.findings_new,
      })),
    };
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

  linkedPhaseSpecApprovalDrifts(
    hitchId: string,
  ): LinkedPhaseSpecApprovalDrift[] {
    const rows = this.db
      .prepare(
        `SELECT p.phase_id, p.scope_json, p.close_conditions_json, p.review_state_json
           FROM phase_hitches ph
           JOIN phases p ON p.phase_id = ph.phase_id
          WHERE ph.hitch_id = ?
          ORDER BY p.phase_id ASC`,
      )
      .all(hitchId) as LinkedPhaseSpecRow[];
    const drifts: LinkedPhaseSpecApprovalDrift[] = [];
    for (const row of rows) {
      const status = phaseSpecApprovalStatusForSpec({
        scope: parseNullableJson(row.scope_json),
        closeConditions: parseNullableJson(row.close_conditions_json),
        reviewState: parseNullableJson(row.review_state_json),
      });
      if (!status.drifted || status.approvedSpecHash === null) continue;
      drifts.push({
        phaseId: row.phase_id,
        approvedSpecHash: status.approvedSpecHash,
        currentSpecHash: status.currentSpecHash,
      });
    }
    return drifts;
  }

  // #125 Track C (C2): close-check concern delegated to CloseCheckRepository.
  // The facade keeps these entry-points and forwards to the sub-repo (shared
  // `db`, behaviour-identical).
  recordCloseCheck(input: RecordHitchCloseCheckInput): HitchCloseCheck {
    return this.closeChecks.recordCloseCheck(input);
  }

  getCloseCheck(checkId: string): HitchCloseCheck | null {
    return this.closeChecks.getCloseCheck(checkId);
  }

  requireCloseCheck(checkId: string): HitchCloseCheck {
    return this.closeChecks.requireCloseCheck(checkId);
  }

  listCloseChecks(hitchId: string): HitchCloseCheck[] {
    return this.closeChecks.listCloseChecks(hitchId);
  }

  // #125 Track C (C1): convergence-decision concern delegated to
  // ConvergenceDecisionRepository. The facade keeps these entry-points and
  // forwards to the sub-repo (shared `db`, behaviour-identical).
  recordConvergenceDecision(
    input: RecordHitchConvergenceDecisionInput,
  ): HitchConvergenceDecisionRecord {
    return this.decisions.recordConvergenceDecision(input);
  }

  getDecision(decisionId: string): HitchConvergenceDecisionRecord | null {
    return this.decisions.getDecision(decisionId);
  }

  requireDecision(decisionId: string): HitchConvergenceDecisionRecord {
    return this.decisions.requireDecision(decisionId);
  }

  listDecisions(hitchId: string): HitchConvergenceDecisionRecord[] {
    return this.decisions.listDecisions(hitchId);
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

  private latestCodingRunId(hitchId: string): string | null {
    const attempts = this.listAttempts(hitchId);
    for (let i = attempts.length - 1; i >= 0; i--) {
      const attempt = attempts[i];
      if (attempt === undefined) continue;
      if (!CODING_RUN_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
      if (attempt.runId !== null && attempt.runId !== "") return attempt.runId;
    }
    return null;
  }

  /**
   * The latest coding run id + the paths that run changed (run_changed_files),
   * deterministic inputs for the facet_red_test close gate (#279). Fail-closed:
   * when no run is resolvable, `runId` is null and `paths` is empty so the gate
   * can never pass. Mirrors `changedPathsForRun` (allowed, non-ignored rows,
   * with the reviewed.meta_json fallback) so the gate sees the same surface the
   * post-hoc policy diff verified.
   *
   * STRICT on the NEWEST coding attempt (not the shared `latestCodingRunId`,
   * which is intentionally lenient — it skips a newer run-less attempt and falls
   * back to an older run, a semantics #278's auto-resolve guard relies on). For
   * the facet gate that lenient fallback is unsafe: if the newest implement/rerun
   * attempt has no resolvable run_id (a coding pass is in flight / failed before
   * recording a run), evaluating an OLDER run's changedPaths AND accepting fresh
   * evidence bound to that older run would let a hitch reach close_ready on stale
   * data. So we look ONLY at the newest coding attempt: no resolvable run_id =>
   * `{ runId: null, paths: [] }` (gate goes pending, never passes on the older
   * run). Only when the newest coding attempt HAS a run_id do we use it.
   */
  latestCodingRunChangedPaths(hitchId: string): {
    runId: string | null;
    paths: string[];
  } {
    const runId = this.newestCodingAttemptRunId(hitchId);
    if (runId === null) return { runId: null, paths: [] };
    return { runId, paths: this.changedPathsForRun(runId) };
  }

  /**
   * The run_id of the NEWEST implement/rerun attempt, or null when that newest
   * coding attempt has no run_id (does NOT fall back to an older attempt). This
   * is the fail-closed resolution the facet_red_test gate requires; it is
   * deliberately distinct from `latestCodingRunId`.
   */
  private newestCodingAttemptRunId(hitchId: string): string | null {
    const attempts = this.listAttempts(hitchId);
    for (let i = attempts.length - 1; i >= 0; i--) {
      const attempt = attempts[i];
      if (attempt === undefined) continue;
      if (!CODING_RUN_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
      // Newest coding attempt found — its run_id (or null) is authoritative.
      return attempt.runId !== null && attempt.runId !== ""
        ? attempt.runId
        : null;
    }
    return null;
  }

  private changedPathsForRun(runId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT path
           FROM run_changed_files
          WHERE run_id = ? AND allowed = 1 AND status <> 'ignored'
          ORDER BY path`,
      )
      .all(runId) as { path: string }[];
    const dbPaths = rows
      .map((r) => r.path)
      .filter((p): p is string => typeof p === "string" && p !== "");
    if (dbPaths.length > 0) return dbPaths;

    const row = this.db
      .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
      .get(runId) as { meta_json: string | null } | undefined;
    if (row?.meta_json === undefined || row.meta_json === null) return [];
    try {
      const meta = JSON.parse(row.meta_json) as {
        reviewed?: { paths?: unknown };
      };
      const reviewedPaths = meta.reviewed?.paths;
      if (!Array.isArray(reviewedPaths)) return [];
      return reviewedPaths.filter(
        (p): p is string => typeof p === "string" && p !== "",
      );
    } catch {
      return [];
    }
  }

  private runPr(runId: string): { url: string | null; number: number | null } | null {
    const row = this.db
      .prepare("SELECT pr_url, pr_number FROM runs WHERE run_id = ?")
      .get(runId) as
      | { pr_url: string | null; pr_number: number | null }
      | undefined;
    if (row === undefined) return null;
    if (row.pr_url === null && row.pr_number === null) return null;
    return { url: row.pr_url, number: row.pr_number };
  }

  private touchSession(hitchId: string, updatedAt: string): void {
    this.db
      .prepare("UPDATE hitch_sessions SET updated_at = ? WHERE hitch_id = ?")
      .run(updatedAt, hitchId);
  }
}

function assertConfigUpdateAllowed(session: HitchSession): void {
  if (CONFIG_UPDATE_STATUSES.has(session.status)) return;
  if (REOPEN_BEFORE_UPDATE_STATUSES.has(session.status)) {
    throw new Error(
      `hitch ${session.hitchId} is ${session.status}; reopen the hitch before updating config`,
    );
  }
  throw new Error(
    `hitch ${session.hitchId} is ${session.status} and cannot be reopened; ` +
      "start a new hitch for config changes",
  );
}

function policyLoosensGate(previous: HitchPolicy, next: HitchPolicy): boolean {
  if (!previous.allowEmptyCloseConditions && next.allowEmptyCloseConditions) {
    return true;
  }
  if (
    boolGateLoosened(
      previous.closeRequires.noOpenInScopeP0,
      next.closeRequires.noOpenInScopeP0,
    )
  ) {
    return true;
  }
  if (
    boolGateLoosened(
      previous.closeRequires.noOpenInScopeP1,
      next.closeRequires.noOpenInScopeP1,
    )
  ) {
    return true;
  }
  if (
    boolGateLoosened(
      previous.closeRequires.noUnknownScope,
      next.closeRequires.noUnknownScope,
    )
  ) {
    return true;
  }
  return numericMaxGateLoosened(
    previous.closeRequires.maxOpenInScopeP2,
    next.closeRequires.maxOpenInScopeP2,
  );
}

function boolGateLoosened(previous: boolean, next: boolean): boolean {
  return previous && !next;
}

function numericMaxGateLoosened(
  previous: number | undefined,
  next: number | undefined,
): boolean {
  if (previous === undefined) return false;
  if (next === undefined) return true;
  return next > previous;
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

function moreBlockingScope(
  current: HitchScopeStatus,
  incoming: HitchScopeStatus,
): HitchScopeStatus {
  const rank: Record<HitchScopeStatus, number> = {
    duplicate: -1,
    out_of_scope: 0,
    unknown: 1,
    in_scope: 2,
  };
  return rank[incoming] > rank[current] ? incoming : current;
}

const NON_BLOCKING_CANONICAL_LIFECYCLES = new Set<HitchLifecycleStatus>([
  "deferred",
  "accepted_risk",
  "out_of_scope",
]);

function shouldReopenForIncoming(
  canonicalLifecycleStatus: HitchLifecycleStatus,
  incomingScopeStatus: HitchScopeStatus,
  incomingLifecycleStatus: HitchLifecycleStatus,
  incomingSeverity: HitchFindingSeverity,
): boolean {
  return (
    NON_BLOCKING_CANONICAL_LIFECYCLES.has(canonicalLifecycleStatus) &&
    incomingCloseBlockerCandidate(
      incomingScopeStatus,
      incomingLifecycleStatus,
      incomingSeverity,
    )
  );
}

function incomingCloseBlockerCandidate(
  scopeStatus: HitchScopeStatus,
  lifecycleStatus: HitchLifecycleStatus,
  severity: HitchFindingSeverity,
): boolean {
  if (!OPEN_FINDING_LIFECYCLE_SET.has(lifecycleStatus)) return false;
  if (scopeStatus !== "in_scope" && scopeStatus !== "unknown") return false;
  return severity === "P0" || severity === "P1" || severity === "P2";
}

const NEAR_DUPLICATE_CLASSIFICATION_PREFIX = "near-duplicate of ";

function nearDuplicateClassificationReason(
  canonicalFindingId: string,
  classificationReason: string | undefined,
): string {
  const suffix =
    classificationReason === undefined || classificationReason.trim() === ""
      ? ""
      : `; ${classificationReason.trim()}`;
  return `${NEAR_DUPLICATE_CLASSIFICATION_PREFIX}${canonicalFindingId}${suffix}`;
}

function isNearDuplicateClassificationReason(reason: string | null): boolean {
  return reason?.startsWith(NEAR_DUPLICATE_CLASSIFICATION_PREFIX) ?? false;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseNullableJson(text: string | null): unknown {
  return text === null ? null : (JSON.parse(text) as unknown);
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

function rowToNearDuplicateCandidate(
  row: HitchFindingIdentityRow,
): NearDuplicateCandidate {
  return {
    findingId: row.finding_id,
    hitchId: row.hitch_id,
    category: row.category,
    scopeStatus: row.scope_status,
    summary: row.summary,
    filePath: row.file_path,
    symbol: row.symbol,
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
