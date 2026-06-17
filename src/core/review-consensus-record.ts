import type Database from "better-sqlite3";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import { ReviewRulesRepository } from "../db/repositories/review-rules.js";
import { ReviewerRepository } from "../db/repositories/reviewers.js";
import { activeProposalRows, enrichRows } from "./consensus-enrichment.js";
import { evaluateConsensus } from "./review-consensus.js";
import {
  DEFAULT_REVIEW_RULE,
  ruleSha256,
  type ReviewRule,
} from "./review-rule.js";

type ConsensusReEvaluationResult = {
  status: string;
  sourceProposalIds: number[];
};

/**
 * Re-evaluate and persist the current consensus for a needs_review run.
 *
 * This is used after reviewer proposal insertion and by the hitch pending path.
 * The status guard, rule snapshot read, frozen-set filtering, evaluation, and
 * active consensus insert stay in one immediate transaction so a concurrent
 * review process cannot promote the run and then be superseded by a stale
 * pending/participant snapshot.
 */
export function recordConsensusReEvaluation(
  db: Database.Database,
  input: {
    runId: string;
    evaluatedAt: string;
    evaluatedBy: string;
  },
): ConsensusReEvaluationResult | null {
  const tx = db.transaction((): ConsensusReEvaluationResult | null => {
    const statusRow = db
      .prepare("SELECT status FROM runs WHERE run_id = ?")
      .get(input.runId) as { status: string } | undefined;
    if (statusRow === undefined || statusRow.status !== "needs_review") {
      return null;
    }
    const snapshot = new ReviewRulesRepository(db).findSnapshotByRun(
      input.runId,
    );
    const rule: ReviewRule =
      snapshot === null
        ? DEFAULT_REVIEW_RULE
        : (JSON.parse(snapshot.ruleJson) as ReviewRule);
    if (rule.mode !== "consensus") return null;
    const ruleSha = snapshot?.sourceSha256 ?? ruleSha256(rule);
    const rows = activeProposalRows(
      new ReviewProposalRepository(db),
      input.runId,
      { reviewerIds: frozenReviewerIdSet(rule) },
    );
    const result = evaluateConsensus({
      rule,
      ruleSha256: ruleSha,
      proposals: enrichRows(rows, new ReviewerRepository(db)),
      evaluatedAt: input.evaluatedAt,
    });
    const sourceProposalIds = result.summary.proposals.map((p) => p.proposalId);
    new ReviewConsensusRepository(db).insertActive({
      runId: input.runId,
      ruleSha256: ruleSha,
      status: result.status,
      summary: result.summary,
      evaluatedAt: input.evaluatedAt,
      evaluatedBy: input.evaluatedBy,
      sourceProposalIds,
    });
    return { status: result.status, sourceProposalIds };
  });
  return tx.immediate();
}

export function frozenReviewerIdSet(
  rule: ReviewRule,
): ReadonlySet<string> | null {
  const ids = rule.requirements.flatMap((req) => req.reviewerIds ?? []);
  return ids.length === 0 ? null : new Set(ids);
}
