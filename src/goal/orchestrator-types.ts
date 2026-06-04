/** One logical action the orchestrator can take per loop step. */
export type OrchestratorAction =
  | { kind: "coder" } // needs_fix: run/rerun the coder to fix findings / run close checks
  | { kind: "review" } // continue + run_close_check: review the latest run
  | { kind: "classify" } // needs_classification: deterministic scope classification
  | { kind: "defer" } // continue/defer_followups: defer out-of-scope findings to backlog
  | { kind: "close_and_pr" } // close_ready: close the goal then create the PR
  | { kind: "stop"; outcome: "closed" | "cancelled" } // already terminal
  | { kind: "escalate"; reason: string }; // diverging / budget / escalate / unsupported

/**
 * High-level runners the orchestrator drives. Each method performs one logical
 * action against the goal's session and returns a short status. Production wires
 * these to the real core operations; tests pass fakes.
 */
export interface OrchestratorRunners {
  /** Run/rerun the coder for the goal; records the attempt. Returns the run status. */
  coder(goalId: string): Promise<{ runId: string; runStatus: string }>;
  /** review auto + review process for the goal's latest run; records the cycle. */
  review(goalId: string): Promise<{ runId: string; decision: string }>;
  /** Deterministically classify open unknown-scope findings. Returns whether all resolved. */
  classify(goalId: string): Promise<{ resolved: boolean; escalateReason?: string }>;
  /** Defer open out-of-scope findings to the backlog. Returns how many were deferred. */
  defer(goalId: string): Promise<{ deferred: number }>;
  /** Close the goal and create a PR. Returns the PR url. */
  closeAndPr(goalId: string): Promise<{ prUrl: string }>;
}

export interface OrchestrationStep {
  step: number;
  decision: string;
  action: OrchestratorAction["kind"];
  detail: string;
}

export type OrchestrationOutcome =
  | "closed"
  | "cancelled"
  | "escalated"
  | "pr_created"
  | "max_steps_exhausted";

export interface OrchestrationResult {
  goalId: string;
  outcome: OrchestrationOutcome;
  steps: OrchestrationStep[];
  finalDecision: string;
  escalateReason?: string;
  prUrl?: string;
}
