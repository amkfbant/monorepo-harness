import { describe, it, expect } from "vitest";
import {
  buildJurySplitPacket,
  buildOperatorOriginPacket,
  buildSeverityAuditPacket,
  type JurySplitInput,
  type OperatorOriginInput,
  type SeverityAuditPacketInput,
} from "../../../../src/hitch/jury/decision-packet.js";
import type { HitchFinding } from "../../../../src/hitch/types.js";
import type {
  JuryClassificationProposal,
  VerifiedJuryEvidence,
  RefuterVerdict,
} from "../../../../src/hitch/jury/types.js";

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

const ev = (over: Partial<VerifiedJuryEvidence> = {}): VerifiedJuryEvidence => ({
  citation: "src/a.ts:10",
  kind: "file",
  claim: "the cited line implements the behaviour",
  verified: true,
  ...over,
});

const proposal = (
  lens: JuryClassificationProposal["lens"],
  scope: JuryClassificationProposal["proposedScope"],
  over: Partial<JuryClassificationProposal> = {},
): JuryClassificationProposal => ({
  findingId: "f1",
  lens,
  proposedScope: scope,
  proposalStatus: "complete",
  evidence: [ev()],
  round: 2,
  reasoning: `${lens} says ${scope}`,
  ...over,
});

const upheld: RefuterVerdict = {
  refuteVerdict: "uphold",
  reasoning: "no false consensus; refutation conditions stated",
};

function roundTrips(packet: unknown): void {
  expect(JSON.parse(JSON.stringify(packet))).toEqual(packet);
}

describe("buildJurySplitPacket", () => {
  const splitInput: JurySplitInput = {
    splits: [
      {
        finding: finding(),
        deliberationId: "d1",
        proposals: [
          proposal("correctness", "in_scope"),
          proposal("scope_fit", "in_scope"),
          proposal("spec_adherence", "out_of_scope", {
            reasoning: "spec says out of scope",
          }),
        ],
        refuter: upheld,
        critiqueRan: true,
        gateTrace: {
          scopeUnanimous: false,
          lensDistinct: true,
          noInconclusive: true,
          allHaveVerifiedEvidence: true,
          proximityOk: true,
          refuterUpheld: true,
        },
      },
    ],
  };

  it("produces a packetVersion:2 packet with classify_scope decisionKinds (plural array)", () => {
    const packet = buildJurySplitPacket(splitInput);
    expect(packet.packetVersion).toBe(2);
    expect(Array.isArray(packet.decisionKinds)).toBe(true);
    expect(packet.decisionKinds).toContain("classify_scope");
  });

  it("recommendation.action is review_split (R7 rich action set)", () => {
    expect(buildJurySplitPacket(splitInput).recommendation.action).toBe(
      "review_split",
    );
  });

  it("RED-11: findings carry summary/detail/severity/scopeStatus verbatim + per-finding deliberationId + harness origin", () => {
    const packet = buildJurySplitPacket(splitInput);
    expect(packet.findings).toHaveLength(1);
    const f = packet.findings[0]!;
    expect(f.findingId).toBe("f1");
    expect(f.summary).toBe("f1 summary");
    expect(f.detail).toBe("f1 detail");
    expect(f.severity).toBe("P1");
    expect(f.scopeStatus).toBe("unknown");
    expect(f.deliberationId).toBe("d1");
    expect(f.origin).toBe("harness");
  });

  it("RED-11: evaluationAxes lensVotes carry scope + proposalStatus + reasoning verbatim", () => {
    const packet = buildJurySplitPacket(splitInput);
    const axes = Object.fromEntries(packet.evaluationAxes.map((a) => [a.axis, a]));
    expect(packet.evaluationAxes.map((a) => a.axis)).toEqual([
      "correctness",
      "scope_fit",
      "spec_adherence",
    ]);
    const cVote = axes["correctness"]!.lensVotes[0]!;
    expect(cVote.scope).toBe("in_scope");
    expect(cVote.proposalStatus).toBe("complete");
    expect(cVote.reasoning).toBe("correctness says in_scope");
    const specVote = axes["spec_adherence"]!.lensVotes[0]!;
    expect(specVote.scope).toBe("out_of_scope");
    expect(specVote.reasoning).toBe("spec says out of scope");
  });

  it("PR5/R2: a proposal with proposedSeverity round-trips into lensVotes[].severity", () => {
    const withSeverity: JurySplitInput = {
      splits: [
        {
          ...splitInput.splits[0]!,
          proposals: [
            proposal("correctness", "in_scope", { proposedSeverity: "P0" }),
            proposal("scope_fit", "in_scope", { proposedSeverity: "P2" }),
            proposal("spec_adherence", "out_of_scope"),
          ],
        },
      ],
    };
    const packet = buildJurySplitPacket(withSeverity);
    const axes = Object.fromEntries(packet.evaluationAxes.map((a) => [a.axis, a]));
    expect(axes["correctness"]!.lensVotes[0]!.severity).toBe("P0");
    expect(axes["scope_fit"]!.lensVotes[0]!.severity).toBe("P2");
    // a lens that did not vote severity leaves it undefined (not stuffed)
    expect(axes["spec_adherence"]!.lensVotes[0]!.severity).toBeUndefined();
  });

  it("UNVERIFIED evidence goes into unvalidatedAssumptions[], NOT evaluationAxes evidence", () => {
    const unverified = ev({ citation: "vendor/x.ts:1", verified: false });
    const input: JurySplitInput = {
      splits: [
        {
          ...splitInput.splits[0]!,
          proposals: [
            proposal("correctness", "in_scope", {
              evidence: [ev(), unverified],
            }),
            proposal("scope_fit", "in_scope"),
            proposal("spec_adherence", "out_of_scope"),
          ],
        },
      ],
    };
    const packet = buildJurySplitPacket(input);
    // unverified citation must NOT appear in any evaluationAxes evidence
    const allAxisEvidence = packet.evaluationAxes
      .flatMap((a) => a.lensVotes)
      .flatMap((v) => v.evidence ?? []);
    expect(allAxisEvidence.every((e) => e.verified === true)).toBe(true);
    expect(allAxisEvidence.some((e) => e.citation === "vendor/x.ts:1")).toBe(
      false,
    );
    // it must appear in unvalidatedAssumptions instead
    expect(
      packet.unvalidatedAssumptions.some((u) =>
        u.assumption.includes("vendor/x.ts:1"),
      ),
    ).toBe(true);
  });

  it("nextActions[] are owned by the operator and list the finding's required manual action", () => {
    const packet = buildJurySplitPacket(splitInput);
    expect(packet.nextActions.length).toBeGreaterThan(0);
    expect(packet.nextActions.every((a) => a.owner === "operator")).toBe(true);
    expect(packet.nextActions.some((a) => a.action.includes("f1"))).toBe(true);
  });

  it("carries the deliberation block (critiqueRan / refuter / gateTrace)", () => {
    const packet = buildJurySplitPacket(splitInput);
    expect(packet.deliberation.critiqueRan).toBe(true);
    expect(packet.deliberation.refuter).toEqual(upheld);
    expect(packet.deliberation.gateTrace.scopeUnanimous).toBe(false);
  });

  it("JSON round-trips (deep-equals) and does not stuff JSON into a message string", () => {
    const packet = buildJurySplitPacket(splitInput);
    roundTrips(packet);
  });

  it("a bundled split packet over multiple findings emits a nextAction per finding (none hidden)", () => {
    const bundled: JurySplitInput = {
      splits: [
        splitInput.splits[0]!,
        {
          finding: finding({ findingId: "f2", summary: "f2 summary" }),
          deliberationId: "d2",
          proposals: [
            proposal("correctness", "out_of_scope", { findingId: "f2" }),
            proposal("scope_fit", "in_scope", { findingId: "f2" }),
            proposal("spec_adherence", "in_scope", { findingId: "f2" }),
          ],
          refuter: upheld,
          critiqueRan: false,
          gateTrace: splitInput.splits[0]!.gateTrace,
        },
      ],
    };
    const packet = buildJurySplitPacket(bundled);
    expect(packet.findings.map((f) => f.findingId)).toEqual(["f1", "f2"]);
    expect(packet.findings.map((f) => f.deliberationId)).toEqual(["d1", "d2"]);
    // every finding has at least one operator nextAction (none hidden)
    for (const f of ["f1", "f2"]) {
      expect(packet.nextActions.some((a) => a.action.includes(f))).toBe(true);
    }
  });

  it("codex#254-P2 FIX1: in a bundled packet, EVERY lensVote is attributable to its finding (findingId present + correct)", () => {
    const bundled: JurySplitInput = {
      splits: [
        splitInput.splits[0]!,
        {
          finding: finding({ findingId: "f2", summary: "f2 summary" }),
          deliberationId: "d2",
          proposals: [
            proposal("correctness", "out_of_scope", { findingId: "f2" }),
            proposal("scope_fit", "in_scope", { findingId: "f2" }),
            proposal("spec_adherence", "in_scope", { findingId: "f2" }),
          ],
          refuter: upheld,
          critiqueRan: false,
          gateTrace: splitInput.splits[0]!.gateTrace,
        },
      ],
    };
    const packet = buildJurySplitPacket(bundled);
    const allVotes = packet.evaluationAxes.flatMap((a) => a.lensVotes);
    // No vote may be unattributable (findingId never undefined).
    expect(allVotes.length).toBeGreaterThan(0);
    expect(allVotes.every((v) => v.findingId === "f1" || v.findingId === "f2")).toBe(
      true,
    );
    // The correctness axis bundles BOTH findings' correctness votes; each is
    // attributed to the right finding with the right scope.
    const correctness = packet.evaluationAxes.find((a) => a.axis === "correctness")!;
    const f1Vote = correctness.lensVotes.find((v) => v.findingId === "f1")!;
    const f2Vote = correctness.lensVotes.find((v) => v.findingId === "f2")!;
    expect(f1Vote.scope).toBe("in_scope");
    expect(f2Vote.scope).toBe("out_of_scope");
  });

  it("codex#254-P2 FIX1: in a bundled packet, EVERY rejectedProposal is attributable to its finding (findingId present + correct)", () => {
    const bundled: JurySplitInput = {
      splits: [
        splitInput.splits[0]!, // f1: correctness/scope_fit in_scope, spec out_of_scope
        {
          finding: finding({ findingId: "f2", summary: "f2 summary" }),
          deliberationId: "d2",
          proposals: [
            proposal("correctness", "out_of_scope", { findingId: "f2" }),
            proposal("scope_fit", "unknown", { findingId: "f2" }),
            proposal("spec_adherence", "unknown", { findingId: "f2" }),
          ],
          refuter: upheld,
          critiqueRan: false,
          gateTrace: splitInput.splits[0]!.gateTrace,
        },
      ],
    };
    const packet = buildJurySplitPacket(bundled);
    expect(packet.rejectedProposals.length).toBeGreaterThan(0);
    // Each rejectedProposal entry names its finding.
    expect(
      packet.rejectedProposals.every(
        (r) => r.findingId === "f1" || r.findingId === "f2",
      ),
    ).toBe(true);
    // f1 has its own scope tallies; f2 has its own — the two are NOT merged into a
    // single finding-blind tally.
    const f1Out = packet.rejectedProposals.find(
      (r) => r.findingId === "f1" && r.scope === "out_of_scope",
    );
    const f2Out = packet.rejectedProposals.find(
      (r) => r.findingId === "f2" && r.scope === "out_of_scope",
    );
    expect(f1Out?.lensCount).toBe(1); // spec_adherence
    expect(f2Out?.lensCount).toBe(1); // correctness
    const f2Unknown = packet.rejectedProposals.find(
      (r) => r.findingId === "f2" && r.scope === "unknown",
    );
    expect(f2Unknown?.lensCount).toBe(2); // scope_fit + spec_adherence
  });

  it("codex#254-P2 FIX1: a single-finding split packet still attributes lensVotes (findingId set)", () => {
    const packet = buildJurySplitPacket(splitInput);
    const allVotes = packet.evaluationAxes.flatMap((a) => a.lensVotes);
    expect(allVotes.length).toBeGreaterThan(0);
    expect(allVotes.every((v) => v.findingId === "f1")).toBe(true);
  });
});

describe("buildOperatorOriginPacket", () => {
  const opInput: OperatorOriginInput = {
    findings: [
      finding({
        findingId: "op1",
        source: "human",
        summary: "operator-raised unknown",
        scopeStatus: "unknown",
      }),
    ],
    deliberationIds: { op1: "od1" },
  };

  it("decisionKinds includes operator_origin_unknown", () => {
    expect(buildOperatorOriginPacket(opInput).decisionKinds).toContain(
      "operator_origin_unknown",
    );
  });

  it("recommendation.action is classify_manually", () => {
    expect(buildOperatorOriginPacket(opInput).recommendation.action).toBe(
      "classify_manually",
    );
  });

  it("findings[].origin is operator and carries per-finding deliberationId + RED-11 anchors", () => {
    const packet = buildOperatorOriginPacket(opInput);
    expect(packet.packetVersion).toBe(2);
    const f = packet.findings[0]!;
    expect(f.origin).toBe("operator");
    expect(f.findingId).toBe("op1");
    expect(f.summary).toBe("operator-raised unknown");
    expect(f.deliberationId).toBe("od1");
  });

  it("nextActions are operator-owned, one per finding; JSON round-trips", () => {
    const packet = buildOperatorOriginPacket(opInput);
    expect(packet.nextActions.every((a) => a.owner === "operator")).toBe(true);
    expect(packet.nextActions.some((a) => a.action.includes("op1"))).toBe(true);
    roundTrips(packet);
  });
});

describe("buildSeverityAuditPacket", () => {
  const audInput: SeverityAuditPacketInput = {
    finding: finding({ findingId: "s1", summary: "severity diverged finding" }),
    deliberationId: "sd1",
    audit: {
      harnessSeverity: "P1",
      juryConsensus: "P0",
      status: "diverged",
      escalate: true,
    },
  };

  it("decisionKinds includes severity_audit and carries the severityAudit block", () => {
    const packet = buildSeverityAuditPacket(audInput);
    expect(packet.decisionKinds).toContain("severity_audit");
    expect(packet.severityAudit).toEqual({
      harnessSeverity: "P1",
      juryConsensus: "P0",
      status: "diverged",
      escalate: true,
    });
  });

  it("recommendation.action is review_severity (R7)", () => {
    expect(buildSeverityAuditPacket(audInput).recommendation.action).toBe(
      "review_severity",
    );
  });

  it("findings carry RED-11 anchors + per-finding deliberationId; nextActions operator-owned; JSON round-trips", () => {
    const packet = buildSeverityAuditPacket(audInput);
    expect(packet.packetVersion).toBe(2);
    const f = packet.findings[0]!;
    expect(f.findingId).toBe("s1");
    expect(f.summary).toBe("severity diverged finding");
    expect(f.severity).toBe("P1");
    expect(f.deliberationId).toBe("sd1");
    expect(packet.nextActions.every((a) => a.owner === "operator")).toBe(true);
    expect(packet.nextActions.some((a) => a.action.includes("s1"))).toBe(true);
    roundTrips(packet);
  });
});

describe("decision packet formatters are pure (deterministic)", () => {
  it("same input -> deep-equal packet (buildJurySplitPacket)", () => {
    const input: JurySplitInput = {
      splits: [
        {
          finding: finding(),
          deliberationId: "d1",
          proposals: [
            proposal("correctness", "in_scope"),
            proposal("scope_fit", "in_scope"),
            proposal("spec_adherence", "out_of_scope"),
          ],
          refuter: upheld,
          critiqueRan: true,
          gateTrace: {
            scopeUnanimous: false,
            lensDistinct: true,
            noInconclusive: true,
            allHaveVerifiedEvidence: true,
            proximityOk: true,
            refuterUpheld: true,
          },
        },
      ],
    };
    expect(buildJurySplitPacket(input)).toEqual(buildJurySplitPacket(input));
  });
});
