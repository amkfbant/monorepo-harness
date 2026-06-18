import { targetChangeHash } from "./refute-binding.js";
import type { ReviewRule, ReviewRuleQuorum, ReviewRuleStaleProposal } from "./review-rule.js";

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

export const REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS = {
  approvalKind: "static_review",
  approvedMeaning:
    "approved means static review passed; review_consensus does not execute tests",
  testsExecutedByConsensus: false,
} as const;

export interface EnrichedProposal {
  proposalId: number;
  reviewerId: string | null;
  reviewerType: string;
  groupId: string | null;
  decision: ConsensusStatus | "pending";
  /** Required changes emitted by a changes_requested/rejected proposal. */
  requiredChanges?: string[];
  reviewedAt: string;
  /**
   * Phase 2-2: non-null when this proposal was superseded by a later
   * proposal. Used by the staleness filter (`staleProposal.rejectSuperseded`).
   * `undefined`/`null` = active.
   */
  supersededAt?: string | null;
}

export interface EnrichedRefuteVote {
  refuteId: number;
  reviewerId: string;
  groupId: string | null;
  targetChangeHash: string;
  refuteVerdict: "uphold" | "refute" | "inconclusive" | null;
  validationStatus: "passed" | "rejected";
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
  /** Phase 2-1: distinct reviewers in the group with a non-pending verdict. */
  participants: number;
  /** Phase 2-1: whether the group's quorum is satisfied (true if no quorum declared). */
  quorumMet: boolean;
}

/** Phase 2-2: a proposal dropped from aggregation, with the reason. */
export interface ExcludedProposal {
  proposalId: number;
  reason: "superseded" | "stale_age";
}

export interface ConsensusSummary {
  evaluatedAt: string;
  ruleSha256: string;
  semantics: typeof REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS;
  proposals: Array<{
    proposalId: number;
    reviewerId: string | null;
    groupId: string | null;
    decision: ConsensusStatus | "pending";
  }>;
  override: ConsensusOverride | null;
  requirements: ConsensusRequirementCheck[];
  refute: ConsensusRefuteSummary | null;
  /** Phase 2-2: proposals dropped by the staleness filter (audit trail). */
  excludedProposals: ExcludedProposal[];
  decisionPath:
    | "override"
    | "blocking"
    | "requirements-met"
    | "requirements-pending"
    | "no-requirements-latest-proposal";
}

export interface ConsensusRefuteSummary {
  group: string;
  reviewerIds: string[];
  refutedTargetChangeHashes: string[];
  checks: ConsensusRefuteTargetCheck[];
}

export interface ConsensusRefuteTargetCheck {
  targetChangeHash: string;
  expectedReviewers: number;
  participants: number;
  refutes: number;
  upholds: number;
  strictMajorityMet: boolean;
  duplicateReviewers: string[];
}

export interface ConsensusResult {
  status: ConsensusStatus;
  summary: ConsensusSummary;
}

export function evaluateConsensus(input: {
  rule: ReviewRule;
  ruleSha256: string;
  proposals: EnrichedProposal[];
  refuteVotes?: EnrichedRefuteVote[];
  override?: ConsensusOverride | null;
  evaluatedAt: string;
}): ConsensusResult {
  const evaluatedAt = input.evaluatedAt;
  const ruleSha = input.ruleSha256;
  const override = input.override ?? null;

  // Phase 2-2: drop stale proposals (superseded / too old) before any
  // aggregation. Deterministic: driven only by the rule's staleProposal
  // config and the proposal's own supersededAt/reviewedAt — never LLM output.
  const { active: proposals, excluded: excludedProposals } = filterStaleProposals(
    input.proposals,
    input.rule.staleProposal,
    evaluatedAt,
  );

  const baseSummary = {
    evaluatedAt,
    ruleSha256: ruleSha,
    semantics: REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS,
    proposals: proposals.map((p) => ({
      proposalId: p.proposalId,
      reviewerId: p.reviewerId,
      groupId: p.groupId,
      decision: p.decision,
    })),
    override,
    refute: evaluateRefuteSummary(input.rule, input.refuteVotes ?? []),
    excludedProposals,
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
    const latest = pickLatest(proposals);
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
  const refutedTargets = new Set(
    baseSummary.refute?.refutedTargetChangeHashes ?? [],
  );
  for (const req of input.rule.requirements) {
    const inGroup = proposals.filter(
      (p) => p.groupId === req.group && p.reviewerId !== null,
    );
    const blockedByReject = inGroup.some(
      (p) => p.decision === "rejected" && req.blockingDecisions.includes("rejected"),
    );
    const blockedByChanges = inGroup.some(
      (p) =>
        p.decision === "changes_requested" &&
        req.blockingDecisions.includes("changes_requested") &&
        !isChangesRequestRefuted(p, refutedTargets),
    );
    const approvals = inGroup.filter((p) => p.decision === "approved").length;
    // Phase 2-1: count distinct reviewers that submitted a non-pending verdict.
    const participants = new Set(
      inGroup
        .filter((p) => p.decision !== "pending")
        .map((p) => p.reviewerId),
    ).size;
    const quorumMet = isQuorumMet(req.quorum, participants);
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
      participants,
      quorumMet,
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

  const allSatisfied = reqChecks.every(
    (r) => r.approvals >= r.required && r.quorumMet,
  );
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

function evaluateRefuteSummary(
  rule: ReviewRule,
  votes: EnrichedRefuteVote[],
): ConsensusRefuteSummary | null {
  const refute = rule.refute;
  if (refute === undefined) return null;
  const reviewerIds = [...refute.reviewerIds].sort(compareStrings);
  const reviewerSet = new Set(reviewerIds);
  const byTarget = new Map<string, EnrichedRefuteVote[]>();
  for (const vote of votes) {
    if (vote.validationStatus !== "passed") continue;
    if (vote.groupId !== refute.group) continue;
    if (!reviewerSet.has(vote.reviewerId)) continue;
    if (vote.refuteVerdict !== "uphold" && vote.refuteVerdict !== "refute") {
      continue;
    }
    const existing = byTarget.get(vote.targetChangeHash) ?? [];
    existing.push(vote);
    byTarget.set(vote.targetChangeHash, existing);
  }

  const minParticipants = refute.minParticipants ?? 1;
  const checks = [...byTarget.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([targetHash, targetVotes]): ConsensusRefuteTargetCheck => {
      const byReviewer = new Map<string, EnrichedRefuteVote[]>();
      for (const vote of targetVotes) {
        const existing = byReviewer.get(vote.reviewerId) ?? [];
        existing.push(vote);
        byReviewer.set(vote.reviewerId, existing);
      }
      const duplicateReviewers = [...byReviewer.entries()]
        .filter(([, reviewerVotes]) => reviewerVotes.length > 1)
        .map(([reviewerId]) => reviewerId)
        .sort(compareStrings);
      const uniqueVotes =
        duplicateReviewers.length === 0
          ? [...byReviewer.values()].map((reviewerVotes) => reviewerVotes[0]!)
          : [];
      const refutes = uniqueVotes.filter(
        (vote) => vote.refuteVerdict === "refute",
      ).length;
      const upholds = uniqueVotes.filter(
        (vote) => vote.refuteVerdict === "uphold",
      ).length;
      const participants = uniqueVotes.length;
      return {
        targetChangeHash: targetHash,
        expectedReviewers: reviewerIds.length,
        participants,
        refutes,
        upholds,
        strictMajorityMet:
          duplicateReviewers.length === 0 &&
          participants >= minParticipants &&
          refutes > reviewerIds.length / 2,
        duplicateReviewers,
      };
    });
  return {
    group: refute.group,
    reviewerIds,
    refutedTargetChangeHashes: checks
      .filter((check) => check.strictMajorityMet)
      .map((check) => check.targetChangeHash),
    checks,
  };
}

function isChangesRequestRefuted(
  proposal: EnrichedProposal,
  refutedTargets: ReadonlySet<string>,
): boolean {
  if (proposal.requiredChanges === undefined || proposal.requiredChanges.length === 0) {
    return false;
  }
  return proposal.requiredChanges.every((change) =>
    refutedTargets.has(targetChangeHash(change)),
  );
}

/**
 * Phase 2-2: split proposals into the active set used for aggregation and
 * the excluded (stale) set. Deterministic — superseded proposals are
 * dropped when `rejectSuperseded` is set; proposals older than
 * `maxAgeHours` (positive elapsed only) are dropped as stale. A proposal
 * matching both reasons is reported once (superseded takes precedence).
 */
function filterStaleProposals(
  proposals: EnrichedProposal[],
  stale: ReviewRuleStaleProposal,
  evaluatedAt: string,
): { active: EnrichedProposal[]; excluded: ExcludedProposal[] } {
  const active: EnrichedProposal[] = [];
  const excluded: ExcludedProposal[] = [];
  const evaluatedMs = Date.parse(evaluatedAt);
  for (const p of proposals) {
    if (stale.rejectSuperseded && p.supersededAt != null) {
      excluded.push({ proposalId: p.proposalId, reason: "superseded" });
      continue;
    }
    if (stale.maxAgeHours !== undefined && isOlderThan(p.reviewedAt, evaluatedMs, stale.maxAgeHours)) {
      excluded.push({ proposalId: p.proposalId, reason: "stale_age" });
      continue;
    }
    active.push(p);
  }
  return { active, excluded };
}

function isOlderThan(
  reviewedAt: string,
  evaluatedMs: number,
  maxAgeHours: number,
): boolean {
  // fail-closed on a misconfigured threshold (NaN / negative). Infinity is a
  // valid "no age limit" and is handled by the comparison below.
  if (Number.isNaN(maxAgeHours) || maxAgeHours < 0) return true;
  const reviewedMs = Date.parse(reviewedAt);
  // fail-closed: maxAgeHours is being enforced but we cannot prove the
  // proposal's freshness (unparseable timestamp) → treat it as stale and
  // exclude it, rather than letting it count toward an approval.
  if (Number.isNaN(reviewedMs) || Number.isNaN(evaluatedMs)) return true;
  const elapsedHours = (evaluatedMs - reviewedMs) / 3_600_000;
  // Only positive elapsed counts; a reviewedAt after evaluatedAt is not stale.
  return elapsedHours > maxAgeHours;
}

/**
 * Phase 2-1: quorum check. `undefined` quorum = satisfied (legacy). A
 * participation-rate quorum without a positive groupSize is fail-closed
 * (not satisfied).
 */
function isQuorumMet(
  quorum: ReviewRuleQuorum | undefined,
  participants: number,
): boolean {
  if (quorum === undefined) return true;
  if (quorum.minParticipants !== undefined) {
    // fail-closed on a misconfigured threshold (NaN / negative).
    if (!Number.isFinite(quorum.minParticipants) || quorum.minParticipants < 0) {
      return false;
    }
    if (participants < quorum.minParticipants) return false;
  }
  if (quorum.minParticipationRate !== undefined) {
    const rate = quorum.minParticipationRate;
    // fail-closed: rate must be in [0,1] and groupSize a positive number.
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) return false;
    if (quorum.groupSize === undefined || !Number.isFinite(quorum.groupSize) || quorum.groupSize <= 0) {
      return false;
    }
    if (participants / quorum.groupSize < rate) return false;
  }
  return true;
}

function pickLatest(proposals: EnrichedProposal[]): EnrichedProposal | null {
  if (proposals.length === 0) return null;
  let best = proposals[0]!;
  for (const p of proposals) {
    if (p.reviewedAt > best.reviewedAt) best = p;
  }
  return best;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
