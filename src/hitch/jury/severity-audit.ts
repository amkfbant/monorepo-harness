import type { HitchFindingSeverity } from "../types.js";

/**
 * #230 deliberation jury — advisory-only severity audit (Layer 1, pure).
 *
 * Frozen contract: `docs/design/proposals/design-gate-specs.md` §3. This is a
 * verbatim port of the frozen `auditSeverity` logic. It is a pure function:
 * same input -> deep-equal output, no IO, no state transition.
 *
 * Safety boundary (design-gate-specs §5, gate-specs §3.2):
 * - `harnessSeverity` is returned UNCHANGED. The audit NEVER auto-changes
 *   (and never auto-downgrades) severity — divergence only sets `escalate` so a
 *   human reviews via the decision packet.
 * - `reasoning` is advisory record only; it never drives any gate.
 * - Strict majority = a severity whose vote count is `> total / 2`. A tie,
 *   an all-different split, or zero votes never forms a majority (fail-closed).
 */

/** Input to the advisory severity audit (frozen §3.1). */
export interface SeverityAuditContext {
  /** Immutable harness-assigned severity (fixed mapping origin). */
  harnessSeverity: HitchFindingSeverity;
  juryVotes: {
    lens: string;
    juryProposedSeverity: HitchFindingSeverity;
    reasoning?: string;
  }[];
  finding: { findingId: string; summary: string };
}

/** Result of the advisory severity audit (frozen §3.1). */
export interface SeverityAuditResult {
  /** The harness severity, returned UNCHANGED (no auto-mutation). */
  harnessSeverity: HitchFindingSeverity;
  /** The strict-majority jury severity, if one exists; otherwise undefined. */
  juryConsensus?: HitchFindingSeverity;
  status: "aligned" | "diverged" | "inconclusive";
  /** `true` IFF `diverged || inconclusive`. */
  escalate: boolean;
  /** Fixed-format advisory reasoning (gate non-driving). */
  reasoning: string;
}

/**
 * Find the severity with a strict majority of votes (`count > total / 2`), or
 * `undefined` when no severity holds a strict majority (tie / all-different /
 * zero votes). Deterministic: iterates votes in input order; because only one
 * severity can ever hold a strict majority, the result is order-independent.
 */
function strictMajoritySeverity(
  votes: readonly { juryProposedSeverity: HitchFindingSeverity }[],
): HitchFindingSeverity | undefined {
  const total = votes.length;
  if (total === 0) return undefined;
  const counts = new Map<HitchFindingSeverity, number>();
  for (const v of votes) {
    counts.set(
      v.juryProposedSeverity,
      (counts.get(v.juryProposedSeverity) ?? 0) + 1,
    );
  }
  for (const [severity, count] of counts) {
    if (count > total / 2) return severity;
  }
  return undefined;
}

/**
 * Advisory-only, deterministic severity audit (frozen §3.2).
 *
 * - `aligned`: strict majority === `harnessSeverity` -> `escalate:false`,
 *   `juryConsensus = harnessSeverity`.
 * - `diverged`: strict majority !== `harnessSeverity` -> `escalate:true`,
 *   `juryConsensus = majority` (`harnessSeverity` still UNCHANGED).
 * - `inconclusive`: no strict majority (tie / all-different / zero votes) ->
 *   `escalate:true`, `juryConsensus = undefined`.
 *
 * `harnessSeverity` is ALWAYS returned unchanged — the audit never mutates or
 * downgrades severity; it only records divergence for human escalation.
 */
export function auditSeverity(
  context: SeverityAuditContext,
): SeverityAuditResult {
  const { harnessSeverity, finding, juryVotes } = context;
  const majority = strictMajoritySeverity(juryVotes);

  if (majority === undefined) {
    // `juryConsensus` is omitted (not set to `undefined`) to satisfy
    // exactOptionalPropertyTypes while keeping it `undefined` to readers.
    return {
      harnessSeverity,
      status: "inconclusive",
      escalate: true,
      reasoning: `severity audit inconclusive for ${finding.findingId}: no strict majority among ${juryVotes.length} jury vote(s); harness severity ${harnessSeverity} unchanged`,
    };
  }

  if (majority === harnessSeverity) {
    return {
      harnessSeverity,
      juryConsensus: majority,
      status: "aligned",
      escalate: false,
      reasoning: `severity audit aligned for ${finding.findingId}: jury majority ${majority} matches harness severity ${harnessSeverity}`,
    };
  }

  return {
    harnessSeverity,
    juryConsensus: majority,
    status: "diverged",
    escalate: true,
    reasoning: `severity audit diverged for ${finding.findingId}: jury majority ${majority} differs from harness severity ${harnessSeverity} (advisory-only; harness severity unchanged)`,
  };
}
