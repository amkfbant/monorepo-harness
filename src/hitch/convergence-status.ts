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
}

export interface ConvergenceStatusSyncResult {
  decisionRecord: HitchConvergenceDecisionRecord;
  goalStatus: HitchSession | null;
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
    metrics: { ...input.metrics },
    ...(input.recommendedNextAction !== undefined
      ? { recommendedNextAction: input.recommendedNextAction }
      : {}),
    createdBy: input.createdBy,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  });
  const goalStatus =
    input.updateStatus === false
      ? null
      : syncGoalStatusForConvergence(
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
          input.createdAt,
        );
  return { decisionRecord, goalStatus };
}

export function syncGoalStatusForConvergence(
  repository: HitchRepository,
  result: HitchConvergenceResult,
  now?: string,
): HitchSession | null {
  const current = repository.requireSession(result.hitchId);
  // Terminal statuses are final: never move a closed/cancelled goal back to a
  // live status, regardless of the decision. This is the data-layer guard that
  // backs the close_ready reversion below (which only ever runs for live goals).
  if (current.status === "closed" || current.status === "cancelled") {
    return current;
  }
  const status = statusForConvergenceDecision(result.decision);
  if (status !== null) {
    return current.status === status
      ? current
      : repository.updateStatus(result.hitchId, status, result.reason, now);
  }
  if (
    current.status === "close_ready" &&
    result.decision !== "closed" &&
    result.decision !== "cancel"
  ) {
    return repository.updateStatus(
      result.hitchId,
      "in_progress",
      result.reason,
      now,
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
