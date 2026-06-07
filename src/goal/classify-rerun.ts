/**
 * Deterministic guard for the `goal finding classify --then-rerun` auto-chain
 * (C#8): after an operator manually classifies a finding (the human-in-the-loop
 * boundary — external/unknown findings are never auto-classified), decide
 * whether to auto-run the orchestrator to address it.
 *
 * The chain runs ONLY when explicitly requested AND the classification left the
 * goal at `needs_fix` (an open in-scope finding the coder can address). For any
 * other post-classification decision it does NOT auto-run:
 *   - `needs_classification` — other unknowns remain; the orchestrator would just
 *     escalate (it must never auto-classify external output).
 *   - `close_ready` — a classify must not silently open a PR / merge.
 *   - anything else — let the operator drive `goal orchestrate` deliberately.
 *
 * This keeps the safety boundary: convergence (harness-only) decides whether a
 * coder rerun is warranted; the operator's explicit classification + flag is the
 * trigger; the codex coder is execution-only.
 */
import type { GoalConvergenceDecision } from "./types.js";

export type ChainSkipReason = "not_requested" | "not_needs_fix";

export type ClassifyChainDecision =
  | { chain: true }
  | { chain: false; reason: ChainSkipReason };

export function classifyChainDecision(
  thenRerun: boolean,
  decisionAfter: GoalConvergenceDecision,
): ClassifyChainDecision {
  if (!thenRerun) return { chain: false, reason: "not_requested" };
  if (decisionAfter !== "needs_fix") {
    return { chain: false, reason: "not_needs_fix" };
  }
  return { chain: true };
}
