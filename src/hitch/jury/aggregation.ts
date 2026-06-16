import {
  JURY_LENSES,
  type JuryClassificationProposal,
} from "./types.js";

/**
 * #230 deliberation jury — deterministic scope aggregation (Layer 1, pure).
 *
 * Frozen contract: see `docs/design/proposals/design-gate-specs.md` §1/§2.
 * This is a verbatim port of the frozen `aggregateJuryVotes` logic. It is a
 * pure function: same input -> deep-equal output, no IO, no state transition.
 *
 * Safety boundary (design-gate-specs §5):
 * - `confidence` NEVER drives the decision (no float gate).
 * - Majority is never auto-confirmed: only a full 3-lens-distinct unanimous
 *   set with zero inconclusive votes yields `unanimous`; everything else is
 *   `split` (fail-closed).
 * - No state transition happens here — the caller acts on the result.
 */

/** Result of the deterministic scope aggregation (frozen contract §2.1). */
export interface JuryAggregate {
  decision: "unanimous" | "split";
  /** Present only when `decision === 'unanimous'`. */
  scope?: "in_scope" | "out_of_scope";
  /** Fixed-format reason string (§2.4) — deterministic, character-for-character. */
  reason: string;
}

/**
 * Deterministic "inconclusive" predicate (frozen §1, CC5).
 *
 * A proposal is inconclusive when it did not complete OR its proposed scope is
 * `unknown`. Inconclusive votes can never participate in a unanimous verdict.
 */
function isInconclusive(p: JuryClassificationProposal): boolean {
  return p.proposalStatus !== "complete" || p.proposedScope === "unknown";
}

/**
 * Whether the lens set is exactly {correctness, scope_fit, spec_adherence}
 * with each lens present exactly once (frozen §2.2 CC13 — distinct required).
 */
function lensSetIsDistinctAndComplete(
  proposals: readonly JuryClassificationProposal[],
): boolean {
  const lenses = new Set(proposals.map((p) => p.lens));
  return lenses.size === JURY_LENSES.length && JURY_LENSES.every((l) => lenses.has(l));
}

/**
 * Build the fixed-order split reason string (frozen §2.4).
 *
 * Counts (fixed order in_scope -> out_of_scope -> unknown -> incomplete):
 * - N1 = scope === 'in_scope'      && status === 'complete'
 * - N2 = scope === 'out_of_scope'  && status === 'complete'
 * - N3 = scope === 'unknown'       (status-independent)
 * - N4 = status !== 'complete'     (scope-independent)
 *
 * N3 and N4 are independent dimensions and may overlap by design (a vote that
 * is both `unknown` and `timeout` contributes to both N3 and N4).
 */
function splitReason(proposals: readonly JuryClassificationProposal[]): string {
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  let n4 = 0;
  for (const p of proposals) {
    if (p.proposedScope === "in_scope" && p.proposalStatus === "complete") n1 += 1;
    if (p.proposedScope === "out_of_scope" && p.proposalStatus === "complete") n2 += 1;
    if (p.proposedScope === "unknown") n3 += 1;
    if (p.proposalStatus !== "complete") n4 += 1;
  }
  return `split votes: in_scope(${n1}), out_of_scope(${n2}), unknown(${n3}), incomplete(${n4})`;
}

/**
 * Deterministically aggregate the per-lens classification proposals into a
 * `unanimous` (auto-confirmable scope) or `split` (fail-closed -> escalate)
 * verdict.
 *
 * `unanimous` IFF (frozen §2.2):
 * - `proposals.length === 3`
 * - lens set is exactly {correctness, scope_fit, spec_adherence}, distinct
 * - no proposal `isInconclusive`
 * - all 3 `proposedScope` are identical (`in_scope` or `out_of_scope`)
 *
 * Everything else is `split` (fail-closed).
 */
export function aggregateJuryVotes(
  proposals: readonly JuryClassificationProposal[],
): JuryAggregate {
  const first = proposals[0];
  const isUnanimous =
    first !== undefined &&
    proposals.length === JURY_LENSES.length &&
    lensSetIsDistinctAndComplete(proposals) &&
    proposals.every((p) => !isInconclusive(p)) &&
    proposals.every((p) => p.proposedScope === first.proposedScope);

  if (isUnanimous) {
    // After the guards above, the shared scope is necessarily in_scope or
    // out_of_scope (unknown is excluded by !isInconclusive).
    const scope = first.proposedScope as "in_scope" | "out_of_scope";
    return {
      decision: "unanimous",
      scope,
      reason: `unanimous ${scope} (3/3 lenses agreed)`,
    };
  }

  return {
    decision: "split",
    reason: splitReason(proposals),
  };
}
