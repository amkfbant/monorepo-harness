import type { GoalConvergenceResult } from "./types.js";
import type { OrchestratorAction } from "./orchestrator-types.js";

/**
 * Map a convergence result to a single orchestrator action. Fail-closed: any
 * decision/action pair that is not an explicitly safe step escalates rather
 * than forcing a mutation. Kept consistent with mutation-gate's permit matrix.
 */
export function decideOrchestratorAction(
  convergence: GoalConvergenceResult,
): OrchestratorAction {
  const action = convergence.recommendedNextAction.kind;
  switch (convergence.decision) {
    case "needs_fix":
      if (action === "fix_findings" || action === "run_close_check") {
        return { kind: "coder" };
      }
      return { kind: "escalate", reason: `needs_fix with unsupported action ${action}` };
    case "continue":
      if (action === "run_close_check") return { kind: "review" };
      if (action === "defer_followups") return { kind: "defer" };
      return { kind: "escalate", reason: `continue with non-review action ${action}` };
    case "needs_classification":
      return { kind: "classify" };
    case "close_ready":
      return { kind: "close_and_pr" };
    case "closed":
      return { kind: "stop", outcome: "closed" };
    case "cancel":
      return { kind: "stop", outcome: "cancelled" };
    case "diverging":
    case "budget_exhausted":
    case "escalate":
      return { kind: "escalate", reason: convergence.decision };
    default:
      return { kind: "escalate", reason: `unknown decision ${convergence.decision}` };
  }
}
