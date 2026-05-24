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
