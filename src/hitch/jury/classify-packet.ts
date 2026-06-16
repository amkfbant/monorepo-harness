import {
  buildJurySplitPacket,
  buildOperatorOriginPacket,
  type JurySplitDeliberation,
} from "./decision-packet.js";
import type { DeliberationOutcome } from "./deliberate.js";
import type {
  DecisionPacketSeverityAudit,
  HitchDecisionPacket,
  JuryClassificationProposal,
} from "./types.js";
import type { HitchFinding } from "../types.js";

/**
 * #230 Task D1 — escalate-packet assembly (extracted from classify-runner to
 * keep files small). PURE functions: they shape `HitchDecisionPacket`s from
 * deliberation results, with no IO and no state transition.
 *
 * R14: a mixed harness/operator escalate batch is bundled into ONE packet with
 * plural `decisionKinds`, per-finding `origin`, and every finding's manual
 * `nextAction` listed (none hidden).
 */

/** The accumulated Phase-3 escalate state (bundled into a single packet). */
export interface EscalateBundle {
  splits: JurySplitDeliberation[];
  operatorFindings: HitchFinding[];
  operatorDeliberationIds: Record<string, string>;
  reasons: string[];
}

/** The selected final-round proposals (round 2 if critique ran, else round 1). */
export function finalRoundProposals(
  outcome: DeliberationOutcome,
): JuryClassificationProposal[] {
  const round = outcome.proposals.some((p) => p.round === 2) ? 2 : 1;
  return outcome.proposals.filter((p) => p.round === round);
}

/** Map a deliberation severity audit to the packet severity-audit shape. */
export function toPacketSeverityAudit(
  outcome: DeliberationOutcome,
): DecisionPacketSeverityAudit {
  const a = outcome.severityAudit;
  return {
    harnessSeverity: a.harnessSeverity,
    ...(a.juryConsensus !== undefined ? { juryConsensus: a.juryConsensus } : {}),
    status: a.status,
    escalate: a.escalate,
  };
}

/** Build the per-candidate split deliberation for the bundled split packet. */
export function toSplitDeliberation(
  finding: HitchFinding,
  outcome: DeliberationOutcome,
): JurySplitDeliberation {
  return {
    finding,
    deliberationId: outcome.deliberationId,
    proposals: finalRoundProposals(outcome),
    refuter: outcome.refutation?.verdict ?? null,
    critiqueRan: outcome.critiqueRan,
    gateTrace: outcome.result.gateTrace,
  };
}

/**
 * Build the bundled escalate packet covering jury splits + operator-origin
 * findings. A single-kind bundle returns the formatter's packet directly; a
 * mixed batch merges both into one packet (R14).
 */
export function buildBundledPacket(bundle: EscalateBundle): HitchDecisionPacket {
  const splitPacket =
    bundle.splits.length > 0
      ? buildJurySplitPacket({ splits: bundle.splits })
      : null;
  const operatorPacket =
    bundle.operatorFindings.length > 0
      ? buildOperatorOriginPacket({
          findings: bundle.operatorFindings,
          deliberationIds: bundle.operatorDeliberationIds,
        })
      : null;
  if (splitPacket !== null && operatorPacket === null) return splitPacket;
  if (operatorPacket !== null && splitPacket === null) return operatorPacket;
  // Mixed batch: merge both into one packet (R14: plural decisionKinds, every
  // finding keeps its origin, every nextAction is listed — none hidden).
  const lead = splitPacket ?? operatorPacket;
  if (lead === null) {
    // No content — should not happen (caller only escalates with content).
    return buildOperatorOriginPacket({ findings: [], deliberationIds: {} });
  }
  const other = lead === splitPacket ? operatorPacket : splitPacket;
  // The merge is TOTAL over the per-finding ARRAY fields: a mixed batch must not
  // drop one side's findings / axes / actions / risks / assumptions (R14: no
  // finding's required manual action is ever hidden). Every list-shaped field is
  // concatenated (decisionKinds additionally de-duped).
  //
  // The non-list SUMMARY fields are intentionally LEAD-ONLY (inherited via the
  // `...lead` spread): `minorityView`, `deliberation` (critiqueRan / refuter /
  // gateTrace), and `severityAudit` summarize a SINGLE deliberation and cannot be
  // meaningfully fused across multiple bundled deliberations — there is no
  // single "minority" or "refuter verdict" for a batch. Per-finding linkage is
  // preserved in `findings[].deliberationId`, and the Layer 0 doctor only maps
  // the shared `deliberation.refuter` block to the LEAD finding (jury-doctor-
  // checks FIX 3), so a lead-only summary never produces false matches for the
  // non-lead findings (those are validated against their OWN per-deliberation
  // rows). `recommendation` is likewise the lead's.
  return {
    ...lead,
    decisionKinds: dedupeKinds([
      ...lead.decisionKinds,
      ...(other?.decisionKinds ?? []),
    ]),
    findings: [...lead.findings, ...(other?.findings ?? [])],
    evaluationAxes: [...lead.evaluationAxes, ...(other?.evaluationAxes ?? [])],
    rejectedProposals: [
      ...lead.rejectedProposals,
      ...(other?.rejectedProposals ?? []),
    ],
    riskFlags: [...lead.riskFlags, ...(other?.riskFlags ?? [])],
    unvalidatedAssumptions: [
      ...lead.unvalidatedAssumptions,
      ...(other?.unvalidatedAssumptions ?? []),
    ],
    nextActions: [...lead.nextActions, ...(other?.nextActions ?? [])],
  };
}

function dedupeKinds(
  kinds: HitchDecisionPacket["decisionKinds"],
): HitchDecisionPacket["decisionKinds"] {
  return [...new Set(kinds)];
}
