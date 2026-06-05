/**
 * Auto-merge gate (Phase 3-1).
 *
 * Pure, deterministic decision: may the harness auto-merge this PR? Inputs
 * are facts the harness can verify from the DB (close-ready, consensus,
 * human override) plus a CI-green snapshot the wiring fetches from `gh`.
 * LLM output is never an input. Approval requires consensus approved (with
 * quorum) OR a human override — fail-closed otherwise. Auto-merge is further
 * limited to Tier-0 path changes by the deterministic sensitivity map.
 *
 * Blockers are split into "hard" (need a human — escalate) and "transient"
 * (CI not green yet, or tier not eligible — leave the PR open, do not
 * escalate), so the wiring can pick the safe response.
 */

export interface MergeGateConsensus {
  status: "pending" | "approved" | "changes_requested" | "rejected";
  /** All requirement groups satisfy quorum (latest-proposal mode → true). */
  quorumSatisfied: boolean;
}

export interface MergeGateInput {
  /** Opt-in: default OFF. When false the gate never merges. */
  autoMergeEnabled: boolean;
  closeReady: boolean;
  consensus: MergeGateConsensus | null;
  humanApproved: boolean;
  ciGreen: boolean;
  tierEligible: boolean;
}

export type MergeBlockerReason =
  | "auto_merge_disabled"
  | "not_close_ready"
  | "consensus_not_approved"
  | "quorum_not_satisfied"
  | "ci_not_green"
  | "tier_not_auto_eligible";

export interface MergeGateResult {
  canMerge: boolean;
  blockers: MergeBlockerReason[];
  /** True when at least one blocker needs human intervention (escalate). */
  hardBlocked: boolean;
}

const HARD_BLOCKERS = new Set<MergeBlockerReason>([
  "not_close_ready",
  "consensus_not_approved",
  "quorum_not_satisfied",
]);

/**
 * Whether a consensus summary's requirement groups all satisfy quorum. A valid
 * empty array is latest-proposal (no quorum to satisfy → true). Anything that
 * is not an array, or any requirement whose `quorumMet` is not strictly `true`
 * (missing / non-boolean / a truthy non-boolean like `"yes"`), is fail-closed
 * (false) so a malformed summary cannot let a merge through.
 */
export function quorumSatisfiedFromRequirements(requirements: unknown): boolean {
  return (
    Array.isArray(requirements) &&
    requirements.every(
      (r) => (r as { quorumMet?: unknown } | null)?.quorumMet === true,
    )
  );
}

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const blockers: MergeBlockerReason[] = [];

  if (!input.autoMergeEnabled) {
    // A disabled gate is not a failure that needs a human — it is simply off.
    return { canMerge: false, blockers: ["auto_merge_disabled"], hardBlocked: false };
  }

  if (!input.closeReady) blockers.push("not_close_ready");

  // Approval: a human override approve is sufficient on its own; otherwise the
  // consensus must be approved AND satisfy quorum (fail-closed when absent).
  if (!input.humanApproved) {
    if (input.consensus === null || input.consensus.status !== "approved") {
      blockers.push("consensus_not_approved");
    } else if (!input.consensus.quorumSatisfied) {
      blockers.push("quorum_not_satisfied");
    }
  }

  if (!input.ciGreen) blockers.push("ci_not_green");
  if (!input.tierEligible) blockers.push("tier_not_auto_eligible");

  return {
    canMerge: blockers.length === 0,
    blockers,
    hardBlocked: blockers.some((b) => HARD_BLOCKERS.has(b)),
  };
}
