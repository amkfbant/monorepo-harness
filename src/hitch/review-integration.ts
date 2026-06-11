import type { ReviewProposalRow } from "../db/repositories/review-proposals.js";
import type { ProcessResult } from "../core/review-processor.js";
import { REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS } from "../core/review-consensus.js";
import {
  classifyFindingForHitch,
  isTestNotRunAdvisory,
  type ClassifiableHitchFinding,
} from "./classification.js";
import { ConvergenceService } from "./convergence.js";
import { recordConvergenceDecisionWithStatus } from "./convergence-status.js";
import {
  evaluateConsensusStallForHitch,
  type ConsensusSnapshotProvider,
  type HitchConsensusStallResult,
} from "./consensus-stall-check.js";
import type { ConsensusStallConfig } from "../core/consensus-stall.js";
import { HitchRepository } from "./repository.js";
import { nextReviewMode } from "./review-mode.js";
import type {
  HitchCloseCheck,
  HitchConvergenceDecisionRecord,
  HitchFinding,
  HitchFindingSeverity,
  HitchReviewCycle,
  HitchReviewMode,
  HitchSession,
  HitchScopeStatus,
} from "./types.js";

export interface ImportReviewProposalToHitchInput {
  repository: HitchRepository;
  hitchId: string;
  proposal: ReviewProposalRow;
  processResult?: ProcessResult;
  reviewMode?: HitchReviewMode;
  triggerAttemptId?: string;
  createdBy: string;
  /**
   * Phase 2-3: when provided, evaluate consensus stall after recording the
   * convergence decision. A detected stall escalates the hitch (harness-only,
   * fail-closed). Omitted = no stall check (backward compatible).
   */
  consensusStall?: {
    provider: ConsensusSnapshotProvider;
    config?: ConsensusStallConfig;
  };
}

export interface ImportedHitchFinding {
  finding: HitchFinding;
  created: boolean;
  reopened: boolean;
}

export interface ReviewerAdvisory {
  source: "non_blocking_comment";
  index: number;
  category: "test-execution-unverified";
  text: string;
}

export interface ImportReviewProposalToHitchResult {
  cycle: HitchReviewCycle;
  findings: ImportedHitchFinding[];
  reviewAdvisories: ReviewerAdvisory[];
  closeChecks: HitchCloseCheck[];
  convergenceDecision: HitchConvergenceDecisionRecord;
  hitchStatus: HitchSession | null;
  /** Phase 2-3: present when a consensus-stall check ran for this import. */
  consensusStall?: HitchConsensusStallResult;
}

interface ProposalFindingSeed {
  kind:
    | "required_change"
    | "negative_decision"
    | "non_blocking_comment"
    | "out_of_scope_suggestion";
  index: number;
  text: string;
  severity: HitchFindingSeverity;
  category: string;
  forcedScopeStatus?: HitchScopeStatus;
}

export function importReviewProposalToHitch(
  input: ImportReviewProposalToHitchInput,
): ImportReviewProposalToHitchResult {
  const session = input.repository.requireSession(input.hitchId);
  const mode =
    input.reviewMode ??
    nextReviewMode(session, input.repository.listReviewCycles(input.hitchId));
  const cycle = input.repository.startReviewCycle({
    hitchId: input.hitchId,
    reviewMode: mode,
    ...(input.triggerAttemptId !== undefined
      ? { triggerAttemptId: input.triggerAttemptId }
      : {}),
    sourceReviewId: sourceReviewId(input.proposal),
    sourceRunId: input.proposal.runId,
  });
  const findings = importProposalFindings(input.repository, session, input.proposal, cycle);
  const reviewAdvisories = proposalReviewerAdvisories(input.proposal);
  const completedCycle = input.repository.completeReviewCycle({
    cycleId: cycle.cycleId,
    findingsSeen: findings.length,
    findingsNew: findings.filter((f) => f.created).length,
    findingsReopened: findings.filter((f) => f.reopened).length,
    findingsFixed: input.repository
      .listFindings({ hitchId: input.hitchId, lifecycleStatus: "fixed", limit: 10_000 })
      .length,
    findingsDeferred: input.repository
      .listFindings({ hitchId: input.hitchId, lifecycleStatus: "deferred", limit: 10_000 })
      .length,
    findingsInScopeOpen: input.repository
      .listFindings({ hitchId: input.hitchId, scopeStatus: "in_scope", limit: 10_000 })
      .filter((f) => f.lifecycleStatus === "open" || f.lifecycleStatus === "reopened")
      .length,
    summary: reviewAdvisories.length === 0
      ? `Imported review proposal ${input.proposal.proposalId} (${input.proposal.decision})`
      : `Imported review proposal ${input.proposal.proposalId} (${input.proposal.decision}); ` +
        `reviewer advisory surfaced=${reviewAdvisories.length}`,
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
  const convergence = new ConvergenceService(input.repository).evaluate(input.hitchId);
  const recorded = recordConvergenceDecisionWithStatus({
    repository: input.repository,
    hitchId: input.hitchId,
    cycleId: completedCycle.cycleId,
    decision: convergence.decision,
    reason: convergence.reason,
    metrics: { ...convergence.metrics },
    recommendedNextAction: convergence.recommendedNextAction,
    createdBy: input.createdBy,
  });
  // Phase 2-3: after the normal convergence decision, check whether the
  // consensus for this hitch's review runs is stuck. A stall escalates the
  // hitch (harness-only state transition, fail-closed) and supersedes the
  // just-synced status.
  let hitchStatus = recorded.hitchStatus;
  let convergenceDecision = recorded.decisionRecord;
  let consensusStall: HitchConsensusStallResult | undefined;
  if (input.consensusStall !== undefined) {
    consensusStall = evaluateConsensusStallForHitch({
      repository: input.repository,
      hitchId: input.hitchId,
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
    if (consensusStall.stalled && consensusStall.hitchStatus !== null) {
      hitchStatus = consensusStall.hitchStatus;
      if (consensusStall.decisionRecord !== undefined) {
        convergenceDecision = consensusStall.decisionRecord;
      }
    }
  }

  return {
    cycle: completedCycle,
    findings,
    reviewAdvisories,
    closeChecks,
    convergenceDecision,
    hitchStatus,
    ...(consensusStall !== undefined ? { consensusStall } : {}),
  };
}

function proposalReviewerAdvisories(
  proposal: ReviewProposalRow,
): ReviewerAdvisory[] {
  return proposal.nonBlockingComments.flatMap((text, index) =>
    isTestNotRunAdvisory(text)
      ? [
          {
            source: "non_blocking_comment" as const,
            index,
            category: "test-execution-unverified" as const,
            text,
          },
        ]
      : [],
  );
}

function importProposalFindings(
  repository: HitchRepository,
  session: HitchSession,
  proposal: ReviewProposalRow,
  cycle: HitchReviewCycle,
): ImportedHitchFinding[] {
  return proposalFindingSeeds(proposal).map((seed) => {
    const finding = toClassifiableFinding(seed, proposal);
    const classification =
      seed.forcedScopeStatus === undefined
        ? classifyFindingForHitch(session, finding)
        : {
            scopeStatus: seed.forcedScopeStatus,
            reason:
              seed.forcedScopeStatus === "out_of_scope"
                ? "review proposal marks this item as out of scope"
                : "review proposal negative decision blocks hitch closure",
          };
    return repository.upsertFinding({
      hitchId: session.hitchId,
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
              "inspect the review output and resolve the negative verdict before closing this hitch.",
            severity: "P1" as const,
            category: "review-negative-decision",
            forcedScopeStatus: "in_scope" as const,
          },
        ]
      : []),
    ...proposal.nonBlockingComments.flatMap((text, index) =>
      isTestNotRunAdvisory(text)
        ? []
        : [
            {
              kind: "non_blocking_comment" as const,
              index,
              text,
              severity: "P2" as const,
              category: "review-non-blocking-comment",
            },
          ],
    ),
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
): ClassifiableHitchFinding {
  return {
    source: "review",
    sourceRef: `review_proposal:${proposal.proposalId}:${seed.kind}:${seed.index}`,
    severity: seed.severity,
    category: seed.category,
    summary: seed.text,
  };
}

function recordReviewProcessCloseChecks(
  repository: HitchRepository,
  session: HitchSession,
  proposal: ReviewProposalRow,
  result: ProcessResult,
  freshAfter: string | null,
): HitchCloseCheck[] {
  const reviewConditions = session.closeConditions.filter(
    (condition) => condition.kind === "review_consensus",
  );
  const reviewAdvisories = proposalReviewerAdvisories(proposal);
  return reviewConditions.map((condition) =>
    repository.recordCloseCheck({
      hitchId: session.hitchId,
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
        reviewConsensusSemantics: REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS,
        ...(reviewAdvisories.length > 0 ? { reviewerAdvisories: reviewAdvisories } : {}),
      },
      message:
        result.newStatus === "approved"
          ? "review consensus approved the run (static pass; tests not executed by review_consensus)" +
            (reviewAdvisories.length > 0
              ? `; reviewer advisories=${reviewAdvisories.length}`
              : "")
          : `review process ended as ${result.newStatus}`,
    }),
  );
}

function sourceReviewId(proposal: ReviewProposalRow): string {
  return proposal.reviewDecisionId ?? `review_proposal:${proposal.proposalId}`;
}
