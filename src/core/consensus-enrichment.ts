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
): ReviewProposalRow[] {
  return proposalRepo
    .listForRun(runId)
    .filter((p) => p.supersededAt === null && p.processedAt === null);
}

export function enrichRows(
  rows: ReviewProposalRow[],
  reviewerRepo: ReviewerRepository,
): EnrichedProposal[] {
  return rows.map((p) => {
    const reviewer = reviewerRepo.findById(p.reviewer);
    return {
      proposalId: p.proposalId,
      reviewerId: p.reviewer,
      reviewerType: reviewer?.reviewerType ?? "unknown",
      groupId: reviewer?.groupId ?? null,
      decision: p.decision,
      reviewedAt: p.reviewedAt,
      supersededAt: p.supersededAt,
    };
  });
}

export function enrichActiveProposals(
  proposalRepo: ReviewProposalRepository,
  reviewerRepo: ReviewerRepository,
  runId: string,
): EnrichedProposal[] {
  return enrichRows(activeProposalRows(proposalRepo, runId), reviewerRepo);
}
