import type {
  ReviewProposalRepository,
  ReviewProposalRow,
} from "../db/repositories/review-proposals.js";
import type { ReviewerRepository } from "../db/repositories/reviewers.js";
import type { EnrichedProposal } from "./review-consensus.js";

/**
 * Phase 2 (consensus production wiring): turn the active `review_proposals`
 * rows for a run into `EnrichedProposal[]` for `evaluateConsensus`.
 *
 * "Active" = not superseded and not yet processed (the latest open verdict
 * per reviewer; insertProposal supersedes a reviewer's prior row). Each
 * proposal is enriched with its reviewer's group / type from the `reviewers`
 * registry so per-group requirements and quorum can be evaluated. An
 * unregistered reviewer falls back to type "unknown" / group null (it then
 * fails the per-group checks, which is the safe direction).
 */
export function activeProposalRows(
  proposalRepo: ReviewProposalRepository,
  runId: string,
  opts: { reviewerIds?: readonly string[] } = {},
): ReviewProposalRow[] {
  const reviewerIds =
    opts.reviewerIds === undefined ? null : new Set(opts.reviewerIds);
  return proposalRepo
    .listForRun(runId)
    .filter(
      (p) =>
        p.supersededAt === null &&
        p.processedAt === null &&
        (reviewerIds === null || reviewerIds.has(p.reviewer)),
    )
    .sort(compareConsensusProposalRows);
}

export function enrichRows(
  rows: ReviewProposalRow[],
  reviewerRepo: ReviewerRepository,
): EnrichedProposal[] {
  return [...rows].sort(compareConsensusProposalRows).map((p) => {
    const reviewer = reviewerRepo.findById(p.reviewer);
    return {
      proposalId: p.proposalId,
      reviewerId: p.reviewer,
      reviewerType: reviewer?.reviewerType ?? "unknown",
      groupId: reviewer?.groupId ?? null,
      decision: p.decision,
      requiredChanges: p.requiredChanges,
      reviewedAt: p.reviewedAt,
      supersededAt: p.supersededAt,
    };
  });
}

function compareConsensusProposalRows(
  a: ReviewProposalRow,
  b: ReviewProposalRow,
): number {
  return (
    compareStrings(a.reviewer, b.reviewer) ||
    a.proposalId - b.proposalId
  );
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function enrichActiveProposals(
  proposalRepo: ReviewProposalRepository,
  reviewerRepo: ReviewerRepository,
  runId: string,
  opts: { reviewerIds?: readonly string[] } = {},
): EnrichedProposal[] {
  return enrichRows(activeProposalRows(proposalRepo, runId, opts), reviewerRepo);
}
