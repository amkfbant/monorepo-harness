import { ConvergenceService } from "./convergence.js";
import { syncGoalStatusForConvergence } from "./convergence-status.js";
import type { HitchRepository } from "./repository.js";
import type { HitchConvergenceResult } from "./types.js";

export type GoalLinkedMutationKind =
  | "run.start"
  | "review.auto"
  | "rerun.start"
  | "review.process"
  // (#83) The MCP driver that advances the goal loop a bounded number of steps.
  | "hitch.orchestrate";

export interface GoalMutationGateDenied {
  allowed: false;
  code: string;
  message: string;
  /** Absent only for goal_not_found, where convergence cannot be evaluated. */
  convergence?: HitchConvergenceResult;
}

export interface GoalMutationGateAllowed {
  allowed: true;
  convergence: HitchConvergenceResult;
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
  repository: HitchRepository;
  hitchId: string;
  mutationKind: GoalLinkedMutationKind;
}): GoalMutationGateAllowed {
  const gate = evaluateGoalMutationGate(input);
  if (!gate.allowed) {
    throw new GoalMutationGateError(gate);
  }
  return gate;
}

export function evaluateGoalMutationGate(input: {
  repository: HitchRepository;
  hitchId: string;
  mutationKind: GoalLinkedMutationKind;
  syncStatus?: boolean;
}): GoalMutationGateResult {
  // A linked goal that does not exist is a structured denial, not a DB error:
  // ConvergenceService.evaluate would throw on a missing session.
  if (input.repository.getSession(input.hitchId) === null) {
    return {
      allowed: false,
      code: "goal_not_found",
      message: `goal ${input.hitchId} not found`,
    };
  }
  const convergence = new ConvergenceService(input.repository).evaluate(
    input.hitchId,
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
      `goal ${input.hitchId} blocks ${input.mutationKind}: ` +
      `decision=${convergence.decision} (${convergence.reason})`,
    convergence,
  };
}

export function allowedByConvergence(
  mutationKind: GoalLinkedMutationKind,
  convergence: HitchConvergenceResult,
): boolean {
  const action = convergence.recommendedNextAction.kind;
  if (mutationKind === "hitch.orchestrate") {
    // The bounded-step orchestrate driver is permitted exactly when the loop has
    // a permitted autonomous next step — i.e. some per-step mutation below would
    // be allowed. close_ready / terminal / defer / classify all require an
    // operator, so the driver is denied (fail-closed; the operator drives the
    // deliberate close/PR or classification path out of band).
    return (
      (convergence.decision === "needs_fix" &&
        (action === "fix_findings" || action === "run_close_check")) ||
      (convergence.decision === "continue" && action === "run_close_check")
    );
  }
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
  convergence: HitchConvergenceResult,
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
