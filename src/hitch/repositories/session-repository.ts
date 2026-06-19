import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DbError } from "../../db/connection.js";
import {
  parseHitchCloseConditions,
  parseHitchPolicy,
  parseHitchScope,
} from "../schemas.js";
import {
  closeConditionsLoosenGate,
  isScopeWidening,
} from "../spec-gates.js";
import { assertValidCloseConditions } from "../spec-validation.js";
import {
  DEFAULT_HITCH_POLICY,
  type HitchCreatedSource,
  type HitchLifecycleEvent,
  type HitchLifecycleEventName,
  type HitchPolicy,
  type HitchScope,
  type HitchCloseCondition,
  type HitchSession,
  type HitchStatus,
} from "../types.js";
import {
  addWhere,
  getHitchSession,
  json,
  latestCodingRunId,
  parseRecord,
  requireHitchSession,
  rowToSession,
  runPr,
  touchHitchSession,
  whereSql,
} from "./shared.js";

/**
 * #125 Track C (C5) — the session concern extracted from the frozen
 * `HitchRepository` by composition delegation. Owns the `hitch_sessions`
 * lifecycle (create / read / list / status transitions / reopen / diverging
 * recovery / pr-adopt / config update) and the `hitch_lifecycle_events`
 * immutable ledger writes (`insertLifecycleEvent`, audited by every transition).
 *
 * Holds the FACADE's `db` handle. Each mutating method opens its OWN transaction
 * on the shared handle exactly as the pre-extraction facade did; none is ever
 * called inside the atomic review-import `runAtomically` closure, so these
 * self-contained transactions never nest under the single-BEGIN primitive.
 * Behaviour-identical to the former `HitchRepository` session methods.
 */
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

/** #280 — options for {@link SessionRepository.recoverDivergingSession}. The
 * deterministic open-P0/P1 + close-check gate is supplied by the CLI/caller as
 * `revalidate` and is RE-RUN INSIDE the write transaction (not just before it),
 * so a concurrent `finding add` / close-check transition / cancel-close-escalate
 * between the caller's pre-check and the commit cannot flip a stale hitch to
 * `open` (fail-closed under the shared DB lock). The facade adapts the public
 * `revalidate(repo)` signature to this bound `() => void` so the sub-repo does
 * not depend on the facade type. */
export interface RecoverDivergingSessionOptions {
  reason: string;
  createdBy: string;
  /** Amount added to `max_total_new_findings` so live re-derivation does not
   * immediately re-fire the cumulative trigger. Clamped to a non-negative int. */
  extendDivergenceBudget?: number;
  /** #280 P2#2 — deterministic gate re-validation, executed INSIDE the write
   * transaction against fresh DB state. MUST throw (fail-closed) on any unmet
   * invariant. The facade binds itself into this callback before delegating. */
  revalidate?: () => void;
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

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

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
    return getHitchSession(this.db, hitchId);
  }

  requireSession(hitchId: string): HitchSession {
    return requireHitchSession(this.db, hitchId);
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
    const rows = this.db
      .prepare(sql)
      .all(...args, limit) as Parameters<typeof rowToSession>[0][];
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
      opts.revalidate?.();
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
      const runId = latestCodingRunId(this.db, input.hitchId);
      const supersededPr = runId === null ? null : runPr(this.db, runId);
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
      touchHitchSession(this.db, input.hitchId, now);
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

  insertLifecycleEvent(input: {
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
