import type { ReviewProposalRow } from "../db/repositories/review-proposals.js";
import type { ProcessResult } from "../core/review-processor.js";
import {
  classifyFindingForGoal,
  type ClassifiableGoalFinding,
} from "./classification.js";
import { ConvergenceService } from "./convergence.js";
import { recordConvergenceDecisionWithStatus } from "./convergence-status.js";
import {
  evaluateConsensusStallForGoal,
  type ConsensusSnapshotProvider,
  type GoalConsensusStallResult,
} from "./consensus-stall-check.js";
import type { ConsensusStallConfig } from "../core/consensus-stall.js";
import { GoalRepository } from "./repository.js";
import { nextReviewMode } from "./review-mode.js";
import type {
  GoalCloseCheck,
  GoalConvergenceDecisionRecord,
  GoalFinding,
  GoalFindingSeverity,
  GoalReviewCycle,
  GoalReviewMode,
  GoalSession,
  GoalScopeStatus,
} from "./types.js";

export interface ImportReviewProposalToGoalInput {
  repository: GoalRepository;
  goalId: string;
  proposal: ReviewProposalRow;
  processResult?: ProcessResult;
  reviewMode?: GoalReviewMode;
  triggerAttemptId?: string;
  createdBy: string;
  /**
   * Phase 2-3: when provided, evaluate consensus stall after recording the
   * convergence decision. A detected stall escalates the goal (harness-only,
   * fail-closed). Omitted = no stall check (backward compatible).
   */
  consensusStall?: {
    provider: ConsensusSnapshotProvider;
    config?: ConsensusStallConfig;
  };
}

export interface ImportedGoalFinding {
  finding: GoalFinding;
  created: boolean;
  reopened: boolean;
}

export interface ImportReviewProposalToGoalResult {
  cycle: GoalReviewCycle;
  findings: ImportedGoalFinding[];
  closeChecks: GoalCloseCheck[];
  convergenceDecision: GoalConvergenceDecisionRecord;
  goalStatus: GoalSession | null;
  /** Phase 2-3: present when a consensus-stall check ran for this import. */
  consensusStall?: GoalConsensusStallResult;
}

interface ProposalFindingSeed {
  kind:
    | "required_change"
    | "negative_decision"
    | "non_blocking_comment"
    | "out_of_scope_suggestion";
  index: number;
  text: string;
  severity: GoalFindingSeverity;
  category: string;
  forcedScopeStatus?: GoalScopeStatus;
}

export function importReviewProposalToGoal(
  input: ImportReviewProposalToGoalInput,
): ImportReviewProposalToGoalResult {
  const session = input.repository.requireSession(input.goalId);
  const mode =
    input.reviewMode ??
    nextReviewMode(session, input.repository.listReviewCycles(input.goalId));
  const cycle = input.repository.startReviewCycle({
    goalId: input.goalId,
    reviewMode: mode,
    ...(input.triggerAttemptId !== undefined
      ? { triggerAttemptId: input.triggerAttemptId }
      : {}),
    sourceReviewId: sourceReviewId(input.proposal),
    sourceRunId: input.proposal.runId,
  });
  const findings = importProposalFindings(input.repository, session, input.proposal, cycle);
  const completedCycle = input.repository.completeReviewCycle({
    cycleId: cycle.cycleId,
    findingsSeen: findings.length,
    findingsNew: findings.filter((f) => f.created).length,
    findingsReopened: findings.filter((f) => f.reopened).length,
    findingsFixed: input.repository
      .listFindings({ goalId: input.goalId, lifecycleStatus: "fixed", limit: 10_000 })
      .length,
    findingsDeferred: input.repository
      .listFindings({ goalId: input.goalId, lifecycleStatus: "deferred", limit: 10_000 })
      .length,
    findingsInScopeOpen: input.repository
      .listFindings({ goalId: input.goalId, scopeStatus: "in_scope", limit: 10_000 })
      .filter((f) => f.lifecycleStatus === "open" || f.lifecycleStatus === "reopened")
      .length,
    summary: `Imported review proposal ${input.proposal.proposalId} (${input.proposal.decision})`,
  });
  const closeChecks =
    input.processResult === undefined
      ? []
      : recordReviewProcessCloseChecks(
          input.repository,
          session,
          input.proposal,
          input.processResult,
          completedCycle.completedAt,
        );
  const convergence = new ConvergenceService(input.repository).evaluate(input.goalId);
  const recorded = recordConvergenceDecisionWithStatus({
    repository: input.repository,
    goalId: input.goalId,
    cycleId: completedCycle.cycleId,
    decision: convergence.decision,
    reason: convergence.reason,
    metrics: { ...convergence.metrics },
    recommendedNextAction: convergence.recommendedNextAction,
    createdBy: input.createdBy,
  });
  // Phase 2-3: after the normal convergence decision, check whether the
  // consensus for this goal's review runs is stuck. A stall escalates the
  // goal (harness-only state transition, fail-closed) and supersedes the
  // just-synced status.
  let goalStatus = recorded.goalStatus;
  let convergenceDecision = recorded.decisionRecord;
  let consensusStall: GoalConsensusStallResult | undefined;
  if (input.consensusStall !== undefined) {
    consensusStall = evaluateConsensusStallForGoal({
      repository: input.repository,
      goalId: input.goalId,
      provider: input.consensusStall.provider,
      ...(input.consensusStall.config !== undefined
        ? { config: input.consensusStall.config }
        : {}),
      createdBy: input.createdBy,
      cycleId: completedCycle.cycleId,
    });
    // A stall escalation is the final decision for this import — surface its
    // record + status so callers are not misled by the earlier convergence
    // decision (which may read close_ready / continue).
    if (consensusStall.stalled && consensusStall.goalStatus !== null) {
      goalStatus = consensusStall.goalStatus;
      if (consensusStall.decisionRecord !== undefined) {
        convergenceDecision = consensusStall.decisionRecord;
      }
    }
  }

  return {
    cycle: completedCycle,
    findings,
    closeChecks,
    convergenceDecision,
    goalStatus,
    ...(consensusStall !== undefined ? { consensusStall } : {}),
  };
}

function importProposalFindings(
  repository: GoalRepository,
  session: GoalSession,
  proposal: ReviewProposalRow,
  cycle: GoalReviewCycle,
): ImportedGoalFinding[] {
  return proposalFindingSeeds(proposal).map((seed) => {
    const finding = toClassifiableFinding(seed, proposal);
    const classification =
      seed.forcedScopeStatus === undefined
        ? classifyFindingForGoal(session, finding)
        : {
            scopeStatus: seed.forcedScopeStatus,
            reason:
              seed.forcedScopeStatus === "out_of_scope"
                ? "review proposal marks this item as out of scope"
                : "review proposal negative decision blocks goal closure",
          };
    return repository.upsertFinding({
      goalId: session.goalId,
      source: "review",
      sourceRef: `review_proposal:${proposal.proposalId}:${seed.kind}:${seed.index}`,
      sourceCycleId: cycle.cycleId,
      severity: seed.severity,
      category: seed.category,
      scopeStatus: classification.scopeStatus,
      ...(classification.scopeStatus === "out_of_scope"
        ? { lifecycleStatus: "out_of_scope" as const }
        : {}),
      summary: seed.text,
      classificationReason: classification.reason,
    });
  });
}

function proposalFindingSeeds(proposal: ReviewProposalRow): ProposalFindingSeed[] {
  return [
    ...proposal.requiredChanges.map((text, index) => ({
      kind: "required_change" as const,
      index,
      text,
      severity: "P1" as const,
      category: "review-required-change",
    })),
    ...(proposal.decision !== "approved" && proposal.requiredChanges.length === 0
      ? [
          {
            kind: "negative_decision" as const,
            index: 0,
            text:
              `Review decision was ${proposal.decision} with no required_changes; ` +
              "inspect the review output and resolve the negative verdict before closing this goal.",
            severity: "P1" as const,
            category: "review-negative-decision",
            forcedScopeStatus: "in_scope" as const,
          },
        ]
      : []),
    ...proposal.nonBlockingComments.map((text, index) => ({
      kind: "non_blocking_comment" as const,
      index,
      text,
      severity: "P2" as const,
      category: "review-non-blocking-comment",
    })),
    ...proposal.outOfScopeSuggestions.map((text, index) => ({
      kind: "out_of_scope_suggestion" as const,
      index,
      text,
      severity: "P2" as const,
      category: "review-out-of-scope-suggestion",
      forcedScopeStatus: "out_of_scope" as const,
    })),
  ];
}

function toClassifiableFinding(
  seed: ProposalFindingSeed,
  proposal: ReviewProposalRow,
): ClassifiableGoalFinding {
  return {
    source: "review",
    sourceRef: `review_proposal:${proposal.proposalId}:${seed.kind}:${seed.index}`,
    severity: seed.severity,
    category: seed.category,
    summary: seed.text,
  };
}

function recordReviewProcessCloseChecks(
  repository: GoalRepository,
  session: GoalSession,
  proposal: ReviewProposalRow,
  result: ProcessResult,
  freshAfter: string | null,
): GoalCloseCheck[] {
  const reviewConditions = session.closeConditions.filter(
    (condition) => condition.kind === "review_consensus",
  );
  return reviewConditions.map((condition) =>
    repository.recordCloseCheck({
      goalId: session.goalId,
      conditionId: condition.id,
      status: result.newStatus === "approved" ? "passed" : "failed",
      checkedBy: result.reviewer ?? proposal.reviewer,
      checkedAt:
        freshAfter !== null && result.reviewedAt < freshAfter
          ? freshAfter
          : result.reviewedAt,
      evidence: {
        runId: result.runId,
        proposalId: proposal.proposalId,
        reviewDecisionId: proposal.reviewDecisionId,
        decision: proposal.decision,
        processStatus: result.newStatus,
        sourceSha256: proposal.sourceSha256,
      },
      message:
        result.newStatus === "approved"
          ? "review process approved the run"
          : `review process ended as ${result.newStatus}`,
    }),
  );
}

function sourceReviewId(proposal: ReviewProposalRow): string {
  return proposal.reviewDecisionId ?? `review_proposal:${proposal.proposalId}`;
}
