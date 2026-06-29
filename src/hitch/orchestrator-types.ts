import type { ClassifyRunnerResult } from "./jury/types.js";

/** One logical action the orchestrator can take per loop step. */
export type OrchestratorAction =
  | { kind: "coder" } // needs_fix: run/rerun the coder to fix findings / run close checks
  | { kind: "review" } // continue + run_review: review the latest run
  | { kind: "close_check" } // continue + run_close_check: run deterministic command close checks
  | { kind: "classify" } // needs_classification: deterministic scope classification
  | { kind: "defer" } // continue/defer_followups: defer out-of-scope findings to backlog
  | { kind: "wait"; reason: string } // continue/ask_human: wait for external evidence
  | { kind: "close_and_pr" } // close_ready: close the hitch then create the PR
  | { kind: "stop"; outcome: "closed" | "cancelled" } // already terminal
  | { kind: "escalate"; reason: string }; // diverging / budget / escalate / unsupported

/**
 * High-level runners the orchestrator drives. Each method performs one logical
 * action against the hitch's session and returns a short status. Production wires
 * these to the real core operations; tests pass fakes.
 */
export interface OrchestratorRunners {
  /** Run/rerun the coder for the hitch; records the attempt. Returns the run status. */
  coder(hitchId: string): Promise<{ runId: string; runStatus: string }>;
  /** review auto + review process for the hitch's latest run; records the cycle. */
  review(hitchId: string): Promise<{ runId: string; decision: string }>;
  /** Run deterministic command close checks from the domain policy allowlist. */
  closeCheck(hitchId: string): Promise<{
    runId: string;
    checked: number;
    passed: number;
    failed: number;
  }>;
  /**
   * Classify open unknown-scope findings (#230 deliberation jury). harness-origin
   * findings the heuristic still leaves `unknown` go through the 3-phase jury;
   * operator-origin unknowns escalate (never machine-classified). Returns the
   * structured `ClassifyRunnerResult`: `resolved:false` carries an escalate
   * decision + a consultant-grade decision packet; `resolved:true` may carry a
   * non-escalating `severityAuditPacket` and/or `moreUnknownsPending` (a jury
   * batch was capped — the orchestrator halts this invocation cleanly).
   */
  classify(hitchId: string): Promise<ClassifyRunnerResult>;
  /** Defer open out-of-scope findings to the backlog. Returns how many were deferred. */
  defer(hitchId: string): Promise<{ deferred: number }>;
  /**
   * Close the hitch and create a PR. Returns the PR url. Phase 3: when
   * auto-merge is enabled it also merges the PR (`merged: true`) or, if the
   * merge gate is hard-blocked, returns an `escalateReason` instead of closing.
   */
  closeAndPr(hitchId: string): Promise<{
    prUrl: string;
    draft: boolean;
    merged?: boolean;
    escalateReason?: string;
    /**
     * (#396 part 2) The close PR push failed transiently and is under budget: the
     * hitch was left non-terminal `close_ready`, NO PR was created, and a later
     * pass should re-push. Distinct from the CI-not-green recheck (`merged:false`
     * with a real PR), so `await-merge` STOPS instead of re-polling closeAndPr
     * (which would burn the run-scoped retry budget within one invocation).
     */
    pushRetryPending?: boolean;
  }>;
  /**
   * Best-effort, fail-closed salvage for a review-step failure: commit and push
   * the latest needs_review run's reviewed branch without creating a PR or
   * closing the hitch. Omitted by tests/fakes that do not support real git.
   */
  salvageReviewBranch?(hitchId: string): Promise<{
    branch: string;
    headSha: string;
    committed: boolean;
  } | null>;
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
  | "merged"
  | "close_ready"
  | "waiting"
  // (#396 part 2) a transient close-PR push left the hitch close_ready with no PR;
  // re-run to retry. Non-terminal, NOT an escalation (course re-derives the live
  // close_ready and keeps the phase open, exactly as for the CI-not-green recheck).
  | "push_retry_pending"
  | "max_steps_exhausted";

export interface HitchOrchestrationResult {
  hitchId: string;
  outcome: OrchestrationOutcome;
  steps: OrchestrationStep[];
  finalDecision: string;
  escalateReason?: string;
  prUrl?: string;
  draft?: boolean;
}
