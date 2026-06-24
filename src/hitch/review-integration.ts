import type Database from "better-sqlite3";
import {
  ReviewProposalRepository,
  type ReviewProposalRow,
} from "../db/repositories/review-proposals.js";
import type { ProcessResult } from "../core/review-processor.js";
import {
  REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS,
  type ConsensusStatus,
  type ConsensusSummary,
} from "../core/review-consensus.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import {
  classifyFindingForHitch,
  hasCommandFailureVeto,
  isCommandEvidenceAdvisory,
  isSuccessfulCommandEvidenceAdvisory,
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
import {
  REVIEW_BLOCKING_FINDING_CATEGORIES,
  type HitchCloseCheck,
  type HitchConvergenceDecisionRecord,
  type HitchFinding,
  type HitchFindingSeverity,
  type HitchReviewCycle,
  type HitchReviewMode,
  type HitchSession,
  type HitchScopeStatus,
} from "./types.js";

const REVIEW_REQUIRED_CHANGE_CATEGORY = REVIEW_BLOCKING_FINDING_CATEGORIES[0];
const REVIEW_NEGATIVE_DECISION_CATEGORY = REVIEW_BLOCKING_FINDING_CATEGORIES[1];

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
  /**
   * #278: prior cycles' review-blocking findings that this APPROVING cycle
   * deterministically retired (lifecycle open->fixed). Present (non-empty) only
   * when the canonical decision was `approved` and at least one stale blocker was
   * superseded; omitted otherwise.
   */
  autoResolvedFindings?: HitchFinding[];
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
  sourceRef?: string;
  forcedScopeStatus?: HitchScopeStatus;
}

type CanonicalReviewDecision = "approved" | "changes_requested" | "rejected";

interface CanonicalReviewContext {
  runId: string;
  decision: CanonicalReviewDecision | undefined;
  requiredChanges: string[] | undefined;
  reviewer: string | null | undefined;
  sourceSha256: string | undefined;
}

export function importReviewProposalToHitch(
  input: ImportReviewProposalToHitchInput,
): ImportReviewProposalToHitchResult {
  const session = input.repository.requireSession(input.hitchId);
  const canonical = resolveCanonicalReviewContext(input);
  const mode =
    input.reviewMode ??
    nextReviewMode(session, input.repository.listReviewCycles(input.hitchId));
  const reviewAdvisories = proposalReviewerAdvisories(input.proposal);
  // #306: the cycle creation + finding import + #278 supersede-resolve + cycle
  // completion + review_consensus close-check evidence commit together or not at
  // all. Previously each constituent repository method opened its OWN transaction,
  // so a crash/exception BETWEEN resolveSupersededReviewFindings (which committed
  // the open->fixed flip of prior review-blocking findings) and completeReviewCycle
  // could leave a crash-partial state: prior P1 blockers retired while the approving
  // cycle stayed incomplete. Likewise, a crash AFTER completeReviewCycle but BEFORE
  // recordReviewProcessCloseChecks would complete the cycle (consuming a review
  // budget slot) while the required review_consensus close-check evidence was never
  // recorded; that is NOT idempotently recoverable, because on the FINAL allowed
  // review cycle convergence.decide() evaluates the review-cycle budget BEFORE the
  // stale-review-consensus refresh path, so the missing evidence yields a wrong
  // terminal `budget_exhausted` instead of a re-review. Running the whole write
  // sequence inside one repository.runAtomically(...) transaction closes both
  // windows — a failure rolls back ALL of it (blockers stay open, the cycle is not
  // recorded, and no close-check evidence is written). The non-transactional `*Core`
  // variants are used for the writers that otherwise open their own transaction, so
  // there is a single BEGIN (better-sqlite3 would otherwise degrade a nested
  // `.transaction()` to a SAVEPOINT; using the cores keeps one BEGIN). The #278
  // resolve-before-complete ordering is preserved inside the transaction, so the
  // cycle's findingsFixed / findingsInScopeOpen counts still reflect the resolution.
  // ONLY the live, idempotently re-derived convergence status + consensus-stall
  // evaluation run AFTER the block.
  const { findings, autoResolved, completedCycle, closeChecks } =
    input.repository.runAtomically(() => {
      const cycle = input.repository.startReviewCycle({
        hitchId: input.hitchId,
        reviewMode: mode,
        ...(input.triggerAttemptId !== undefined
          ? { triggerAttemptId: input.triggerAttemptId }
          : {}),
        sourceReviewId: sourceReviewId(input.proposal),
        sourceRunId: input.proposal.runId,
      });
      const findings = importProposalFindings(
        input.repository,
        session,
        input.proposal,
        cycle,
        canonical,
      );
      // #278: once a later review cycle's canonical decision is APPROVED, retire the
      // prior cycles' OPEN in-scope review-origin review-blocking findings for this
      // hitch (open->fixed). This runs BEFORE completeReviewCycle so the cycle's
      // findingsFixed / findingsInScopeOpen counts and the subsequent convergence
      // evaluation both see the resolved state (convergence reaches close_ready
      // instead of needs_fix on a now-superseded openInScopeP1). The trigger is the
      // same harness-deterministic `canonical.decision === "approved"` signal that
      // drives suppressBlockingFindings — never an LLM self-report.
      //
      // Fail-closed invariant: when a processResult is supplied, the result being
      // applied MUST belong to the proposal's run. Production selects the proposal by
      // the same run, but a direct misuse could pass an approved result for an
      // UNRELATED run; auto-resolving prior blockers off a foreign run's approve would
      // wrongly retire them. If the run ids mismatch we do NOT auto-resolve.
      const resultRunMatchesProposal =
        input.processResult === undefined ||
        input.processResult.runId === input.proposal.runId;
      const autoResolved =
        canonical.decision === "approved" && resultRunMatchesProposal
          ? input.repository.resolveSupersededReviewFindingsCore({
              hitchId: input.hitchId,
              supersedingCycleId: cycle.cycleId,
              categories: REVIEW_BLOCKING_FINDING_CATEGORIES,
              decisionRunId: canonical.runId,
            })
          : [];
      const completedCycle = input.repository.completeReviewCycle({
        cycleId: cycle.cycleId,
        findingsSeen: findings.length,
        findingsNew: findings.filter(
          (f) => f.created && f.finding.scopeStatus !== "duplicate",
        ).length,
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
        summary:
          `Imported review proposal ${input.proposal.proposalId} (${input.proposal.decision})` +
          (reviewAdvisories.length === 0
            ? ""
            : `; reviewer advisory surfaced=${reviewAdvisories.length}`) +
          (autoResolved.length === 0
            ? ""
            : `; auto-resolved superseded review blockers=${autoResolved.length}`),
      });
      // #306: record the review_consensus close-check evidence INSIDE the same
      // transaction, immediately after the cycle completes. recordCloseCheck does
      // not open its own transaction (a plain INSERT + touchSession, like
      // startReviewCycle / completeReviewCycle), so it joins this single BEGIN with
      // no nested-BEGIN. The cycle completion + finding resolution + close-check
      // evidence are now one all-or-nothing unit.
      const closeChecks =
        input.processResult === undefined
          ? []
          : recordReviewProcessCloseChecks(
              input.repository,
              session,
              input.proposal,
              input.processResult,
              canonical,
              completedCycle.completedAt,
            );
      return { cycle, findings, autoResolved, completedCycle, closeChecks };
    });
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
    ...(autoResolved.length > 0 ? { autoResolvedFindings: autoResolved } : {}),
  };
}

// Exported so the approved-run short-circuit can carry the same reviewer
// advisories (e.g. "tests were not run") into the refreshed close-check
// evidence that the normal import path records.
export function proposalReviewerAdvisories(
  proposal: ReviewProposalRow,
): ReviewerAdvisory[] {
  return proposal.nonBlockingComments.flatMap((text, index) =>
    isReviewerAdvisory(text)
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
  canonical: CanonicalReviewContext,
): ImportedHitchFinding[] {
  return proposalFindingSeeds(proposal, canonical).map((seed) => {
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
    // #306: use the non-transactional core so this write joins the single atomic
    // review-import transaction opened by runAtomically (no nested BEGIN). The
    // core is byte-equivalent to upsertFinding (the public method is just a thin
    // transaction wrapper around it).
    return repository.upsertFindingCore({
      hitchId: session.hitchId,
      source: "review",
      sourceRef:
        seed.sourceRef ??
        `review_proposal:${proposal.proposalId}:${seed.kind}:${seed.index}`,
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

function proposalFindingSeeds(
  proposal: ReviewProposalRow,
  canonical: CanonicalReviewContext,
): ProposalFindingSeed[] {
  const suppressBlockingFindings = canonical.decision === "approved";
  const blockingDecision = canonical.decision ?? proposal.decision;
  const requiredChanges = canonical.requiredChanges ?? proposal.requiredChanges;
  const canonicalBlocking = canonical.requiredChanges !== undefined;
  return [
    ...(suppressBlockingFindings
      ? []
      : requiredChanges.map((text, index) => ({
          kind: "required_change" as const,
          index,
          text,
          severity: "P1" as const,
          category: REVIEW_REQUIRED_CHANGE_CATEGORY,
          ...(canonicalBlocking
            ? {
                sourceRef:
                  `review_decision:${canonical.runId}:required_change:${index}`,
              }
            : {}),
        }))),
    ...(!suppressBlockingFindings &&
    blockingDecision !== "approved" &&
    requiredChanges.length === 0
      ? [
          {
            kind: "negative_decision" as const,
            index: 0,
            text:
              `Review decision was ${blockingDecision} with no required_changes; ` +
              "inspect the review output and resolve the negative verdict before closing this hitch.",
            severity: "P1" as const,
            category: REVIEW_NEGATIVE_DECISION_CATEGORY,
            ...(canonicalBlocking
              ? {
                  sourceRef:
                    `review_decision:${canonical.runId}:negative_decision:0`,
                }
              : {}),
            forcedScopeStatus: "in_scope" as const,
          },
        ]
      : []),
    ...proposal.nonBlockingComments.flatMap((text, index) =>
      isReviewerAdvisory(text)
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

function resolveCanonicalReviewContext(
  input: ImportReviewProposalToHitchInput,
): CanonicalReviewContext {
  const runId = input.processResult?.runId ?? input.proposal.runId;
  const db = repositoryDb(input.repository);
  const row = canonicalReviewDecisionRow(db, runId);
  if (input.processResult !== undefined) {
    const decision = canonicalReviewDecision(input.processResult.newStatus);
    return {
      runId,
      decision,
      requiredChanges:
        decision === "changes_requested" || decision === "rejected"
          ? canonicalRequiredChanges(db, runId)
          : undefined,
      reviewer: row?.reviewer,
      sourceSha256: row?.source_sha256,
    };
  }

  const decision = canonicalReviewDecision(row?.decision);
  return {
    runId,
    decision,
    requiredChanges:
      decision === "changes_requested" || decision === "rejected"
        ? canonicalRequiredChanges(db, runId)
        : undefined,
    reviewer: row?.reviewer,
    sourceSha256: row?.source_sha256,
  };
}

function canonicalReviewDecisionRow(
  db: Database.Database,
  runId: string,
): { decision: string; reviewer: string | null; source_sha256: string } | undefined {
  return db
    .prepare(
      `SELECT decision, reviewer, source_sha256
         FROM review_decisions
        WHERE run_id = ?`,
    )
    .get(runId) as
    | { decision: string; reviewer: string | null; source_sha256: string }
    | undefined;
}

function canonicalReviewDecision(
  decision: string | null | undefined,
): CanonicalReviewDecision | undefined {
  if (
    decision === "approved" ||
    decision === "changes_requested" ||
    decision === "rejected"
  ) {
    return decision;
  }
  return undefined;
}

function repositoryDb(repository: HitchRepository): Database.Database {
  return (repository as unknown as { db: Database.Database }).db;
}

function canonicalRequiredChanges(
  db: Database.Database,
  runId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT change_text FROM review_required_changes
        WHERE run_id = ?
        ORDER BY idx ASC`,
    )
    .all(runId) as Array<{ change_text: string }>;
  return rows.map((row) => row.change_text);
}

export function selectProcessedProposalForReviewImport(input: {
  db: Database.Database;
  runId: string;
}): ReviewProposalRow | null {
  const proposalRepo = new ReviewProposalRepository(input.db);
  const activeConsensus = new ReviewConsensusRepository(input.db).findActive(
    input.runId,
  );
  if (activeConsensus === null) {
    return proposalRepo.getLatestProcessedProposal(input.runId);
  }

  const proposalId = consensusTraceProposalId(
    activeConsensus.status,
    activeConsensus.summaryJson,
  );
  if (proposalId === null) {
    throw new Error(
      `active review consensus for ${input.runId} has no canonical proposal trace; ` +
        "refusing to import latest processed participant proposal",
    );
  }
  const proposal = proposalRepo.getById(proposalId);
  if (proposal === null) {
    throw new Error(
      `active review consensus for ${input.runId} references missing proposal ` +
        `${proposalId}; refusing to import latest processed participant proposal`,
    );
  }
  if (proposal.runId !== input.runId) {
    throw new Error(
      `active review consensus for ${input.runId} references proposal ` +
        `${proposalId} from ${proposal.runId}; refusing to import latest ` +
        "processed participant proposal",
    );
  }
  if (proposal.processedAt === null) {
    throw new Error(
      `active review consensus for ${input.runId} references unprocessed ` +
        `proposal ${proposalId}; refusing to import latest processed ` +
        "participant proposal",
    );
  }
  return proposal;
}

function consensusTraceProposalId(
  status: ConsensusStatus,
  summaryJson: string,
): number | null {
  let summary: ConsensusSummary;
  try {
    summary = JSON.parse(summaryJson) as ConsensusSummary;
  } catch {
    return null;
  }
  if (!Array.isArray(summary.proposals)) return null;
  const included = summary.proposals.filter((proposal) =>
    Number.isSafeInteger(proposal.proposalId),
  );
  if (status === "approved") {
    return (
      included
        .filter((proposal) => proposal.decision === "approved")
        .map((proposal) => proposal.proposalId)
        .sort((a, b) => a - b)[0] ?? null
    );
  }
  if (status === "changes_requested" || status === "rejected") {
    return (
      included
        .filter((proposal) => proposal.decision === status)
        .map((proposal) => proposal.proposalId)
        .sort((a, b) => b - a)[0] ?? null
    );
  }
  return null;
}

function toClassifiableFinding(
  seed: ProposalFindingSeed,
  proposal: ReviewProposalRow,
): ClassifiableHitchFinding {
  return {
    source: "review",
    sourceRef:
      seed.sourceRef ??
      `review_proposal:${proposal.proposalId}:${seed.kind}:${seed.index}`,
    severity: seed.severity,
    category: seed.category,
    summary: seed.text,
  };
}

function isReviewerAdvisory(text: string): boolean {
  if (hasCommandFailureVeto(text)) return false;
  return (
    isTestNotRunAdvisory(text) ||
    isCommandEvidenceAdvisory(text) ||
    isSuccessfulCommandEvidenceAdvisory(text)
  );
}

function recordReviewProcessCloseChecks(
  repository: HitchRepository,
  session: HitchSession,
  proposal: ReviewProposalRow,
  result: ProcessResult,
  canonical: CanonicalReviewContext,
  freshAfter: string | null,
): HitchCloseCheck[] {
  const reviewConditions = session.closeConditions.filter(
    (condition) => condition.kind === "review_consensus",
  );
  const reviewAdvisories = proposalReviewerAdvisories(proposal);
  const matchingReviewDecisionId =
    proposal.decision === result.newStatus ? proposal.reviewDecisionId : null;
  const sourceSha256 = closeCheckSourceSha256(proposal, result, canonical);
  return reviewConditions.map((condition) =>
    repository.recordCloseCheck({
      hitchId: session.hitchId,
      conditionId: condition.id,
      status: result.newStatus === "approved" ? "passed" : "failed",
      checkedBy: result.reviewer ?? proposal.reviewer,
      recordingMode: "deterministic",
      checkedAt:
        freshAfter !== null && result.reviewedAt < freshAfter
          ? freshAfter
          : result.reviewedAt,
      evidence: {
        runId: result.runId,
        proposalId: proposal.proposalId,
        ...(matchingReviewDecisionId !== null
          ? { reviewDecisionId: matchingReviewDecisionId }
          : {}),
        decision: result.newStatus,
        processStatus: result.newStatus,
        ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
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

function closeCheckSourceSha256(
  proposal: ReviewProposalRow,
  result: ProcessResult,
  canonical: CanonicalReviewContext,
): string | undefined {
  const usesConsensusAggregate =
    result.reviewer === "consensus" ||
    canonical.reviewer === "consensus" ||
    proposal.decision !== result.newStatus;
  return usesConsensusAggregate ? canonical.sourceSha256 : proposal.sourceSha256;
}

function sourceReviewId(proposal: ReviewProposalRow): string {
  return proposal.reviewDecisionId ?? `review_proposal:${proposal.proposalId}`;
}
