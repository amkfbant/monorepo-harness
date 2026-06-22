import { ConvergenceService } from "./convergence.js";
import type { HitchRepository } from "./repository.js";
import type {
  HitchConvergenceDecision,
  HitchConvergenceDecisionRecord,
  HitchConvergenceMetrics,
  HitchConvergenceResult,
  HitchNextAction,
  HitchSession,
  HitchStatus,
} from "./types.js";

export interface RecordConvergenceWithStatusInput {
  hitchId: string;
  cycleId?: string;
  attemptId?: string;
  decision: HitchConvergenceDecision;
  reason: string;
  metrics: HitchConvergenceMetrics;
  recommendedNextAction?: HitchNextAction;
  createdBy: string;
  createdAt?: string;
  updateStatus?: boolean;
  /**
   * (#230 / codex#254-P2 FIX1) Mark this row as an ADVISORY severity-audit record
   * (the D2b status-neutral `continue` row). When set, a deterministic
   * `advisorySeverityRecord: true` marker is merged into the persisted metrics so
   * the course/phase rollup DISPLAY (`latestDecisionForPhase`) skips it and a
   * still-blocking live convergence is not masked. The row is otherwise persisted
   * and retrievable unchanged.
   */
  advisory?: boolean;
}

/** Deterministic marker key for an advisory severity-audit decision row. */
export const ADVISORY_SEVERITY_RECORD_KEY = "advisorySeverityRecord" as const;

/**
 * Whether a persisted convergence decision is an ADVISORY severity-audit record
 * (#230 / codex#254-P2 FIX1) rather than a real convergence decision. The D2b
 * record writes a status-neutral `decision:"continue"` row ONLY to surface a
 * diverged severity audit for operators; it must NEVER mask a still-blocking
 * live state in any DISPLAY of "latest decision" (the rollup AND the #84 hitch
 * summary both skip it). The row stays persisted/retrievable via `listDecisions`.
 *
 *   (a) current builds set the explicit `advisorySeverityRecord` marker in
 *       `metrics_json`;
 *   (b) shape fallback for pre-marker rows from earlier #230 builds: a neutral
 *       `continue` whose decision packet only advertises a `severity_audit` kind
 *       (it never drives a scope/fix decision) — keeps DISPLAY honest after an
 *       upgrade without a backfill migration.
 *
 * Pure (no DB / evaluate) — safe to call from a read-only reporter.
 */
export function isAdvisorySeverityRecord(
  d: HitchConvergenceDecisionRecord,
): boolean {
  if (d.metrics[ADVISORY_SEVERITY_RECORD_KEY] === true) return true;
  if (d.decision !== "continue") return false;
  const kinds = d.recommendedNextAction?.decisionPacket?.decisionKinds;
  return Array.isArray(kinds) && kinds.includes("severity_audit");
}

export interface ConvergenceStatusSyncResult {
  decisionRecord: HitchConvergenceDecisionRecord;
  hitchStatus: HitchSession | null;
}

export function evaluateConvergenceAndRecordStatus(input: {
  repository: HitchRepository;
  hitchId: string;
  createdBy: string;
  cycleId?: string;
  attemptId?: string;
}): HitchConvergenceResult & ConvergenceStatusSyncResult {
  const convergence = new ConvergenceService(input.repository).evaluate(
    input.hitchId,
  );
  const recorded = recordConvergenceDecisionWithStatus({
    repository: input.repository,
    hitchId: input.hitchId,
    ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    decision: convergence.decision,
    reason: convergence.reason,
    metrics: { ...convergence.metrics },
    recommendedNextAction: convergence.recommendedNextAction,
    createdBy: input.createdBy,
  });
  return { ...convergence, ...recorded };
}

export function recordConvergenceDecisionWithStatus(input: {
  repository: HitchRepository;
} & RecordConvergenceWithStatusInput): ConvergenceStatusSyncResult {
  const decisionRecord = input.repository.recordConvergenceDecision({
    hitchId: input.hitchId,
    ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    decision: input.decision,
    reason: input.reason,
    // Persist the typed convergence metrics, merging the advisory marker (FIX1)
    // ONLY for advisory rows so the rollup display can deterministically skip them.
    metrics: {
      ...input.metrics,
      ...(input.advisory === true ? { [ADVISORY_SEVERITY_RECORD_KEY]: true } : {}),
    },
    ...(input.recommendedNextAction !== undefined
      ? { recommendedNextAction: input.recommendedNextAction }
      : {}),
    createdBy: input.createdBy,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  });
  const hitchStatus =
    input.updateStatus === false
      ? null
      : syncHitchStatusForConvergence(
          input.repository,
          {
            hitchId: input.hitchId,
            decision: input.decision,
            reason: input.reason,
            metrics: input.metrics,
            recommendedNextAction:
              input.recommendedNextAction ?? {
                kind: "ask_human",
                message: input.reason,
              },
          },
          input.createdBy,
          input.createdAt,
        );
  return { decisionRecord, hitchStatus };
}

export function syncHitchStatusForConvergence(
  repository: HitchRepository,
  result: HitchConvergenceResult,
  createdBy: string,
  now?: string,
): HitchSession | null {
  const current = repository.requireSession(result.hitchId);
  // Terminal statuses are final: never move a closed/cancelled hitch back to a
  // live status, regardless of the decision. This is the data-layer guard that
  // backs the close_ready reversion below (which only ever runs for live hitches).
  if (current.status === "closed" || current.status === "cancelled") {
    return current;
  }
  const status = statusForConvergenceDecision(result.decision);
  if (status !== null) {
    return current.status === status
      ? current
      : repository.updateStatus(result.hitchId, status, result.reason, {
          createdBy,
          ...(now !== undefined ? { now } : {}),
        });
  }
  // Revert a soft, re-derivable status back to live work when the decision no
  // longer maps to a status. `close_ready` reverts when it is no longer ready;
  // `diverging` reverts when divergence has cleared (#164) — a stored diverging
  // hitch whose live decision is now `continue` / `needs_fix` / etc. must not
  // stay stuck on the stale stop (the decision itself is re-derived live; a
  // genuinely-still-diverging hitch re-derives to `diverging`, handled above).
  if (
    (current.status === "close_ready" || current.status === "diverging") &&
    result.decision !== "closed" &&
    result.decision !== "cancel"
  ) {
    return repository.updateStatus(
      result.hitchId,
      "in_progress",
      result.reason,
      {
        createdBy,
        ...(now !== undefined ? { now } : {}),
      },
    );
  }
  return null;
}

export function statusForConvergenceDecision(
  decision: HitchConvergenceDecision,
): HitchStatus | null {
  if (decision === "close_ready") return "close_ready";
  if (decision === "diverging") return "diverging";
  if (decision === "budget_exhausted") return "budget_exhausted";
  if (decision === "escalate") return "escalated";
  return null;
}
