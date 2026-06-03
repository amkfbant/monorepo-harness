import { ConvergenceService } from "./convergence.js";
import type { GoalRepository } from "./repository.js";
import type {
  GoalConvergenceDecision,
  GoalConvergenceDecisionRecord,
  GoalConvergenceMetrics,
  GoalConvergenceResult,
  GoalNextAction,
  GoalSession,
  GoalStatus,
} from "./types.js";

export interface RecordConvergenceWithStatusInput {
  goalId: string;
  cycleId?: string;
  attemptId?: string;
  decision: GoalConvergenceDecision;
  reason: string;
  metrics: GoalConvergenceMetrics;
  recommendedNextAction?: GoalNextAction;
  createdBy: string;
  createdAt?: string;
  updateStatus?: boolean;
}

export interface ConvergenceStatusSyncResult {
  decisionRecord: GoalConvergenceDecisionRecord;
  goalStatus: GoalSession | null;
}

export function evaluateConvergenceAndRecordStatus(input: {
  repository: GoalRepository;
  goalId: string;
  createdBy: string;
  cycleId?: string;
  attemptId?: string;
}): GoalConvergenceResult & ConvergenceStatusSyncResult {
  const convergence = new ConvergenceService(input.repository).evaluate(
    input.goalId,
  );
  const recorded = recordConvergenceDecisionWithStatus({
    repository: input.repository,
    goalId: input.goalId,
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
  repository: GoalRepository;
} & RecordConvergenceWithStatusInput): ConvergenceStatusSyncResult {
  const decisionRecord = input.repository.recordConvergenceDecision({
    goalId: input.goalId,
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
            goalId: input.goalId,
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
  repository: GoalRepository,
  result: GoalConvergenceResult,
  now?: string,
): GoalSession | null {
  const current = repository.requireSession(result.goalId);
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
      : repository.updateStatus(result.goalId, status, result.reason, now);
  }
  if (
    current.status === "close_ready" &&
    result.decision !== "closed" &&
    result.decision !== "cancel"
  ) {
    return repository.updateStatus(
      result.goalId,
      "in_progress",
      result.reason,
      now,
    );
  }
  return null;
}

export function statusForConvergenceDecision(
  decision: GoalConvergenceDecision,
): GoalStatus | null {
  if (decision === "close_ready") return "close_ready";
  if (decision === "diverging") return "diverging";
  if (decision === "budget_exhausted") return "budget_exhausted";
  if (decision === "escalate") return "escalated";
  return null;
}
