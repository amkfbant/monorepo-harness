// convergence の metrics / predicate helper 層。decide() と ConvergenceService が利用。

import type {
  HitchFindingSummaryCounts,
  LinkedPhaseSpecApprovalDrift,
} from "./repository.js";
import type { EvaluatedCloseCondition } from "./close-checks.js";
import type { HitchAttempt, HitchConvergenceMetrics, HitchHarnessOriginDivergenceMetrics, HitchReviewCycle, HitchSession } from "./types.js";
import { CLOSE_CHECK_ATTEMPT_TYPE, RUNNABLE_CLOSE_CHECK_STATUSES } from "./convergence-types.js";
import type { PendingCloseCheckRouting, PendingExternalEvidenceCondition } from "./convergence-types.js";

export function buildMetrics(
  session: HitchSession,
  findingCounts: HitchFindingSummaryCounts,
  cycles: HitchReviewCycle[],
  attemptsUsed: number,
  rerunsUsed: number,
  maxReopenCount: number,
  harnessOriginDivergenceMetrics: HitchHarnessOriginDivergenceMetrics,
  closeCounts: { passed: number; failed: number; pending: number },
): HitchConvergenceMetrics {
  const latestCycle = cycles[cycles.length - 1];
  const latestHarnessOriginCycle =
    harnessOriginDivergenceMetrics.harnessOriginNewFindingsByCycle[
      harnessOriginDivergenceMetrics.harnessOriginNewFindingsByCycle.length - 1
    ];
  return {
    openInScopeP0: findingCounts.openInScopeP0,
    openInScopeP1: findingCounts.openInScopeP1,
    openInScopeP2: findingCounts.openInScopeP2,
    openUnknownScope: findingCounts.openUnknownScope,
    openOutOfScope: findingCounts.openOutOfScope,
    totalNewFindings: cycles.reduce(
      (sum, cycle) => sum + cycle.findingsNew,
      0,
    ),
    newFindingsThisCycle: latestCycle?.findingsNew ?? 0,
    reviewCyclesUsed: cycles.length,
    iterationsUsed: Math.max(session.currentIteration, attemptsUsed),
    rerunsUsed,
    closeConditionsPassed: closeCounts.passed,
    closeConditionsFailed: closeCounts.failed,
    closeConditionsPending: closeCounts.pending,
    maxReopenCount,
    harnessOriginNewFindings:
      harnessOriginDivergenceMetrics.harnessOriginNewFindings,
    harnessOriginNewFindingsThisCycle:
      latestHarnessOriginCycle?.findingsNew ?? 0,
    harnessOriginMaxReopenCount:
      harnessOriginDivergenceMetrics.harnessOriginMaxReopenCount,
    harnessOriginNewFindingsByCycle:
      harnessOriginDivergenceMetrics.harnessOriginNewFindingsByCycle,
  };
}

export function maxAttemptIteration(attempts: HitchAttempt[]): number {
  return attempts.reduce(
    (max, attempt) => Math.max(max, attempt.iteration),
    0,
  );
}

export const CODING_ATTEMPT_TYPES = new Set<HitchAttempt["attemptType"]>([
  "implement",
  "rerun",
]);

/**
 * Whether the most recent coding attempt (implement / rerun) ended `failed`.
 * Attempts are ordered (iteration ASC, created_at ASC), so the last coding
 * attempt is the most recent. A failed coding run produces no review proposal,
 * so convergence must route to a rerun instead of a review that would throw.
 */
export function isLatestCodingAttemptFailed(attempts: HitchAttempt[]): boolean {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    return attempt.status === "failed";
  }
  return false;
}

export function isLatestCodingAttemptSucceeded(attempts: HitchAttempt[]): boolean {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    // Require a runId: the review runner reviews the latest coding attempt that
    // HAS a run, so a succeeded latest attempt without one would review an OLDER
    // run and clear this attempt's pending-review state without reviewing it.
    return (
      attempt.status === "succeeded" &&
      typeof attempt.runId === "string" &&
      attempt.runId !== ""
    );
  }
  return false;
}

/**
 * #104 — true when the latest (non-failed) coding attempt produced a run that
 * has not been reviewed yet: there is a coding attempt newer than the latest
 * review cycle (or no review cycle at all). In that state the next step must be
 * a review (so the fix can clear the open finding), not another coder rerun /
 * budget_exhausted — otherwise reruns keep re-opening the same finding without
 * ever reviewing the fix, and the hitch dead-ends at budget with the finding
 * still open.
 */
export function isReviewPending(
  attempts: HitchAttempt[],
  cycles: HitchReviewCycle[],
  latestCodingFailed: boolean,
): boolean {
  if (latestCodingFailed) return false;
  let latestCodingAt: string | null = null;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt !== undefined && CODING_ATTEMPT_TYPES.has(attempt.attemptType)) {
      latestCodingAt = attempt.createdAt;
      break;
    }
  }
  if (latestCodingAt === null) return false; // no coding attempt yet
  if (cycles.length === 0) return true; // coded but never reviewed
  const latestCycleAt = cycles.reduce(
    (max, c) => (c.createdAt > max ? c.createdAt : max),
    "",
  );
  return latestCodingAt > latestCycleAt;
}

export function requiredPendingCloseCheckRouting(
  conditions: EvaluatedCloseCondition[],
  requiredPending: number,
  cycles: HitchReviewCycle[],
): PendingCloseCheckRouting {
  let hasRunnableCommand = false;
  const externalEvidenceConditions: PendingExternalEvidenceCondition[] = [];
  const codeRecoverableFacetConditionIds: string[] = [];
  for (const evaluated of conditions) {
    if (!evaluated.condition.required) continue;
    if (evaluated.status === "passed" || evaluated.status === "failed") {
      continue;
    }
    if (
      evaluated.condition.kind === "command" &&
      RUNNABLE_CLOSE_CHECK_STATUSES.has(evaluated.status)
    ) {
      hasRunnableCommand = true;
      continue;
    }
    if (evaluated.condition.kind === "review_consensus") continue;
    // #308 P2-2: a pending facet_red_test that is code-recoverable (no covering
    // test present → no evidence row can ever clear it) must route to the coder,
    // NOT the external-evidence/ask_human path (which would stall the hitch
    // waiting for evidence that cannot satisfy it). An evidence-recoverable
    // facet pending (covering test present, only RED evidence missing) keeps the
    // pre-#308 external-evidence routing below.
    if (
      evaluated.condition.kind === "facet_red_test" &&
      evaluated.facetPendingDisposition === "code_recoverable"
    ) {
      codeRecoverableFacetConditionIds.push(evaluated.condition.id);
      continue;
    }
    externalEvidenceConditions.push({
      conditionId: evaluated.condition.id,
      kind: evaluated.condition.kind,
      description:
        evaluated.condition.description !== undefined &&
        evaluated.condition.description.trim() !== ""
          ? evaluated.condition.description.trim()
          : null,
      pendingCycles: countPendingCycles(evaluated, cycles),
    });
  }
  if (
    conditions.length === 0 &&
    requiredPending > 0 &&
    !hasRunnableCommand
  ) {
    externalEvidenceConditions.push({
      conditionId: "close conditions",
      kind: "manual",
      description: "none configured",
      pendingCycles: completedReviewCycleCount(cycles),
    });
  }
  return {
    hasRunnableCommand,
    externalEvidenceConditions,
    codeRecoverableFacetConditionIds,
  };
}

export function countPendingCycles(
  evaluated: EvaluatedCloseCondition,
  cycles: HitchReviewCycle[],
): number {
  const checkedAt = evaluated.check?.checkedAt ?? null;
  return cycles.filter((cycle) => {
    const completedAt = cycle.completedAt;
    if (completedAt === null) return false;
    return checkedAt === null || completedAt > checkedAt;
  }).length;
}

export function completedReviewCycleCount(cycles: HitchReviewCycle[]): number {
  return cycles.filter((cycle) => cycle.completedAt !== null).length;
}

export function externalEvidenceAskHumanMessage(
  conditions: readonly PendingExternalEvidenceCondition[],
  specDrifts: readonly LinkedPhaseSpecApprovalDrift[],
): string {
  const conditionText = conditions
    .map(formatPendingExternalEvidenceCondition)
    .join(", ");
  const driftText = formatLinkedPhaseSpecDrifts(specDrifts);
  return (
    `Record external close-check evidence for: ${conditionText}` +
    (driftText === null ? "" : `. ${driftText}`)
  );
}

export function formatPendingExternalEvidenceCondition(
  condition: PendingExternalEvidenceCondition,
): string {
  const description =
    condition.description === null ? "" : ` (${condition.description})`;
  return (
    `condition ${condition.conditionId} kind=${condition.kind} ` +
    `pending ${condition.pendingCycles} ${cycleWord(condition.pendingCycles)}` +
    description
  );
}

export function cycleWord(count: number): string {
  return count === 1 ? "cycle" : "cycles";
}

export function formatLinkedPhaseSpecDrifts(
  drifts: readonly LinkedPhaseSpecApprovalDrift[],
): string | null {
  if (drifts.length === 0) return null;
  return (
    "Spec approval hash drift: " +
    drifts
      .map(
        (drift) =>
          `phase ${drift.phaseId} approved=${drift.approvedSpecHash} ` +
          `current=${drift.currentSpecHash}`,
      )
      .join(", ")
  );
}

export function lastCloseCheckInvalidatingMutationAt(input: {
  attempts: HitchAttempt[];
  latestFindingMutationAt: string | null;
  cycles: HitchReviewCycle[];
}): string | null {
  const timestamps: string[] = [];
  for (const attempt of input.attempts) {
    if (attempt.attemptType === CLOSE_CHECK_ATTEMPT_TYPE) continue;
    const timestamp =
      attempt.completedAt ?? attempt.startedAt ?? attempt.createdAt;
    timestamps.push(timestamp);
  }
  if (input.latestFindingMutationAt !== null) {
    timestamps.push(input.latestFindingMutationAt);
  }
  for (const cycle of input.cycles) {
    timestamps.push(cycle.completedAt ?? cycle.createdAt);
  }
  return timestamps.reduce<string | null>(
    (latest, timestamp) =>
      latest === null || timestamp > latest ? timestamp : latest,
    null,
  );
}
