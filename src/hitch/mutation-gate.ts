import { ConvergenceService } from "./convergence.js";
import { syncHitchStatusForConvergence } from "./convergence-status.js";
import type { HitchRepository } from "./repository.js";
import type { HitchConvergenceResult } from "./types.js";

export type HitchLinkedMutationKind =
  | "run.start"
  | "review.auto"
  | "rerun.start"
  | "review.process"
  // (#83) The MCP driver that advances the hitch loop a bounded number of steps.
  | "hitch.orchestrate";

export interface HitchMutationGateDenied {
  allowed: false;
  code: string;
  message: string;
  /** Absent only for hitch_not_found, where convergence cannot be evaluated. */
  convergence?: HitchConvergenceResult;
}

export interface HitchMutationGateAllowed {
  allowed: true;
  convergence: HitchConvergenceResult;
}

export type HitchMutationGateResult =
  | HitchMutationGateAllowed
  | HitchMutationGateDenied;

export class HitchMutationGateError extends Error {
  constructor(readonly denial: HitchMutationGateDenied) {
    super(denial.message);
    this.name = "HitchMutationGateError";
  }
}

export function assertHitchCanStartMutation(input: {
  repository: HitchRepository;
  hitchId: string;
  mutationKind: HitchLinkedMutationKind;
}): HitchMutationGateAllowed {
  const gate = evaluateHitchMutationGate(input);
  if (!gate.allowed) {
    throw new HitchMutationGateError(gate);
  }
  return gate;
}

export function evaluateHitchMutationGate(input: {
  repository: HitchRepository;
  hitchId: string;
  mutationKind: HitchLinkedMutationKind;
  syncStatus?: boolean;
}): HitchMutationGateResult {
  // A linked hitch that does not exist is a structured denial, not a DB error:
  // ConvergenceService.evaluate would throw on a missing session.
  if (input.repository.getSession(input.hitchId) === null) {
    return {
      allowed: false,
      code: "hitch_not_found",
      message: `hitch ${input.hitchId} not found`,
    };
  }
  const convergence = new ConvergenceService(input.repository).evaluate(
    input.hitchId,
  );
  if (input.syncStatus !== false) {
    syncHitchStatusForConvergence(input.repository, convergence);
  }
  if (allowedByConvergence(input.mutationKind, convergence)) {
    return { allowed: true, convergence };
  }
  const code = gateCode(convergence, input.mutationKind);
  return {
    allowed: false,
    code,
    message:
      `hitch ${input.hitchId} blocks ${input.mutationKind}: ` +
      `decision=${convergence.decision} (${convergence.reason})`,
    convergence,
  };
}

export function allowedByConvergence(
  mutationKind: HitchLinkedMutationKind,
  convergence: HitchConvergenceResult,
): boolean {
  const action = convergence.recommendedNextAction.kind;
  if (mutationKind === "hitch.orchestrate") {
    // Gate for *entering* the bounded-step orchestrate driver: permitted exactly
    // when the loop has a permitted autonomous next step that this gate guards —
    // a per-step fix / close-check mutation below would be allowed (needs_fix →
    // fix_findings | run_close_check, or continue → run_close_check).
    //
    // Every other decision denies *entry* here (fail-closed): close_ready and the
    // stop/terminal decisions (escalate / diverging / budget_exhausted / closed /
    // cancel), plus defer_followups and needs_classification. The denial is only
    // about entering the driver — once it is running, HitchOrchestrator
    // auto-classifies and auto-defers via the deterministic classify / defer
    // runners (orchestrator.ts), which are internal dispatch, not gated
    // mutations. What genuinely needs an operator out of band is the deliberate
    // close_ready close/PR and the escalation path.
    // See the three-layer table in docs/specs/hitch-convergence.md.
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
  mutationKind: HitchLinkedMutationKind,
): string {
  const decision = convergence.decision;
  if (decision === "budget_exhausted") return "hitch_budget_exhausted";
  if (decision === "diverging") return "hitch_diverging";
  if (decision === "escalate") return "hitch_escalated";
  if (decision === "needs_classification") return "hitch_needs_classification";
  if (decision === "close_ready") return "hitch_close_ready";
  if (decision === "closed") return "hitch_closed";
  if (decision === "cancel") return "hitch_cancelled";
  if (decision === "continue") {
    return `hitch_next_action_${convergence.recommendedNextAction.kind}`;
  }
  if (decision === "needs_fix") {
    return `hitch_needs_fix_${convergence.recommendedNextAction.kind}_disallows_${mutationKind.replace(".", "_")}`;
  }
  return `hitch_${decision}`;
}
