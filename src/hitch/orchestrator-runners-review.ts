// orchestrator-runners の review-dispatch + (#229/#230) frozen consensus/refute readiness 層。
// review ↔ consensus は相互参照ゆえ単一 module に保持。

import type Database from "better-sqlite3";
import { withManagedDb } from "../db/managed-connection.js";

import type { ReviewerLensPrompt } from "../core/reviewer-agent.js";

import { ReviewerAgentGateError } from "../core/reviewer-agent-errors.js";
import { ReviewConsensusNoActiveProposalsError, ReviewConsensusPendingError } from "../core/review-processor.js";

import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";

import { ReviewRulesRepository } from "../db/repositories/review-rules.js";
import { InvalidReviewerMetadataError, ReviewerRepository, reviewerLensMetadata } from "../db/repositories/reviewers.js";

import { evaluateConsensus, REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS, type ConsensusStatus } from "../core/review-consensus.js";
import { activeProposalRows, enrichRefuteVotesForRun, enrichRows } from "../core/consensus-enrichment.js";
import { frozenReviewerIdsForRule, parseReviewRuleSnapshot, requiredReviewersForRequirement, ruleSha256, type ReviewRule } from "../core/review-rule.js";
import { targetChangeHash } from "../core/refute-binding.js";
import { ReviewRefuteVotesRepository } from "../db/repositories/review-refute-votes.js";
import { HitchRepository } from "./repository.js";
import { closeCheckFailureContexts, type CloseCheckFailureContext } from "./coder-goal-context.js";

import { ConvergenceService } from "./convergence.js";
import { evaluateCloseConditions } from "./close-checks.js";
import { recordConvergenceDecisionWithStatus } from "./convergence-status.js";

import { proposalReviewerAdvisories } from "./review-integration.js";

import { dbConsensusSnapshotProvider, evaluateConsensusStallForHitch } from "./consensus-stall-check.js";
import { nextReviewMode } from "./review-mode.js";

import type { HitchFinding, HitchCloseCondition, HitchReviewMode, HitchSession } from "./types.js";
import { findTransientLeaseCause } from "../workspace/db-domain-lock.js";
import { ConsensusReviewPreflightError } from "./orchestrator-runners-types.js";
import type { FrozenReviewerDispatch, RefuteDispatchPlan, RefuteDispatchTarget, ReviewDispatchPlan, ReviewerDispatchFailure } from "./orchestrator-runners-types.js";
import { UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET } from "./orchestrator-runners-types.js";

export function tryShortCircuitApprovedDecidedReview(input: {
  db: Database.Database;
  hitchId: string;
  runId: string;
  createdBy: string;
}): { runId: string; decision: "approved" } | null {
  const run = input.db
    .prepare("SELECT status FROM runs WHERE run_id = ?")
    .get(input.runId) as { status: string } | undefined;
  if (run?.status !== "approved") return null;

  // Gate on the run's DB-canonical decision (review_decisions), NOT the latest
  // individual proposal. In consensus mode the latest processed proposal can be
  // a non-approving member while the aggregated run decision is approved; gating
  // on the proposal would miss it and fall through to a re-review that escalates
  // an already-approved run (codex review). The canonical reviewer / source SHA
  // also come from here, so the refreshed evidence describes the decision, not
  // one member proposal.
  const decisionRow = input.db
    .prepare(
      "SELECT decision, reviewer, source_sha256 FROM review_decisions WHERE run_id = ?",
    )
    .get(input.runId) as
    | { decision: string; reviewer: string | null; source_sha256: string }
    | undefined;
  if (decisionRow?.decision !== "approved") return null;

  const repo = new HitchRepository(input.db);
  const session = repo.requireSession(input.hitchId);
  const reviewConditions = session.closeConditions.filter(
    (condition) => condition.kind === "review_consensus",
  );
  if (reviewConditions.length === 0) return null;

  // This path is ONLY an idempotent refresh of an already-completed review
  // import. Require a COMPLETED review cycle for this run: a cycle row is
  // persisted BEFORE its findings are imported and withManagedDb is not
  // transactional, so a crash mid-import leaves an incomplete cycle whose
  // findings / advisories / required follow-ups were never folded in. If no
  // completed import exists (never imported, or a crashed partial), fail-closed
  // and escalate rather than record a passed close-check that could close the
  // hitch without its findings (codex review).
  const completedImport = repo
    .listReviewCycles(input.hitchId)
    .some(
      (cycle) =>
        cycle.sourceRunId === input.runId && cycle.completedAt !== null,
    );
  if (!completedImport) {
    throw new Error(
      `approved run ${input.runId} has no completed review import; refusing ` +
        `to short-circuit close (a crashed/partial review import must be ` +
        `re-reviewed or resolved by an operator)`,
    );
  }

  // Supplementary proposal fields (proposalId, advisories) for traceability;
  // the authoritative decision/reviewer/source come from review_decisions.
  const proposal = new ReviewProposalRepository(
    input.db,
  ).getLatestProcessedProposal(input.runId);
  const advisories =
    proposal !== null ? proposalReviewerAdvisories(proposal) : [];
  const checkedAt = new Date().toISOString();
  for (const condition of reviewConditions) {
    repo.recordCloseCheck({
      hitchId: input.hitchId,
      conditionId: condition.id,
      status: "passed",
      checkedBy: decisionRow.reviewer ?? proposal?.reviewer ?? "review",
      recordingMode: "deterministic",
      checkedAt,
      evidence: {
        runId: input.runId,
        decision: "approved",
        processStatus: "approved",
        sourceSha256: decisionRow.source_sha256,
        reviewConsensusSemantics: REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS,
        idempotentRedrive: true,
        ...(proposal !== null
          ? {
              proposalId: proposal.proposalId,
              reviewDecisionId: proposal.reviewDecisionId,
            }
          : {}),
        ...(advisories.length > 0 ? { reviewerAdvisories: advisories } : {}),
      },
      message:
        "review consensus approved the run (static pass; tests not executed by review_consensus)",
    });
  }

  // Do NOT escalate here when other required conditions are still pending.
  // After refreshing the review_consensus evidence, let convergence re-evaluate
  // and route the remaining pending conditions deterministically: a pending
  // command close-check → run_close_check (auto-run), non-command/external
  // evidence (manual/artifact/operation) → operator wait (ask_human). Throwing
  // here would mis-escalate an auto-satisfiable command close-check (#184).
  const convergence = new ConvergenceService(repo).evaluate(input.hitchId);
  recordConvergenceDecisionWithStatus({
    repository: repo,
    hitchId: input.hitchId,
    decision: convergence.decision,
    reason: convergence.reason,
    metrics: { ...convergence.metrics },
    recommendedNextAction: convergence.recommendedNextAction,
    createdBy: input.createdBy,
  });

  return { runId: input.runId, decision: "approved" };
}

export function closeConditionLabel(condition: HitchCloseCondition): string {
  return condition.description === undefined ||
    condition.description.trim() === ""
    ? condition.id
    : `${condition.id} (${condition.description})`;
}

export function closeCheckFreshAfter(
  repo: HitchRepository,
  hitchId: string,
): string | null {
  const timestamps: string[] = [];
  for (const attempt of repo.listAttempts(hitchId)) {
    if (attempt.attemptType === "close-check") continue;
    timestamps.push(attempt.completedAt ?? attempt.startedAt ?? attempt.createdAt);
  }
  const latestFindingMutationAt = repo.latestFindingMutationAt(hitchId);
  if (latestFindingMutationAt !== null) {
    timestamps.push(latestFindingMutationAt);
  }
  for (const cycle of repo.listReviewCycles(hitchId)) {
    timestamps.push(cycle.completedAt ?? cycle.createdAt);
  }
  return timestamps.reduce<string | null>(
    (latest, timestamp) =>
      latest === null || timestamp > latest ? timestamp : latest,
    null,
  );
}

export function failedRequiredCloseChecks(
  repo: HitchRepository,
  session: HitchSession,
): CloseCheckFailureContext[] {
  const facetGate = repo.latestCodingRunChangedPaths(session.hitchId);
  const close = evaluateCloseConditions({
    conditions: session.closeConditions,
    checks: repo.listCloseChecks(session.hitchId),
    findingCounts: repo.countFindingSummary(session.hitchId),
    freshAfter: closeCheckFreshAfter(repo, session.hitchId),
    allowEmptyCloseConditions: session.policy.allowEmptyCloseConditions,
    changedPaths: facetGate.paths,
    latestCodingRunId: facetGate.runId,
    evidenceRows: repo.listEvidence(session.hitchId),
  });
  return closeCheckFailureContexts(close.conditions);
}

export function reviewModeForHitch(
  repo: HitchRepository,
  session: HitchSession,
): HitchReviewMode {
  return nextReviewMode(session, repo.listReviewCycles(session.hitchId));
}

export function isUnresolvedOutOfScopeFinding(finding: HitchFinding): boolean {
  return (
    finding.scopeStatus === "out_of_scope" &&
    UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET.has(finding.lifecycleStatus)
  );
}

export const CLEAN_REVIEWER_FAILURE_CODES = new Set([
  "reviewer_codex_timed_out",
  "reviewer_codex_nonzero_exit",
  "reviewer_output_unparseable_yaml",
  "reviewer_output_not_yaml_object",
  "reviewer_output_unknown_decision",
  "reviewer_output_field_not_string_array",
  "reviewer_output_field_non_string_entry",
  "reviewer_output_empty_required_changes",
]);

export function cleanReviewerFailureReason(e: unknown): string | null {
  if (!(e instanceof ReviewerAgentGateError)) return null;
  const code = (e.sanitizedReason as { reasonCode?: unknown } | undefined)
    ?.reasonCode;
  return typeof code === "string" && CLEAN_REVIEWER_FAILURE_CODES.has(code)
    ? code
    : null;
}

/**
 * Lease-loss / abort detection for the frozen-consensus dispatch loop —
 * symmetric with the coder path (which rethrows `findTransientLeaseCause(e)`).
 *
 * A course lease loss aborts `deps.signal` mid-drive, SIGKILLs the reviewer
 * codex (aborted / exit -1), and reviewer-agent raises a `reviewer_codex_*`
 * gate error that does NOT wrap a transient lease cause. Left unhandled that
 * error is misclassified as a clean per-reviewer failure → a pending-consensus
 * demotion that writes a review cycle + stall row and burns the stall budget
 * under a lost lease (the P1 fail-safe degradation). So before the clean
 * classification we check BOTH:
 *  - the error chain itself (a lease error that surfaced directly), and
 *  - the aborted signal (the abort reason carries the lease error — see
 *    course-orchestrator `abortController.abort(leaseError)`).
 * Either one means the drive is no longer authoritative → return the cause so
 * the loop rethrows it (the course layer finalizes `lease_lost`).
 */
export function findReviewerDispatchLeaseLossCause(
  e: unknown,
  signal: AbortSignal | undefined,
): unknown {
  const fromError = findTransientLeaseCause(e);
  if (fromError !== undefined) return fromError;
  if (signal?.aborted === true) {
    const reasonCause = findTransientLeaseCause(signal.reason);
    return reasonCause ?? signal.reason ?? e;
  }
  return undefined;
}

export function readReviewRuleSnapshot(input: {
  db: Database.Database;
  runId: string;
}): { rule: ReviewRule; ruleSha256: string } | null {
  const snapshot = new ReviewRulesRepository(input.db).findSnapshotByRun(
    input.runId,
  );
  if (snapshot === null) return null;
  const rule = parseReviewRuleSnapshot(snapshot.ruleJson);
  return {
    rule,
    ruleSha256: snapshot.sourceSha256 ?? ruleSha256(rule),
  };
}

export function prepareReviewDispatchPlan(input: {
  db: Database.Database;
  runId: string;
  now: string;
}): ReviewDispatchPlan {
  const snapshot = readReviewRuleSnapshot(input);
  if (snapshot === null || snapshot.rule.mode !== "consensus") {
    return { kind: "single" };
  }
  const reviewerIds = frozenReviewerIdsForRule(snapshot.rule);
  if (reviewerIds.length === 0) return { kind: "single" };

  const reviewers = assertFrozenConsensusReviewersReady({
    db: input.db,
    rule: snapshot.rule,
    reviewerIds,
  });
  new ReviewProposalRepository(input.db).supersedeActiveForReviewers({
    runId: input.runId,
    reviewerIds,
    supersededAt: input.now,
  });
  return { kind: "frozen-consensus", reviewerIds, reviewers };
}

export function prepareRefuteDispatchPlan(input: {
  db: Database.Database;
  runId: string;
  now: string;
}): RefuteDispatchPlan | null {
  const snapshot = readReviewRuleSnapshot(input);
  if (
    snapshot === null ||
    snapshot.rule.mode !== "consensus" ||
    snapshot.rule.refute === undefined
  ) {
    return null;
  }

  const proposalRepo = new ReviewProposalRepository(input.db);
  const reviewerRepo = new ReviewerRepository(input.db);
  const frozenReviewerIds = frozenReviewerIdsForRule(snapshot.rule);
  const rows = activeProposalRows(proposalRepo, input.runId, {
    ...(frozenReviewerIds.length > 0 ? { reviewerIds: frozenReviewerIds } : {}),
  });
  if (rows.length === 0) return null;

  const result = evaluateConsensus({
    rule: snapshot.rule,
    ruleSha256: snapshot.ruleSha256,
    proposals: enrichRows(rows, reviewerRepo),
    refuteVotes: enrichRefuteVotesForRun(
      new ReviewRefuteVotesRepository(input.db),
      reviewerRepo,
      input.runId,
    ),
    evaluatedAt: input.now,
  });
  if (result.status !== "changes_requested") return null;

  const targets = collectUnrefutedChangesRequestedTargets({
    rows,
    result,
  });
  if (targets.length === 0) return null;

  const reviewerIds = assertFrozenRefuteReviewersReady({
    db: input.db,
    rule: snapshot.rule,
  });
  return { reviewerIds, targets };
}

export function collectUnrefutedChangesRequestedTargets(input: {
  rows: ReturnType<typeof activeProposalRows>;
  result: ReturnType<typeof evaluateConsensus>;
}): RefuteDispatchTarget[] {
  const rowsByProposalId = new Map(
    input.rows.map((row) => [row.proposalId, row]),
  );
  const refutedTargets = new Set(
    input.result.summary.refute?.refutedTargetChangeHashes ?? [],
  );
  const seen = new Set<string>();
  const targets: RefuteDispatchTarget[] = [];
  for (const proposal of input.result.summary.proposals) {
    const row = rowsByProposalId.get(proposal.proposalId);
    if (row?.decision !== "changes_requested") continue;
    for (const changeText of row.requiredChanges) {
      const hash = targetChangeHash(changeText);
      if (refutedTargets.has(hash) || seen.has(hash)) continue;
      seen.add(hash);
      targets.push({
        idx: targets.length,
        changeText,
        targetChangeHash: hash,
      });
    }
  }
  return targets;
}

export function assertFrozenRefuteReviewersReady(input: {
  db: Database.Database;
  rule: ReviewRule;
}): string[] {
  const refute = input.rule.refute;
  if (refute === undefined) return [];
  const reviewerIds = [...refute.reviewerIds].sort();
  if (reviewerIds.length === 0) {
    throw new ConsensusReviewPreflightError(
      "the resolved frozen refute reviewer set is empty",
      { causeKind: "no_reviewers" },
    );
  }

  const reviewers = new ReviewerRepository(input.db);
  const byId = new Map(
    reviewerIds.map((reviewerId) => [
      reviewerId,
      reviewers.findById(reviewerId),
    ]),
  );
  const missing = [...byId]
    .filter(([, reviewer]) => reviewer === null)
    .map(([reviewerId]) => reviewerId);
  if (missing.length > 0) {
    throw new ConsensusReviewPreflightError(
      `unknown frozen refute reviewer(s): ${missing.join(", ")}`,
      { causeKind: "unregistered" },
    );
  }

  const required = Math.max(
    refute.minParticipants ?? 1,
    Math.floor(reviewerIds.length / 2) + 1,
  );
  const registered = reviewerIds.filter(
    (reviewerId) => byId.get(reviewerId)?.groupId === refute.group,
  );
  if (registered.length < required) {
    const causeKind =
      registered.length === 0 ? "wrong_group" : "under_quorum";
    throw new ConsensusReviewPreflightError(
      `refute group ${refute.group}: required=${required} ` +
        `registered=${registered.length} expected=${reviewerIds.length}`,
      {
        causeKind,
        group: refute.group,
        required,
        registered: registered.length,
      },
    );
  }
  return reviewerIds;
}

export function assertFrozenConsensusReviewersReady(input: {
  db: Database.Database;
  rule: ReviewRule;
  reviewerIds: readonly string[];
}): FrozenReviewerDispatch[] {
  const reviewers = new ReviewerRepository(input.db);
  const byId = new Map(
    input.reviewerIds.map((reviewerId) => [
      reviewerId,
      reviewers.findById(reviewerId),
    ]),
  );
  if (input.reviewerIds.length === 0) {
    throw new ConsensusReviewPreflightError(
      "the resolved frozen reviewer set is empty",
      { causeKind: "no_reviewers" },
    );
  }
  const missing = [...byId]
    .filter(([, reviewer]) => reviewer === null)
    .map(([reviewerId]) => reviewerId);
  if (missing.length > 0) {
    throw new ConsensusReviewPreflightError(
      `unknown frozen reviewer(s): ${missing.join(", ")}`,
      { causeKind: "unregistered" },
    );
  }

  const reviewerLensById = new Map<string, ReviewerLensPrompt | null>();
  for (const reviewerId of input.reviewerIds) {
    const reviewer = byId.get(reviewerId);
    if (reviewer === null || reviewer === undefined) continue;
    try {
      reviewerLensById.set(reviewerId, reviewerLensMetadata(reviewer));
    } catch (e) {
      if (e instanceof InvalidReviewerMetadataError) {
        throw new ConsensusReviewPreflightError(e.message, {
          causeKind: "invalid_lens",
        });
      }
      throw e;
    }
  }

  for (const requirement of input.rule.requirements) {
    if (
      requirement.reviewerIds === undefined ||
      requirement.reviewerIds.length === 0
    ) {
      continue;
    }
    const reviewerIds = [...requirement.reviewerIds].sort();
    const requiredReviewers = requiredReviewersForRequirement(requirement);
    const registered = reviewerIds.filter(
      (reviewerId) => byId.get(reviewerId)?.groupId === requirement.group,
    );
    if (registered.length < requiredReviewers) {
      // `wrong_group` when NO frozen id resolves to the required group at all
      // (every declared reviewer is registered under a different group);
      // `under_quorum` for the general shortfall.
      const causeKind =
        registered.length === 0 ? "wrong_group" : "under_quorum";
      throw new ConsensusReviewPreflightError(
        `group ${requirement.group}: required=${requiredReviewers} ` +
          `registered=${registered.length} ` +
          `expected=${reviewerIds.length}`,
        {
          causeKind,
          group: requirement.group,
          required: requiredReviewers,
          registered: registered.length,
        },
      );
    }
    assertFrozenConsensusLensMece({
      group: requirement.group,
      requiredReviewers,
      reviewerIds,
      ...(requirement.lensAxes !== undefined
        ? { lensAxes: requirement.lensAxes }
        : {}),
      reviewerLensById,
    });
  }
  return input.reviewerIds.map((reviewerId) => {
    const reviewerLens = reviewerLensById.get(reviewerId) ?? null;
    return {
      reviewerId,
      ...(reviewerLens !== null ? { reviewerLens } : {}),
    };
  });
}

export function assertFrozenConsensusLensMece(input: {
  group: string;
  requiredReviewers: number;
  reviewerIds: readonly string[];
  lensAxes?: readonly string[];
  reviewerLensById: ReadonlyMap<string, ReviewerLensPrompt | null>;
}): void {
  if (input.requiredReviewers <= 1) return;
  const requiredAxes = [...(input.lensAxes ?? [])].sort();
  if (input.requiredReviewers > 1 && input.lensAxes === undefined) {
    throw new ConsensusReviewPreflightError(
      `group ${input.group}: lens_axes is required for frozen multi-reviewer dispatch`,
      {
        causeKind: "missing_axis",
        group: input.group,
        requiredAxes,
        coveredAxes: [],
        missingAxes: [],
        duplicateAxes: [],
      },
    );
  }
  const missingLensReviewers = input.reviewerIds.filter(
    (reviewerId) => input.reviewerLensById.get(reviewerId) === null,
  );
  if (input.requiredReviewers > 1 && missingLensReviewers.length > 0) {
    throw new ConsensusReviewPreflightError(
      `group ${input.group}: reviewer(s) missing lens metadata: ${missingLensReviewers.join(", ")}`,
      {
        causeKind: "missing_lens",
        group: input.group,
        requiredAxes,
        coveredAxes: coveredLensAxes(input),
      },
    );
  }
  const counts = new Map<string, number>();
  for (const reviewerId of input.reviewerIds) {
    const lens = input.reviewerLensById.get(reviewerId);
    if (lens === null || lens === undefined) continue;
    counts.set(lens.lens, (counts.get(lens.lens) ?? 0) + 1);
  }
  const duplicateAxes = [...counts]
    .filter(([, count]) => count > 1)
    .map(([lens]) => lens)
    .sort();
  const coveredAxes = [...counts.keys()].sort();
  if (duplicateAxes.length > 0) {
    throw new ConsensusReviewPreflightError(
      `group ${input.group}: duplicate reviewer lens axis/axes: ${duplicateAxes.join(", ")}`,
      {
        causeKind: "duplicate_lens",
        group: input.group,
        requiredAxes,
        coveredAxes,
        duplicateAxes,
      },
    );
  }
  const missingAxes = requiredAxes.filter((axis) => !counts.has(axis));
  if (missingAxes.length > 0) {
    throw new ConsensusReviewPreflightError(
      `group ${input.group}: missing required lens axis/axes: ${missingAxes.join(", ")}`,
      {
        causeKind: "missing_axis",
        group: input.group,
        requiredAxes,
        coveredAxes,
        missingAxes,
        duplicateAxes,
      },
    );
  }
}

export function coveredLensAxes(input: {
  reviewerIds: readonly string[];
  reviewerLensById: ReadonlyMap<string, ReviewerLensPrompt | null>;
}): string[] {
  return [
    ...new Set(
      input.reviewerIds
        .map((reviewerId) => input.reviewerLensById.get(reviewerId)?.lens)
        .filter((lens): lens is string => lens !== undefined),
    ),
  ].sort();
}

export function recordConsensusEvaluationForRun(input: {
  db: Database.Database;
  runId: string;
  evaluatedAt: string;
  evaluatedBy: string;
}): ConsensusStatus {
  const snapshot = readReviewRuleSnapshot(input);
  if (snapshot === null || snapshot.rule.mode !== "consensus") {
    throw new Error(
      `run ${input.runId} has no consensus review rule snapshot`,
    );
  }
  const frozenReviewerIds = frozenReviewerIdsForRule(snapshot.rule);
  const rows = activeProposalRows(
    new ReviewProposalRepository(input.db),
    input.runId,
    {
      ...(frozenReviewerIds.length > 0
        ? { reviewerIds: frozenReviewerIds }
        : {}),
    },
  );
  const result = evaluateConsensus({
    rule: snapshot.rule,
    ruleSha256: snapshot.ruleSha256,
    proposals: enrichRows(rows, new ReviewerRepository(input.db)),
    refuteVotes: enrichRefuteVotesForRun(
      new ReviewRefuteVotesRepository(input.db),
      new ReviewerRepository(input.db),
      input.runId,
    ),
    evaluatedAt: input.evaluatedAt,
  });
  new ReviewConsensusRepository(input.db).insertActive({
    runId: input.runId,
    ruleSha256: snapshot.ruleSha256,
    status: result.status,
    summary: result.summary,
    evaluatedAt: input.evaluatedAt,
    evaluatedBy: input.evaluatedBy,
    sourceProposalIds: result.summary.proposals.map((p) => p.proposalId),
  });
  return result.status;
}

export function recordPendingConsensusReview(input: {
  db: Database.Database;
  hitchId: string;
  runId: string;
  createdBy: string;
  failedReviewers: ReviewerDispatchFailure[];
}): { decision: ConsensusStatus } {
  const repo = new HitchRepository(input.db);
  const session = repo.requireSession(input.hitchId);
  const evaluatedAt = new Date().toISOString();
  const decision = recordConsensusEvaluationForRun({
    db: input.db,
    runId: input.runId,
    evaluatedAt,
    evaluatedBy: "hitch.review.pending",
  });
  const cycle = repo.startReviewCycle({
    hitchId: input.hitchId,
    reviewMode: reviewModeForHitch(repo, session),
    sourceRunId: input.runId,
    createdAt: evaluatedAt,
  });
  const failed =
    input.failedReviewers.length === 0
      ? ""
      : `; failed reviewers=${input.failedReviewers
          .map((f) => `${f.reviewerId}:${f.reason}`)
          .join(",")}`;
  const completed = repo.completeReviewCycle({
    cycleId: cycle.cycleId,
    completedAt: evaluatedAt,
    summary: `Consensus review pending (${decision})${failed}`,
  });
  const convergence = new ConvergenceService(repo).evaluate(input.hitchId);
  recordConvergenceDecisionWithStatus({
    repository: repo,
    hitchId: input.hitchId,
    cycleId: completed.cycleId,
    decision: convergence.decision,
    reason: convergence.reason,
    metrics: { ...convergence.metrics },
    recommendedNextAction: convergence.recommendedNextAction,
    createdBy: input.createdBy,
  });
  evaluateConsensusStallForHitch({
    repository: repo,
    hitchId: input.hitchId,
    provider: dbConsensusSnapshotProvider(input.db),
    createdBy: input.createdBy,
    cycleId: completed.cycleId,
  });
  return { decision };
}

export function refuteRecorderForDb(dbPath: string): {
  insert: ReviewRefuteVotesRepository["insert"];
} {
  return {
    insert: (vote) =>
      withManagedDb({ dbPath }, (db) =>
        new ReviewRefuteVotesRepository(db).insert(vote),
      ),
  };
}

export function shouldRecordFrozenPendingConsensus(input: {
  error: unknown;
  dispatchPlan: ReviewDispatchPlan;
  failedReviewers: readonly ReviewerDispatchFailure[];
}): boolean {
  if (input.dispatchPlan.kind !== "frozen-consensus") return false;
  if (input.failedReviewers.length === 0) return false;
  if (input.error instanceof ReviewConsensusPendingError) return true;
  return (
    input.error instanceof ReviewConsensusNoActiveProposalsError &&
    input.failedReviewers.length === input.dispatchPlan.reviewerIds.length
  );
}
