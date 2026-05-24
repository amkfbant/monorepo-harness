import type { ReviewRule } from "./review-rule.js";

/**
 * Consensus evaluator (Phase 11-4).
 *
 * Pure function: given a rule snapshot, the set of currently-relevant
 * proposals, and an optional human override, returns the consensus
 * status + a JSON-serialisable summary that is persisted to
 * `review_consensus`. Persistence and re-evaluation triggers are the
 * caller's responsibility (`ReviewConsensusRepository`).
 *
 * Design §C2 — tie-break order:
 *   rejected > changes_requested > approved > pending
 *
 * Override is the strongest signal (design §C1): when present, the
 * override decision is the consensus, regardless of requirements.
 */

export type ConsensusStatus =
  | "pending"
  | "approved"
  | "changes_requested"
  | "rejected";

export interface EnrichedProposal {
  proposalId: number;
  reviewerId: string | null;
  reviewerType: string;
  groupId: string | null;
  decision: ConsensusStatus | "pending";
  reviewedAt: string;
}

export interface ConsensusOverride {
  decision: "approved" | "changes_requested" | "rejected";
  actorReviewerId: string;
  reason: string;
  createdAt: string;
}

export interface ConsensusRequirementCheck {
  group: string;
  required: number;
  approvals: number;
  blocked: boolean;
  blockingDecision?: ConsensusStatus;
}

export interface ConsensusSummary {
  evaluatedAt: string;
  ruleSha256: string;
  proposals: Array<{
    proposalId: number;
    reviewerId: string | null;
    groupId: string | null;
    decision: ConsensusStatus | "pending";
  }>;
  override: ConsensusOverride | null;
  requirements: ConsensusRequirementCheck[];
  decisionPath:
    | "override"
    | "blocking"
    | "requirements-met"
    | "requirements-pending"
    | "no-requirements-latest-proposal";
}

export interface ConsensusResult {
  status: ConsensusStatus;
  summary: ConsensusSummary;
}

export function evaluateConsensus(input: {
  rule: ReviewRule;
  ruleSha256: string;
  proposals: EnrichedProposal[];
  override?: ConsensusOverride | null;
  evaluatedAt: string;
}): ConsensusResult {
  const evaluatedAt = input.evaluatedAt;
  const ruleSha = input.ruleSha256;
  const override = input.override ?? null;
  const baseSummary = {
    evaluatedAt,
    ruleSha256: ruleSha,
    proposals: input.proposals.map((p) => ({
      proposalId: p.proposalId,
      reviewerId: p.reviewerId,
      groupId: p.groupId,
      decision: p.decision,
    })),
    override,
  };

  // 1. override is strongest.
  if (override !== null) {
    return {
      status: override.decision,
      summary: {
        ...baseSummary,
        requirements: [],
        decisionPath: "override",
      },
    };
  }

  // 2. legacy / latest-proposal mode: no requirements declared. Return
  // the most recent decision (pre-Phase-11 behaviour). pending stays
  // pending.
  if (
    input.rule.mode === "latest-proposal" ||
    input.rule.requirements.length === 0
  ) {
    const latest = pickLatest(input.proposals);
    if (latest === null) {
      return {
        status: "pending",
        summary: {
          ...baseSummary,
          requirements: [],
          decisionPath: "no-requirements-latest-proposal",
        },
      };
    }
    const status: ConsensusStatus =
      latest.decision === "pending" ? "pending" : latest.decision;
    return {
      status,
      summary: {
        ...baseSummary,
        requirements: [],
        decisionPath: "no-requirements-latest-proposal",
      },
    };
  }

  // 3. consensus mode: check blocking decisions first, then approval
  // counts. tie-break order: rejected > changes_requested > approved >
  // pending.
  let blockingStatus: ConsensusStatus | null = null;
  const reqChecks: ConsensusRequirementCheck[] = [];
  for (const req of input.rule.requirements) {
    const inGroup = input.proposals.filter(
      (p) => p.groupId === req.group && p.reviewerId !== null,
    );
    const blockedByReject = inGroup.some(
      (p) => p.decision === "rejected" && req.blockingDecisions.includes("rejected"),
    );
    const blockedByChanges = inGroup.some(
      (p) =>
        p.decision === "changes_requested" &&
        req.blockingDecisions.includes("changes_requested"),
    );
    const approvals = inGroup.filter((p) => p.decision === "approved").length;
    if (blockedByReject) {
      blockingStatus = "rejected";
    } else if (
      blockedByChanges &&
      (blockingStatus === null || blockingStatus === "changes_requested")
    ) {
      blockingStatus = "changes_requested";
    }
    reqChecks.push({
      group: req.group,
      required: req.minApprovals,
      approvals,
      blocked: blockedByReject || blockedByChanges,
      ...(blockedByReject
        ? { blockingDecision: "rejected" as ConsensusStatus }
        : blockedByChanges
          ? { blockingDecision: "changes_requested" as ConsensusStatus }
          : {}),
    });
  }

  if (blockingStatus !== null) {
    return {
      status: blockingStatus,
      summary: {
        ...baseSummary,
        requirements: reqChecks,
        decisionPath: "blocking",
      },
    };
  }

  const allSatisfied = reqChecks.every((r) => r.approvals >= r.required);
  if (!allSatisfied) {
    return {
      status: "pending",
      summary: {
        ...baseSummary,
        requirements: reqChecks,
        decisionPath: "requirements-pending",
      },
    };
  }
  return {
    status: "approved",
    summary: {
      ...baseSummary,
      requirements: reqChecks,
      decisionPath: "requirements-met",
    },
  };
}

function pickLatest(proposals: EnrichedProposal[]): EnrichedProposal | null {
  if (proposals.length === 0) return null;
  let best = proposals[0]!;
  for (const p of proposals) {
    if (p.reviewedAt > best.reviewedAt) best = p;
  }
  return best;
}
