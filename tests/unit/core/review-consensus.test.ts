import { describe, it, expect } from "vitest";
import {
  evaluateConsensus,
  type EnrichedProposal,
} from "../../../src/core/review-consensus.js";
import {
  DEFAULT_REVIEW_RULE,
  ruleSha256,
  type ReviewRule,
} from "../../../src/core/review-rule.js";
import { targetChangeHash } from "../../../src/core/refute-binding.js";

const NOW = "2026-05-24T10:00:00Z";

function proposal(
  input: Partial<EnrichedProposal> & {
    proposalId: number;
    decision: EnrichedProposal["decision"];
  },
): EnrichedProposal {
  return {
    reviewerId: input.reviewerId ?? "codex",
    reviewerType: input.reviewerType ?? "codex",
    groupId: input.groupId ?? "codex",
    reviewedAt: input.reviewedAt ?? NOW,
    ...input,
  };
}

const CONSENSUS_RULE: ReviewRule = {
  mode: "consensus",
  requirements: [
    {
      group: "humans",
      minApprovals: 1,
      blockingDecisions: ["changes_requested", "rejected"],
    },
    {
      group: "codex",
      minApprovals: 1,
      blockingDecisions: ["rejected"],
    },
  ],
  overrides: { allowedReviewers: ["lead"], requireReason: true },
  staleProposal: { rejectSuperseded: true },
};

describe("evaluateConsensus (Phase 11-4)", () => {
  it("latest-proposal mode + no proposals → pending", () => {
    const r = evaluateConsensus({
      rule: DEFAULT_REVIEW_RULE,
      ruleSha256: ruleSha256(DEFAULT_REVIEW_RULE),
      proposals: [],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.decisionPath).toBe("no-requirements-latest-proposal");
  });

  it("latest-proposal mode + single approved proposal → approved", () => {
    const r = evaluateConsensus({
      rule: DEFAULT_REVIEW_RULE,
      ruleSha256: ruleSha256(DEFAULT_REVIEW_RULE),
      proposals: [proposal({ proposalId: 1, decision: "approved" })],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("approved");
  });

  it("omits refute from frozen summary JSON when the rule has no refute requirement", () => {
    const ruleSha = ruleSha256(DEFAULT_REVIEW_RULE);
    const r = evaluateConsensus({
      rule: DEFAULT_REVIEW_RULE,
      ruleSha256: ruleSha,
      proposals: [proposal({ proposalId: 1, decision: "approved" })],
      evaluatedAt: NOW,
    });

    expect(Object.hasOwn(r.summary, "refute")).toBe(false);
    expect(JSON.stringify(r.summary)).toBe(
      JSON.stringify({
        evaluatedAt: NOW,
        ruleSha256: ruleSha,
        semantics: {
          approvalKind: "static_review",
          approvedMeaning:
            "approved means static review passed; review_consensus does not execute tests",
          testsExecutedByConsensus: false,
        },
        proposals: [
          {
            proposalId: 1,
            reviewerId: "codex",
            groupId: "codex",
            decision: "approved",
          },
        ],
        override: null,
        excludedProposals: [],
        requirements: [],
        decisionPath: "no-requirements-latest-proposal",
      }),
    );
  });

  it("latest-proposal mode picks the latest by reviewedAt", () => {
    const r = evaluateConsensus({
      rule: DEFAULT_REVIEW_RULE,
      ruleSha256: ruleSha256(DEFAULT_REVIEW_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "approved",
          reviewedAt: "2026-05-24T09:00:00Z",
        }),
        proposal({
          proposalId: 2,
          decision: "changes_requested",
          reviewedAt: "2026-05-24T10:00:00Z",
        }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("changes_requested");
  });

  it("consensus mode + missing required group approvals → pending", () => {
    const r = evaluateConsensus({
      rule: CONSENSUS_RULE,
      ruleSha256: ruleSha256(CONSENSUS_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "approved",
          reviewerId: "codex",
          groupId: "codex",
        }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.decisionPath).toBe("requirements-pending");
    const humansCheck = r.summary.requirements.find((x) => x.group === "humans");
    expect(humansCheck?.approvals).toBe(0);
    expect(humansCheck?.required).toBe(1);
  });

  it("consensus mode + all requirements satisfied → approved", () => {
    const r = evaluateConsensus({
      rule: CONSENSUS_RULE,
      ruleSha256: ruleSha256(CONSENSUS_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "approved",
          reviewerId: "alice",
          reviewerType: "human",
          groupId: "humans",
        }),
        proposal({
          proposalId: 2,
          decision: "approved",
          reviewerId: "codex",
          groupId: "codex",
        }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("approved");
    expect(r.summary.decisionPath).toBe("requirements-met");
    expect(r.summary.semantics).toEqual({
      approvalKind: "static_review",
      approvedMeaning:
        "approved means static review passed; review_consensus does not execute tests",
      testsExecutedByConsensus: false,
    });
  });

  it("blocking changes_requested from required group → changes_requested", () => {
    const r = evaluateConsensus({
      rule: CONSENSUS_RULE,
      ruleSha256: ruleSha256(CONSENSUS_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "changes_requested",
          reviewerId: "alice",
          reviewerType: "human",
          groupId: "humans",
        }),
        proposal({
          proposalId: 2,
          decision: "approved",
          reviewerId: "codex",
          groupId: "codex",
        }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("changes_requested");
    expect(r.summary.decisionPath).toBe("blocking");
  });

  it("blocking rejected outranks changes_requested (tie-break)", () => {
    const r = evaluateConsensus({
      rule: CONSENSUS_RULE,
      ruleSha256: ruleSha256(CONSENSUS_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "changes_requested",
          reviewerId: "alice",
          reviewerType: "human",
          groupId: "humans",
        }),
        proposal({
          proposalId: 2,
          decision: "rejected",
          reviewerId: "codex",
          groupId: "codex",
        }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("rejected");
  });

  it("human override is the strongest signal", () => {
    const r = evaluateConsensus({
      rule: CONSENSUS_RULE,
      ruleSha256: ruleSha256(CONSENSUS_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "rejected",
          reviewerId: "alice",
          reviewerType: "human",
          groupId: "humans",
        }),
      ],
      override: {
        decision: "approved",
        actorReviewerId: "lead",
        reason: "Critical hotfix",
        createdAt: NOW,
      },
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("approved");
    expect(r.summary.decisionPath).toBe("override");
    expect(r.summary.override?.reason).toBe("Critical hotfix");
  });

  it("ignores proposals with reviewer_id IS NULL (legacy rows) in consensus group check", () => {
    const r = evaluateConsensus({
      rule: CONSENSUS_RULE,
      ruleSha256: ruleSha256(CONSENSUS_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "approved",
          reviewerId: null,
          groupId: "humans",
        }),
        proposal({
          proposalId: 2,
          decision: "approved",
          reviewerId: "codex",
          groupId: "codex",
        }),
      ],
      evaluatedAt: NOW,
    });
    // legacy null-reviewer row is excluded → humans group has 0 approvals
    expect(r.status).toBe("pending");
  });
});

// Phase 2-1: quorum / participation.
const QUORUM_RULE: ReviewRule = {
  mode: "consensus",
  requirements: [
    {
      group: "humans",
      minApprovals: 1,
      // blockingDecisions empty so non-approve verdicts count as
      // participation without blocking — isolates the quorum check.
      blockingDecisions: [],
      quorum: { minParticipants: 2 },
    },
  ],
  overrides: { allowedReviewers: ["lead"], requireReason: true },
  staleProposal: { rejectSuperseded: true },
};

describe("evaluateConsensus quorum (Phase 2-1)", () => {
  it("approvals met but participants below quorum → pending", () => {
    const r = evaluateConsensus({
      rule: QUORUM_RULE,
      ruleSha256: ruleSha256(QUORUM_RULE),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.decisionPath).toBe("requirements-pending");
    const check = r.summary.requirements.find((x) => x.group === "humans");
    expect(check?.participants).toBe(1);
    expect(check?.quorumMet).toBe(false);
  });

  it("quorum met (2 distinct participants) and approvals met → approved", () => {
    const r = evaluateConsensus({
      rule: QUORUM_RULE,
      ruleSha256: ruleSha256(QUORUM_RULE),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "changes_requested", reviewerId: "bob", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("approved");
    const check = r.summary.requirements.find((x) => x.group === "humans");
    expect(check?.participants).toBe(2);
    expect(check?.quorumMet).toBe(true);
  });

  it("counts distinct reviewers — two verdicts from one reviewer = 1 participant", () => {
    const r = evaluateConsensus({
      rule: QUORUM_RULE,
      ruleSha256: ruleSha256(QUORUM_RULE),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "approved", reviewerId: "alice", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.requirements.find((x) => x.group === "humans")?.participants).toBe(1);
  });

  it("pending verdicts do not count as participation", () => {
    const r = evaluateConsensus({
      rule: QUORUM_RULE,
      ruleSha256: ruleSha256(QUORUM_RULE),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "pending", reviewerId: "bob", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.summary.requirements.find((x) => x.group === "humans")?.participants).toBe(1);
    expect(r.status).toBe("pending");
  });

  it("participation rate quorum: participants/groupSize >= rate → met", () => {
    const rule: ReviewRule = {
      ...QUORUM_RULE,
      requirements: [
        {
          group: "humans",
          minApprovals: 1,
          blockingDecisions: [],
          quorum: { minParticipationRate: 0.5, groupSize: 4 },
        },
      ],
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "changes_requested", reviewerId: "bob", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("approved");
    expect(r.summary.requirements.find((x) => x.group === "humans")?.quorumMet).toBe(true);
  });

  it("participation rate below threshold → pending", () => {
    const rule: ReviewRule = {
      ...QUORUM_RULE,
      requirements: [
        {
          group: "humans",
          minApprovals: 1,
          blockingDecisions: [],
          quorum: { minParticipationRate: 0.75, groupSize: 4 },
        },
      ],
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "changes_requested", reviewerId: "bob", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
  });

  it("participation rate set but groupSize missing → fail-closed (quorum not met)", () => {
    const rule: ReviewRule = {
      ...QUORUM_RULE,
      requirements: [
        {
          group: "humans",
          minApprovals: 1,
          blockingDecisions: [],
          quorum: { minParticipationRate: 0.5 },
        },
      ],
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "approved", reviewerId: "bob", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.requirements.find((x) => x.group === "humans")?.quorumMet).toBe(false);
  });

  it("participation rate with groupSize 0 → fail-closed (quorum not met)", () => {
    const rule: ReviewRule = {
      ...QUORUM_RULE,
      requirements: [
        {
          group: "humans",
          minApprovals: 1,
          blockingDecisions: [],
          quorum: { minParticipationRate: 0.5, groupSize: 0 },
        },
      ],
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "approved", reviewerId: "bob", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.requirements.find((x) => x.group === "humans")?.quorumMet).toBe(false);
  });

  it.each([
    ["minParticipants NaN", { minParticipants: Number.NaN }],
    ["minParticipants negative", { minParticipants: -1 }],
    ["rate above 1", { minParticipationRate: 1.5, groupSize: 4 }],
    ["rate NaN", { minParticipationRate: Number.NaN, groupSize: 4 }],
  ])("fail-closed on misconfigured quorum: %s", (_label, quorum) => {
    const rule: ReviewRule = {
      ...QUORUM_RULE,
      requirements: [
        { group: "humans", minApprovals: 1, blockingDecisions: [], quorum },
      ],
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "approved", reviewerId: "bob", groupId: "humans" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.requirements.find((x) => x.group === "humans")?.quorumMet).toBe(false);
  });

  it("no quorum declared → quorumMet true (backward compatible)", () => {
    const r = evaluateConsensus({
      rule: CONSENSUS_RULE,
      ruleSha256: ruleSha256(CONSENSUS_RULE),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewerId: "alice", reviewerType: "human", groupId: "humans" }),
        proposal({ proposalId: 2, decision: "approved", reviewerId: "codex", groupId: "codex" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("approved");
    for (const check of r.summary.requirements) {
      expect(check.quorumMet).toBe(true);
    }
  });
});

// Phase 2-2: proposal staleness (superseded / age).
describe("evaluateConsensus staleness (Phase 2-2)", () => {
  it("rejectSuperseded excludes a superseded proposal from latest-proposal mode", () => {
    const rule: ReviewRule = { ...DEFAULT_REVIEW_RULE, staleProposal: { rejectSuperseded: true } };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewedAt: "2026-05-24T09:00:00Z" }),
        proposal({
          proposalId: 2,
          decision: "changes_requested",
          reviewedAt: "2026-05-24T10:00:00Z",
          supersededAt: "2026-05-24T10:30:00Z",
        }),
      ],
      evaluatedAt: NOW,
    });
    // superseded proposal 2 is excluded → latest active is proposal 1 (approved).
    expect(r.status).toBe("approved");
    expect(r.summary.excludedProposals).toEqual([
      { proposalId: 2, reason: "superseded" },
    ]);
  });

  it("rejectSuperseded=false keeps superseded proposals", () => {
    const rule: ReviewRule = { ...DEFAULT_REVIEW_RULE, staleProposal: { rejectSuperseded: false } };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewedAt: "2026-05-24T09:00:00Z" }),
        proposal({
          proposalId: 2,
          decision: "changes_requested",
          reviewedAt: "2026-05-24T10:00:00Z",
          supersededAt: "2026-05-24T10:30:00Z",
        }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("changes_requested");
    expect(r.summary.excludedProposals).toEqual([]);
  });

  it("maxAgeHours excludes proposals older than the threshold", () => {
    const rule: ReviewRule = {
      ...DEFAULT_REVIEW_RULE,
      staleProposal: { rejectSuperseded: true, maxAgeHours: 24 },
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        // 25h before evaluatedAt → stale.
        proposal({ proposalId: 1, decision: "approved", reviewedAt: "2026-05-23T09:00:00Z" }),
      ],
      evaluatedAt: NOW, // 2026-05-24T10:00:00Z
    });
    expect(r.status).toBe("pending");
    expect(r.summary.excludedProposals).toEqual([
      { proposalId: 1, reason: "stale_age" },
    ]);
  });

  it("maxAgeHours keeps a fresh proposal", () => {
    const rule: ReviewRule = {
      ...DEFAULT_REVIEW_RULE,
      staleProposal: { rejectSuperseded: true, maxAgeHours: 24 },
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewedAt: "2026-05-24T09:00:00Z" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("approved");
    expect(r.summary.excludedProposals).toEqual([]);
  });

  it("fail-closed: maxAgeHours with an unparseable reviewedAt excludes the proposal", () => {
    const rule: ReviewRule = {
      ...DEFAULT_REVIEW_RULE,
      staleProposal: { rejectSuperseded: true, maxAgeHours: 24 },
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewedAt: "not-a-date" }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.excludedProposals).toEqual([
      { proposalId: 1, reason: "stale_age" },
    ]);
  });

  it("superseded takes precedence over stale_age and is reported once", () => {
    const rule: ReviewRule = {
      ...DEFAULT_REVIEW_RULE,
      staleProposal: { rejectSuperseded: true, maxAgeHours: 24 },
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "approved",
          // both superseded AND older than 24h
          reviewedAt: "2026-05-23T09:00:00Z",
          supersededAt: "2026-05-24T08:00:00Z",
        }),
      ],
      evaluatedAt: NOW,
    });
    expect(r.summary.excludedProposals).toEqual([
      { proposalId: 1, reason: "superseded" },
    ]);
  });

  it("fail-closed: a NaN maxAgeHours excludes the proposal", () => {
    const rule: ReviewRule = {
      ...DEFAULT_REVIEW_RULE,
      staleProposal: { rejectSuperseded: true, maxAgeHours: Number.NaN },
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [proposal({ proposalId: 1, decision: "approved" })],
      evaluatedAt: NOW,
    });
    expect(r.status).toBe("pending");
    expect(r.summary.excludedProposals).toEqual([{ proposalId: 1, reason: "stale_age" }]);
  });

  it("does not exclude on negative elapsed (reviewedAt after evaluatedAt)", () => {
    const rule: ReviewRule = {
      ...DEFAULT_REVIEW_RULE,
      staleProposal: { rejectSuperseded: true, maxAgeHours: 24 },
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({ proposalId: 1, decision: "approved", reviewedAt: "2026-05-24T12:00:00Z" }),
      ],
      evaluatedAt: NOW, // earlier than reviewedAt
    });
    expect(r.status).toBe("approved");
    expect(r.summary.excludedProposals).toEqual([]);
  });
});

const REFUTE_RULE: ReviewRule = {
  mode: "consensus",
  refute: {
    group: "refuters",
    reviewerIds: ["refute-a", "refute-b", "refute-c"],
    minParticipants: 2,
  },
  requirements: [
    {
      group: "humans",
      minApprovals: 1,
      blockingDecisions: ["changes_requested", "rejected"],
    },
  ],
  overrides: { allowedReviewers: [], requireReason: true },
  staleProposal: { rejectSuperseded: true },
};

describe("evaluateConsensus refute requirement (Phase 2 P2-C)", () => {
  it("strict-majority refutes neutralize a target-bound changes_requested blocker", () => {
    const target = "Add input validation";
    const r = evaluateConsensus({
      rule: REFUTE_RULE,
      ruleSha256: ruleSha256(REFUTE_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "changes_requested",
          reviewerId: "alice",
          groupId: "humans",
          requiredChanges: [target],
        }),
        proposal({
          proposalId: 2,
          decision: "approved",
          reviewerId: "bob",
          groupId: "humans",
        }),
      ],
      refuteVotes: [
        {
          refuteId: 1,
          reviewerId: "refute-a",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "passed",
        },
        {
          refuteId: 2,
          reviewerId: "refute-b",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "passed",
        },
      ],
      evaluatedAt: NOW,
    });

    expect(r.status).toBe("approved");
    expect(r.summary.decisionPath).toBe("requirements-met");
    expect(r.summary.refute?.refutedTargetChangeHashes).toEqual([
      targetChangeHash(target),
    ]);
    expect(r.summary.refute?.checks[0]).toMatchObject({
      targetChangeHash: targetChangeHash(target),
      refutes: 2,
      expectedReviewers: 3,
      strictMajorityMet: true,
    });
  });

  it("two refutes out of four expected reviewers is not a strict majority", () => {
    const target = "Add input validation";
    const rule: ReviewRule = {
      ...REFUTE_RULE,
      refute: {
        group: "refuters",
        reviewerIds: ["refute-a", "refute-b", "refute-c", "refute-d"],
      },
    };
    const r = evaluateConsensus({
      rule,
      ruleSha256: ruleSha256(rule),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "changes_requested",
          reviewerId: "alice",
          groupId: "humans",
          requiredChanges: [target],
        }),
        proposal({
          proposalId: 2,
          decision: "approved",
          reviewerId: "bob",
          groupId: "humans",
        }),
      ],
      refuteVotes: [
        {
          refuteId: 1,
          reviewerId: "refute-a",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "passed",
        },
        {
          refuteId: 2,
          reviewerId: "refute-b",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "passed",
        },
      ],
      evaluatedAt: NOW,
    });

    expect(r.status).toBe("changes_requested");
    expect(r.summary.refute?.checks[0]).toMatchObject({
      refutes: 2,
      expectedReviewers: 4,
      strictMajorityMet: false,
    });
  });

  it("fails closed: rejected and inconclusive refute rows do not count toward majority", () => {
    const target = "Add input validation";
    const r = evaluateConsensus({
      rule: REFUTE_RULE,
      ruleSha256: ruleSha256(REFUTE_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "changes_requested",
          reviewerId: "alice",
          groupId: "humans",
          requiredChanges: [target],
        }),
        proposal({
          proposalId: 2,
          decision: "approved",
          reviewerId: "bob",
          groupId: "humans",
        }),
      ],
      refuteVotes: [
        {
          refuteId: 1,
          reviewerId: "refute-a",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "rejected",
        },
        {
          refuteId: 2,
          reviewerId: "refute-b",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "inconclusive",
          validationStatus: "passed",
        },
        {
          refuteId: 3,
          reviewerId: "refute-c",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "passed",
        },
      ],
      evaluatedAt: NOW,
    });

    expect(r.status).toBe("changes_requested");
    expect(r.summary.refute?.checks[0]).toMatchObject({
      participants: 1,
      refutes: 1,
      strictMajorityMet: false,
    });
  });

  it("fails closed: duplicate refute rows from one reviewer invalidate that target", () => {
    const target = "Add input validation";
    const r = evaluateConsensus({
      rule: REFUTE_RULE,
      ruleSha256: ruleSha256(REFUTE_RULE),
      proposals: [
        proposal({
          proposalId: 1,
          decision: "changes_requested",
          reviewerId: "alice",
          groupId: "humans",
          requiredChanges: [target],
        }),
        proposal({
          proposalId: 2,
          decision: "approved",
          reviewerId: "bob",
          groupId: "humans",
        }),
      ],
      refuteVotes: [
        {
          refuteId: 1,
          reviewerId: "refute-a",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "passed",
        },
        {
          refuteId: 2,
          reviewerId: "refute-a",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "passed",
        },
        {
          refuteId: 3,
          reviewerId: "refute-b",
          groupId: "refuters",
          targetChangeHash: targetChangeHash(target),
          refuteVerdict: "refute",
          validationStatus: "passed",
        },
      ],
      evaluatedAt: NOW,
    });

    expect(r.status).toBe("changes_requested");
    expect(r.summary.refute?.checks[0]).toMatchObject({
      duplicateReviewers: ["refute-a"],
      participants: 0,
      refutes: 0,
      strictMajorityMet: false,
    });
  });
});
