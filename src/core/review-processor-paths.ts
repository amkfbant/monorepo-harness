import type Database from "better-sqlite3";
import type { RunStatus } from "../logging/run-log.js";
import { serializeReviewDecision } from "./review-decision-loader.js";
import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import { ReviewRulesRepository } from "../db/repositories/review-rules.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import { ReviewOverridesRepository, OverrideReasonRequiredError, UnauthorizedOverrideError } from "../db/repositories/review-overrides.js";
import { ReviewerRepository } from "../db/repositories/reviewers.js";
import { evaluateConsensus, type ConsensusStatus, type EnrichedProposal } from "./review-consensus.js";
import { targetChangeHash } from "./refute-binding.js";
import { activeProposalRows, enrichRefuteVotesForRun, enrichRows } from "./consensus-enrichment.js";
import { DEFAULT_REVIEW_RULE, frozenReviewerIdsForRule, parseReviewRuleSnapshot, ruleSha256, type ReviewRule } from "./review-rule.js";
import { ReviewRefuteVotesRepository } from "../db/repositories/review-refute-votes.js";
import { runMigrations } from "../db/migrations.js";
import { RunRepository } from "../db/repositories/runs.js";
import { exportRun, warnIfExportFailed } from "../db/export-files.js";
import { SourceModeError } from "../db/errors.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { ReviewGateError, ReviewConsensusNoActiveProposalsError, ReviewConsensusPendingError, type ProcessOpts, type ProcessResult } from "./review-processor-types.js";

/**
 * review-decision 処理の override / consensus パス実装（#125 A15: review-processor.ts
 * から behaviour-zero 抽出）。processReviewDecision/processUnderLock(main) から呼ばれる。
 * 共有 error/result 型は ./review-processor-types から import。
 */
/**
 * Phase 11-5: persist a consensus row for the just-promoted decision.
 * Phase 11 default rule is `latest-proposal`, so consensus mirrors the
 * single processed proposal. The row makes the decision visible to
 * future consensus consumers (dashboard / governance) without changing
 * the existing single-writer review flow.
 */
/**
 * Phase 11-6: human override execution path. Skips the proposal /
 * decision-file lookup, gates on the run's review rule snapshot, and
 * promotes the override decision directly via `applyReviewDecision`.
 */
export function processOverridePath(
  db: Database.Database,
  opts: ProcessOpts,
  override: NonNullable<ProcessOpts["override"]>,
): ProcessResult {
  runMigrations(db);
  assertNoLegacyRuntimeRows(db);
  const dbRow = db
    .prepare("SELECT source_mode, status FROM runs WHERE run_id = ?")
    .get(opts.runId) as { source_mode: string; status: string } | undefined;
  if (dbRow === undefined) {
    throw new ReviewGateError(`run ${opts.runId} not found in the DB`);
  }
  if (dbRow.source_mode !== "db-first") {
    throw new SourceModeError(opts.runId, dbRow.source_mode, "db-first");
  }
  // Rule snapshot gate — Phase 11-6 §D2.
  const snapshot = new ReviewRulesRepository(db).findSnapshotByRun(
    opts.runId,
  );
  const rule: ReviewRule =
    snapshot === null
      ? DEFAULT_REVIEW_RULE
      : parseReviewRuleSnapshot(snapshot.ruleJson);
  const actor = override.actorReviewerId ?? "system";
  if (!rule.overrides.allowedReviewers.includes(actor)) {
    throw new UnauthorizedOverrideError(actor, rule.overrides.allowedReviewers);
  }
  if (rule.overrides.requireReason && override.reason.trim() === "") {
    throw new OverrideReasonRequiredError();
  }
  // resolve actor reviewer (FK to reviewers table; unknown reviewer is
  // rejected by the FK already, but resolveOrThrow gives a friendlier
  // error message).
  new ReviewerRepository(db).resolveOrThrow(actor);

  const reviewedAt = (opts.now ?? new Date()).toISOString();
  // Build a synthetic normalised review-decision yaml so review_decisions
  // and (when export ON) the sidecar reflect the override.
  const decisionYaml = serializeReviewDecision({
    runId: opts.runId,
    domain: "(override)",
    decision: override.decision,
    required_changes: [],
    non_blocking_comments: [],
    out_of_scope_suggestions: [],
    reviewer: actor,
    reviewed_at: reviewedAt,
  });

  // Phase 11 post-close P1: consensus must reflect the override and
  // review_overrides.consensus_id must be linked. Order:
  //   1. consensus insertActive (with override summary so
  //      decisionPath='override')
  //   2. applyReviewDecision (links consensus_id into review_decisions)
  //   3. review_overrides INSERT with consensus_id
  const overridesRepo = new ReviewOverridesRepository(db);
  const consensusRow = recordConsensusForReviewProcess(db, {
    runId: opts.runId,
    decision: override.decision,
    reviewer: actor,
    reviewedAt,
    override: {
      decision: override.decision,
      actorReviewerId: actor,
      reason: override.reason,
      createdAt: reviewedAt,
    },
  });
  new RunRepository(db).applyReviewDecision({
    runId: opts.runId,
    decision: override.decision,
    reviewer: actor,
    reviewedAt,
    requiredChanges: [],
    decisionYaml,
    ...(consensusRow !== null
      ? {
          consensusId: consensusRow.consensusId,
          proposalsSummaryJson: consensusRow.summaryJson,
        }
      : {}),
  });
  const ovr = overridesRepo.insert({
    runId: opts.runId,
    actorReviewerId: actor,
    decision: override.decision,
    reason: override.reason,
    now: opts.now ?? new Date(),
    ...(consensusRow !== null ? { consensusId: consensusRow.consensusId } : {}),
  });
  warnIfExportFailed(exportRun(db, opts.runId, { runsDir: opts.runsDir }));
  return {
    runId: opts.runId,
    previousStatus: dbRow.status as RunStatus,
    newStatus: override.decision as RunStatus,
    reviewer: actor,
    reviewedAt,
    warnings: [`human override (audit override_id=${ovr.overrideId})`],
  };
}

/**
 * Phase 2 (consensus production wiring): `review process` for a run whose
 * effective rule is `mode: consensus`. Instead of promoting a single
 * proposal, it evaluates consensus over ALL active proposals (enriched with
 * reviewer group / type) and:
 *   - refuses to promote while consensus is `pending` (fail-closed — quorum
 *     not met / requirements pending),
 *   - promotes the decisive consensus status (approved / changes_requested /
 *     rejected), recording the consensus row from the real proposals and
 *     marking every aggregated proposal processed.
 *
 * The default `latest-proposal` mode is unaffected; this path runs only when
 * the run's rule snapshot declares consensus mode.
 */
export function processConsensusModePath(
  db: Database.Database,
  opts: ProcessOpts,
  rule: ReviewRule,
  ruleSha: string,
): ProcessResult {
  const proposalRepo = new ReviewProposalRepository(db);
  const reviewerRepo = new ReviewerRepository(db);
  const consensusRepo = new ReviewConsensusRepository(db);
  const runRepo = new RunRepository(db);
  const reviewedAt = (opts.now ?? new Date()).toISOString();

  // The ENTIRE gate — read the run, snapshot all active proposals, evaluate
  // consensus, then (only if decisive) insert the consensus row, promote the
  // run, and mark the included proposals processed — runs in ONE immediate
  // transaction. The IMMEDIATE write lock makes the evaluation snapshot
  // consistent with the promotion: a concurrent `review auto` cannot slip a
  // blocking proposal in between the evaluation and the write, so the run is
  // never promoted on a stale subset of proposals. A `pending` consensus (or
  // missing run / proposals) throws, which rolls the transaction back with no
  // side effect (fail-closed).
  const gate = db.transaction((): { decision: ConsensusStatus; includedCount: number; decisionPath: string } => {
    const row = db
      .prepare("SELECT domain, status FROM runs WHERE run_id = ?")
      .get(opts.runId) as { domain: string; status: string } | undefined;
    if (row === undefined) {
      throw new ReviewGateError(`run ${opts.runId} not found in the DB`);
    }
    if (row.status !== "needs_review") {
      throw new ReviewGateError(
        `run ${opts.runId} status is "${row.status}", only needs_review can be processed`,
      );
    }
    const frozenReviewerIds = frozenReviewerIdsForRule(rule);
    const rows = activeProposalRows(proposalRepo, opts.runId, {
      ...(frozenReviewerIds.length > 0
        ? { reviewerIds: frozenReviewerIds }
        : {}),
    });
    if (rows.length === 0) {
      throw new ReviewConsensusNoActiveProposalsError(opts.runId);
    }
    const result = evaluateConsensus({
      rule,
      ruleSha256: ruleSha,
      proposals: enrichRows(rows, reviewerRepo),
      refuteVotes: enrichRefuteVotesForRun(
        new ReviewRefuteVotesRepository(db),
        reviewerRepo,
        opts.runId,
      ),
      evaluatedAt: reviewedAt,
    });
    if (result.status === "pending") {
      // fail-closed: consensus is not satisfied yet (quorum/requirements
      // pending). Do NOT promote the run on a partial set of approvals.
      throw new ReviewConsensusPendingError(
        opts.runId,
        result.summary.decisionPath,
      );
    }
    const decision = result.status;
    // Only proposals that actually fed the consensus (stale ones were dropped
    // by evaluateConsensus) drive the decision, audit ids, and processing.
    const includedIds = new Set(result.summary.proposals.map((p) => p.proposalId));
    const includedRows = rows.filter((r) => includedIds.has(r.proposalId));
    const refutedTargets = new Set(
      result.summary.refute?.refutedTargetChangeHashes ?? [],
    );
    // Required changes feed rerun; aggregate them from the included proposals
    // that did not approve (deduplicated, order-stable).
    const requiredChanges = dedupeStrings(
      includedRows
        .filter((r) => r.decision !== "approved")
        .flatMap((r) =>
          r.requiredChanges.filter(
            (change) =>
              r.decision !== "changes_requested" ||
              !refutedTargets.has(targetChangeHash(change)),
          ),
        ),
    );
    const decisionYaml = serializeReviewDecision({
      runId: opts.runId,
      domain: row.domain,
      decision,
      required_changes: requiredChanges,
      non_blocking_comments: [],
      out_of_scope_suggestions: [],
      reviewer: "consensus",
      reviewed_at: reviewedAt,
    });
    const consensusRow = consensusRepo.insertActive({
      runId: opts.runId,
      ruleSha256: ruleSha,
      status: decision,
      summary: result.summary,
      evaluatedAt: reviewedAt,
      evaluatedBy: "consensus",
      sourceProposalIds: includedRows.map((r) => r.proposalId),
    });
    runRepo.applyReviewDecision({
      runId: opts.runId,
      decision,
      reviewer: "consensus",
      reviewedAt,
      requiredChanges,
      decisionYaml,
      consensusId: consensusRow.consensusId,
      proposalsSummaryJson: consensusRow.summaryJson,
      markProposalsProcessed: includedRows.map((r) => r.proposalId),
    });
    return {
      decision,
      includedCount: includedRows.length,
      decisionPath: result.summary.decisionPath,
    };
  });
  const outcome = gate.immediate();

  warnIfExportFailed(exportRun(db, opts.runId, { runsDir: opts.runsDir }));
  return {
    runId: opts.runId,
    previousStatus: "needs_review",
    newStatus: outcome.decision as RunStatus,
    reviewer: "consensus",
    reviewedAt,
    warnings: [
      `consensus decision over ${outcome.includedCount} proposal(s) ` +
        `(${outcome.decisionPath})`,
    ],
  };
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function recordConsensusForReviewProcess(
  db: Database.Database,
  input: {
    runId: string;
    decision: "approved" | "changes_requested" | "rejected";
    reviewer: string | null;
    reviewedAt: string;
    proposalId?: number;
    /** Phase 11 post-close P1: override → consensus.summary.override. */
    override?: {
      decision: "approved" | "changes_requested" | "rejected";
      actorReviewerId: string;
      reason: string;
      createdAt: string;
    };
  },
): { consensusId: number; summaryJson: string } | null {
  const snapshot = new ReviewRulesRepository(db).findSnapshotByRun(
    input.runId,
  );
  // If no snapshot row exists (e.g. an older run created before Phase
  // 11-5), fall back to the default rule on the fly.
  const rule: ReviewRule =
    snapshot === null
      ? DEFAULT_REVIEW_RULE
      : parseReviewRuleSnapshot(snapshot.ruleJson);
  const ruleSha = snapshot?.sourceSha256 ?? ruleSha256(rule);
  const proposals: EnrichedProposal[] =
    input.proposalId !== undefined
      ? [
          {
            proposalId: input.proposalId,
            reviewerId: input.reviewer,
            reviewerType: "unknown",
            groupId: null,
            decision: input.decision,
            reviewedAt: input.reviewedAt,
          },
        ]
      : []; // file-only / override path: no real proposal row
  const result = evaluateConsensus({
    rule,
    ruleSha256: ruleSha,
    proposals,
    ...(input.override !== undefined ? { override: input.override } : {}),
    evaluatedAt: input.reviewedAt,
  });
  const row = new ReviewConsensusRepository(db).insertActive({
    runId: input.runId,
    ruleSha256: ruleSha,
    status: result.status,
    summary: result.summary,
    evaluatedAt: input.reviewedAt,
    evaluatedBy: input.reviewer ?? "review-process",
    sourceProposalIds:
      input.proposalId !== undefined ? [input.proposalId] : [],
  });
  return { consensusId: row.consensusId, summaryJson: row.summaryJson };
}
