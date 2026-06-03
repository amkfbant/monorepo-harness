import { ConvergenceService } from "./convergence.js";
import { syncGoalStatusForConvergence } from "./convergence-status.js";
import type { GoalRepository } from "./repository.js";
import type { GoalConvergenceResult } from "./types.js";

export type GoalLinkedMutationKind =
  | "run.start"
  | "review.auto"
  | "rerun.start"
  | "review.process";

export interface GoalMutationGateDenied {
  allowed: false;
  code: string;
  message: string;
  convergence: GoalConvergenceResult;
}

export interface GoalMutationGateAllowed {
  allowed: true;
  convergence: GoalConvergenceResult;
}

export type GoalMutationGateResult =
  | GoalMutationGateAllowed
  | GoalMutationGateDenied;

export class GoalMutationGateError extends Error {
  constructor(readonly denial: GoalMutationGateDenied) {
    super(denial.message);
    this.name = "GoalMutationGateError";
  }
}

export function assertGoalCanStartMutation(input: {
  repository: GoalRepository;
  goalId: string;
  mutationKind: GoalLinkedMutationKind;
}): GoalMutationGateAllowed {
  const gate = evaluateGoalMutationGate(input);
  if (!gate.allowed) {
    throw new GoalMutationGateError(gate);
  }
  return gate;
}

export function evaluateGoalMutationGate(input: {
  repository: GoalRepository;
  goalId: string;
  mutationKind: GoalLinkedMutationKind;
  syncStatus?: boolean;
}): GoalMutationGateResult {
  const convergence = new ConvergenceService(input.repository).evaluate(
    input.goalId,
  );
  if (input.syncStatus !== false) {
    syncGoalStatusForConvergence(input.repository, convergence);
  }
  if (allowedByConvergence(input.mutationKind, convergence)) {
    return { allowed: true, convergence };
  }
  const code = gateCode(convergence, input.mutationKind);
  return {
    allowed: false,
    code,
    message:
      `goal ${input.goalId} blocks ${input.mutationKind}: ` +
      `decision=${convergence.decision} (${convergence.reason})`,
    convergence,
  };
}

export function allowedByConvergence(
  mutationKind: GoalLinkedMutationKind,
  convergence: GoalConvergenceResult,
): boolean {
  const action = convergence.recommendedNextAction.kind;
  if (convergence.decision === "needs_fix") {
    if (action === "fix_findings" || action === "run_close_check") {
      return mutationKind === "run.start" || mutationKind === "rerun.start";
    }
    return false;
  }
  if (convergence.decision === "continue" && action === "run_close_check") {
    return mutationKind === "review.auto" || mutationKind === "review.process";
  }
  return false;
}

function gateCode(
  convergence: GoalConvergenceResult,
  mutationKind: GoalLinkedMutationKind,
): string {
  const decision = convergence.decision;
  if (decision === "budget_exhausted") return "goal_budget_exhausted";
  if (decision === "diverging") return "goal_diverging";
  if (decision === "escalate") return "goal_escalated";
  if (decision === "needs_classification") return "goal_needs_classification";
  if (decision === "close_ready") return "goal_close_ready";
  if (decision === "closed") return "goal_closed";
  if (decision === "cancel") return "goal_cancelled";
  if (decision === "continue") {
    return `goal_next_action_${convergence.recommendedNextAction.kind}`;
  }
  if (decision === "needs_fix") {
    return `goal_needs_fix_${convergence.recommendedNextAction.kind}_disallows_${mutationKind.replace(".", "_")}`;
  }
  return `goal_${decision}`;
}
