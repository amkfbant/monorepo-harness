import { describe, it, expect } from "vitest";
import {
  buildBundledPacket,
  type EscalateBundle,
} from "../../../../src/hitch/jury/classify-packet.js";
import {
  buildJurySplitPacket,
  buildOperatorOriginPacket,
  type JurySplitDeliberation,
} from "../../../../src/hitch/jury/decision-packet.js";
import type { HitchFinding } from "../../../../src/hitch/types.js";
import type { JuryClassificationProposal } from "../../../../src/hitch/jury/types.js";

/**
 * #230 FIX 8(c) — `buildBundledPacket` mixed-batch merge MUST be TOTAL over the
 * per-finding ARRAY fields (R14: no finding's required manual action is hidden),
 * while the non-list SUMMARY fields (minorityView / deliberation / severityAudit)
 * are intentionally LEAD-only (a batch has no single minority/refuter verdict).
 */

/** A minimal HitchFinding with the RED-11 anchors populated. */
function finding(over: Partial<HitchFinding> = {}): HitchFinding {
  return {
    findingId: "f1",
    hitchId: "h1",
    stableKey: "sk1",
    duplicateOf: null,
    source: "reviewer",
    sourceRef: null,
    sourceAttemptId: null,
    sourceCycleId: null,
    severity: "P1",
    category: "core",
    scopeStatus: "unknown",
    lifecycleStatus: "open",
    summary: "f1 summary",
    detail: "f1 detail",
    filePath: "src/a.ts",
    symbol: null,
    suggestedFix: null,
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    fixedAt: null,
    deferredAt: null,
    escalatedAt: null,
    reopenCount: 0,
    deferredBacklogItemId: null,
    classificationReason: null,
    resolutionNote: null,
    ...over,
  };
}

const proposal = (
  lens: JuryClassificationProposal["lens"],
  scope: JuryClassificationProposal["proposedScope"],
): JuryClassificationProposal => ({
  findingId: "fh",
  lens,
  proposedScope: scope,
  proposalStatus: "complete",
  evidence: [
    {
      citation: "src/a.ts:10",
      kind: "file",
      claim: "the cited line implements the behaviour",
      verified: true,
    },
  ],
  round: 2,
  reasoning: `${lens} says ${scope}`,
});

/** A harness split deliberation (genuinely split so it escalates). */
const split: JurySplitDeliberation = {
  finding: finding({ findingId: "fh", summary: "harness split" }),
  deliberationId: "d-harness",
  proposals: [
    proposal("correctness", "in_scope"),
    proposal("scope_fit", "in_scope"),
    proposal("spec_adherence", "out_of_scope"),
  ],
  refuter: null,
  critiqueRan: true,
  gateTrace: {
    scopeUnanimous: false,
    lensDistinct: true,
    noInconclusive: true,
    allHaveVerifiedEvidence: true,
    proximityOk: true,
    refuterUpheld: null,
  },
};

const operatorFinding = finding({
  findingId: "fo",
  source: "human",
  summary: "operator concern",
});

describe("buildBundledPacket (mixed harness/operator merge)", () => {
  it("a single-kind split bundle returns the split packet directly", () => {
    const bundle: EscalateBundle = {
      splits: [split],
      operatorFindings: [],
      operatorDeliberationIds: {},
      reasons: [],
    };
    expect(buildBundledPacket(bundle)).toEqual(
      buildJurySplitPacket({ splits: [split] }),
    );
  });

  it("a single-kind operator bundle returns the operator packet directly", () => {
    const bundle: EscalateBundle = {
      splits: [],
      operatorFindings: [operatorFinding],
      operatorDeliberationIds: { fo: "" },
      reasons: [],
    };
    expect(buildBundledPacket(bundle)).toEqual(
      buildOperatorOriginPacket({
        findings: [operatorFinding],
        deliberationIds: { fo: "" },
      }),
    );
  });

  it("FIX 8(c): a mixed batch merges EVERY array field totally (incl. riskFlags) and keeps lead-only summary fields", () => {
    const bundle: EscalateBundle = {
      splits: [split],
      operatorFindings: [operatorFinding],
      operatorDeliberationIds: { fo: "" },
      reasons: [],
    };
    const merged = buildBundledPacket(bundle);

    const splitPacket = buildJurySplitPacket({ splits: [split] });
    const operatorPacket = buildOperatorOriginPacket({
      findings: [operatorFinding],
      deliberationIds: { fo: "" },
    });

    // decisionKinds: both kinds present (de-duped union), no side hidden.
    expect(merged.decisionKinds).toContain("classify_scope");
    expect(merged.decisionKinds).toContain("operator_origin_unknown");

    // Every list-shaped field is the TOTAL concatenation lead ++ other.
    expect(merged.findings).toEqual([
      ...splitPacket.findings,
      ...operatorPacket.findings,
    ]);
    expect(merged.evaluationAxes).toEqual([
      ...splitPacket.evaluationAxes,
      ...operatorPacket.evaluationAxes,
    ]);
    expect(merged.rejectedProposals).toEqual([
      ...splitPacket.rejectedProposals,
      ...operatorPacket.rejectedProposals,
    ]);
    expect(merged.unvalidatedAssumptions).toEqual([
      ...splitPacket.unvalidatedAssumptions,
      ...operatorPacket.unvalidatedAssumptions,
    ]);
    expect(merged.nextActions).toEqual([
      ...splitPacket.nextActions,
      ...operatorPacket.nextActions,
    ]);
    // riskFlags is a TOTAL merge too (FIX 8c): present as an array equal to the
    // concatenation of both sides — never silently lead-only. (The current
    // builders both emit `riskFlags: []`, so this is a defensive completeness
    // contract: the day a builder emits a non-empty riskFlags the mixed batch
    // must surface BOTH sides' flags, not just the lead's.)
    expect(merged.riskFlags).toEqual([
      ...splitPacket.riskFlags,
      ...operatorPacket.riskFlags,
    ]);

    // BOTH findings' next actions survive (neither side's manual action hidden).
    const actionsBlob = merged.nextActions.map((a) => a.action).join(" | ");
    expect(actionsBlob).toContain("fh");
    expect(actionsBlob).toContain("fo");

    // Lead-only summary fields are inherited from the LEAD (split) packet.
    expect(merged.minorityView).toEqual(splitPacket.minorityView);
    expect(merged.deliberation).toEqual(splitPacket.deliberation);
    expect(merged.recommendation).toEqual(splitPacket.recommendation);

    // The merged packet round-trips through JSON unchanged.
    expect(JSON.parse(JSON.stringify(merged))).toEqual(merged);
  });
});
