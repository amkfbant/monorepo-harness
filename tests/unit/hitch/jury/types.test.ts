import { describe, it, expect } from "vitest";
import {
  JURY_LENSES,
  type RawJuryEvidence,
  type VerifiedJuryEvidence,
  type DeliberationInput,
  type HitchDecisionPacket,
} from "../../../../src/hitch/jury/types.js";
import type { HitchNextAction } from "../../../../src/hitch/types.js";

describe("jury/types", () => {
  it("JURY_LENSES is the three deliberation lenses in fixed order", () => {
    expect(JURY_LENSES).toEqual([
      "correctness",
      "scope_fit",
      "spec_adherence",
    ]);
  });

  it("a RawJuryEvidence value is NOT assignable to VerifiedJuryEvidence (P2-g brand boundary)", () => {
    const raw: RawJuryEvidence = {
      citation: "src/a.ts:10",
      kind: "file",
      claim: "x",
    };
    // NOTE: the load-bearing, typecheck-gated proof of this brand boundary is
    // `_assertRawIsNotVerified` in src/hitch/jury/types.ts — this @ts-expect-error
    // directive is NOT typecheck-gated because tsconfig excludes tests/ from tsc.
    // @ts-expect-error RawJuryEvidence は VerifiedJuryEvidence に代入不可
    // (unverified evidence cannot reach the gate by type — `verified` missing).
    const verified: VerifiedJuryEvidence = raw;
    // Keep `verified` load-bearing so the unused-var lint does not mask the
    // assignment that the @ts-expect-error guards.
    expect(verified.citation).toBe("src/a.ts:10");
  });

  it("verifyEvidence-shaped value (RawJuryEvidence + verified) IS a VerifiedJuryEvidence", () => {
    const v: VerifiedJuryEvidence = {
      citation: "src/a.ts:10",
      kind: "file",
      claim: "x",
      verified: true,
      resolvedRef: "src/a.ts:10",
    };
    expect(v.verified).toBe(true);
  });

  it("a HitchNextAction can carry an optional packet v2 (additive)", () => {
    const packet: HitchDecisionPacket = {
      packetVersion: 2,
      decisionKinds: ["classify_scope"],
      findings: [
        {
          findingId: "f1",
          summary: "scope split on f1",
          deliberationId: "d1",
          origin: "harness",
        },
      ],
      recommendation: {
        action: "review_split",
        rationale: "jury split; operator decides scope",
      },
      evaluationAxes: [
        {
          axis: "correctness",
          lensVotes: [
            {
              lens: "correctness",
              findingId: "f1",
              scope: "in_scope",
              proposalStatus: "complete",
              severity: "P1",
            },
          ],
          consensus: "split",
        },
      ],
      deliberation: {
        critiqueRan: true,
        refuter: { refuteVerdict: "uphold", reasoning: "no false consensus" },
        gateTrace: {
          scopeUnanimous: false,
          lensDistinct: true,
          noInconclusive: true,
          allHaveVerifiedEvidence: true,
          proximityOk: true,
          refuterUpheld: true,
        },
      },
      rejectedProposals: [
        { findingId: "f1", scope: "out_of_scope", lensCount: 1, reason: "minority" },
      ],
      minorityView: {
        count: 1,
        scopes: ["out_of_scope"],
        reasoning: "one lens dissents",
      },
      riskFlags: [
        { flag: "low-evidence", impact: "medium", mitigation: "manual review" },
      ],
      unvalidatedAssumptions: [
        {
          assumption: "citation supports claim",
          source: "lens correctness",
          verification: "operator reads cited file",
        },
      ],
      nextActions: [
        {
          owner: "operator",
          action: "classify f1 manually",
          verificationMethod: "scope decision recorded",
        },
      ],
      severityAudit: {
        harnessSeverity: "P1",
        juryConsensus: "P1",
        status: "aligned",
        escalate: false,
      },
    };
    const action: HitchNextAction = {
      kind: "ask_human",
      message: "scope split — operator decides",
      decisionPacket: packet,
    };
    expect(action.decisionPacket?.packetVersion).toBe(2);
    expect(action.decisionPacket?.findings[0]?.deliberationId).toBe("d1");
    expect(action.decisionPacket?.decisionKinds).toContain("classify_scope");
  });

  it("a HitchNextAction round-trips without a decisionPacket (additive optional)", () => {
    const action: HitchNextAction = {
      kind: "fix_findings",
      findingIds: ["f1", "f2"],
      message: "fix the open in-scope findings",
    };
    const json = JSON.parse(JSON.stringify(action)) as HitchNextAction;
    expect(json.decisionPacket).toBeUndefined();
    expect(json.findingIds).toEqual(["f1", "f2"]);
  });

  it("a DeliberationInput carries finding metadata, proposals and an optional refuter verdict", () => {
    const evidence: VerifiedJuryEvidence[] = [
      {
        citation: "src/a.ts:1",
        kind: "file",
        claim: "c",
        verified: true,
      },
    ];
    const input: DeliberationInput = {
      findingId: "f1",
      deliberationId: "d1",
      finding: { filePath: "src/a.ts", category: "core" },
      proposals: JURY_LENSES.map((lens) => ({
        findingId: "f1",
        lens,
        proposedScope: "in_scope" as const,
        proposalStatus: "complete" as const,
        evidence,
        round: 2 as const,
      })),
      refuterVerdict: { refuteVerdict: "uphold", reasoning: "x" },
    };
    expect(input.proposals).toHaveLength(3);
    expect(input.finding.filePath).toBe("src/a.ts");
    expect(input.refuterVerdict?.refuteVerdict).toBe("uphold");
  });
});
