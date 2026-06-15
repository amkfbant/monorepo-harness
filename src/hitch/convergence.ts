import {
  OPEN_FINDING_LIFECYCLES,
  UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
  type HitchFindingFilter,
  type HitchFindingSummaryCounts,
  type HitchRepository,
} from "./repository.js";
import {
  evaluateCloseConditions,
  type EvaluatedCloseCondition,
} from "./close-checks.js";
import type {
  HitchAttempt,
  HitchConvergenceDecision,
  HitchConvergenceMetrics,
  HitchConvergenceResult,
  HitchHarnessOriginDivergenceMetrics,
  HitchNextAction,
  HitchReviewCycle,
  HitchSession,
} from "./types.js";

const CLOSE_CHECK_ATTEMPT_TYPE = "close-check";
const ADVISORY_FINDING_ID_LIMIT = 200;
const RUNNABLE_CLOSE_CHECK_STATUSES = new Set([
  "pending",
  "skipped",
  "unknown",
]);

interface PendingCloseCheckRouting {
  hasRunnableCommand: boolean;
  externalEvidenceLabels: string[];
}

export class ConvergenceService {
  constructor(private readonly repo: HitchRepository) {}

  evaluate(hitchId: string): HitchConvergenceResult {
    const session = this.repo.requireSession(hitchId);
    const findingCounts = this.repo.countFindingSummary(hitchId);
    const maxReopenCount = this.repo.maxFindingReopenCount(hitchId);
    const harnessOriginDivergenceMetrics =
      this.repo.harnessOriginDivergenceMetrics(hitchId);
    const latestFindingMutationAt = this.repo.latestFindingMutationAt(hitchId);
    const cycles = this.repo.listReviewCycles(hitchId);
    const attempts = this.repo.listAttempts(hitchId);
    const closeChecks = this.repo.listCloseChecks(hitchId);
    const close = evaluateCloseConditions({
      conditions: session.closeConditions,
      checks: closeChecks,
      findingCounts,
      freshAfter: lastCloseCheckInvalidatingMutationAt({
        attempts,
        latestFindingMutationAt,
        cycles,
      }),
      allowEmptyCloseConditions: session.policy.allowEmptyCloseConditions,
    });
    const metrics = buildMetrics(
      session,
      findingCounts,
      cycles,
      maxAttemptIteration(attempts),
      attempts.filter((a) => a.attemptType === "rerun").length,
      maxReopenCount,
      harnessOriginDivergenceMetrics,
      {
        passed: close.requiredPassed,
        failed: close.requiredFailed,
        pending: close.requiredPending,
      },
    );
    const latestCodingFailed = isLatestCodingAttemptFailed(attempts);
    const latestCodingSucceeded = isLatestCodingAttemptSucceeded(attempts);
    const reviewPending = isReviewPending(attempts, cycles, latestCodingFailed);
    // A required review_consensus close-check that is not passed (e.g. stale
    // after an approved run) must be refreshed by a review step, not the command
    // close-check runner.
    const reviewConsensusPending = close.conditions.some(
      (evaluated) =>
        evaluated.condition.required &&
        evaluated.condition.kind === "review_consensus" &&
        evaluated.status !== "passed",
    );
    const pendingCloseCheckRouting = requiredPendingCloseCheckRouting(
      close.conditions,
      close.requiredPending,
    );
    return decide(
      this.repo,
      session,
      cycles,
      metrics,
      close.allRequiredPassed,
      latestCodingFailed,
      reviewPending,
      latestCodingSucceeded,
      reviewConsensusPending,
      pendingCloseCheckRouting,
    );
  }
}

function buildMetrics(
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

function maxAttemptIteration(attempts: HitchAttempt[]): number {
  return attempts.reduce(
    (max, attempt) => Math.max(max, attempt.iteration),
    0,
  );
}

const CODING_ATTEMPT_TYPES = new Set<HitchAttempt["attemptType"]>([
  "implement",
  "rerun",
]);

/**
 * Whether the most recent coding attempt (implement / rerun) ended `failed`.
 * Attempts are ordered (iteration ASC, created_at ASC), so the last coding
 * attempt is the most recent. A failed coding run produces no review proposal,
 * so convergence must route to a rerun instead of a review that would throw.
 */
function isLatestCodingAttemptFailed(attempts: HitchAttempt[]): boolean {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    return attempt.status === "failed";
  }
  return false;
}

function isLatestCodingAttemptSucceeded(attempts: HitchAttempt[]): boolean {
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
function isReviewPending(
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

function closeConditionLabel(
  condition: EvaluatedCloseCondition["condition"],
): string {
  const description =
    condition.description !== undefined && condition.description.trim() !== ""
      ? ` (${condition.description.trim()})`
      : "";
  return `${condition.id}${description} [${condition.kind}]`;
}

function requiredPendingCloseCheckRouting(
  conditions: EvaluatedCloseCondition[],
  requiredPending: number,
): PendingCloseCheckRouting {
  let hasRunnableCommand = false;
  const externalEvidenceLabels: string[] = [];
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
    externalEvidenceLabels.push(closeConditionLabel(evaluated.condition));
  }
  if (
    conditions.length === 0 &&
    requiredPending > 0 &&
    !hasRunnableCommand
  ) {
    externalEvidenceLabels.push("close conditions [none configured]");
  }
  return { hasRunnableCommand, externalEvidenceLabels };
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

function decide(
  repo: HitchRepository,
  session: HitchSession,
  cycles: HitchReviewCycle[],
  metrics: HitchConvergenceMetrics,
  allRequiredCloseConditionsPassed: boolean,
  latestCodingFailed: boolean,
  reviewPending: boolean,
  latestCodingSucceeded: boolean,
  reviewConsensusPending: boolean,
  pendingCloseCheckRouting: PendingCloseCheckRouting,
): HitchConvergenceResult {
  const terminal = terminalDecision(session.status);
  if (terminal !== null) {
    return result(session.hitchId, terminal, `hitch is ${session.status}`, metrics, {
      kind: "ask_human",
      message: `Hitch is already ${session.status}.`,
    });
  }

  const budgetExceededReason = hitchBudgetExceededReason(session, metrics);
  if (budgetExceededReason !== null) {
    return result(
      session.hitchId,
      "budget_exhausted",
      budgetExceededReason,
      metrics,
      {
        kind: "ask_human",
        message: "Stop: hitch budget is exhausted.",
      },
    );
  }

  if (metrics.openInScopeP0 > 0) {
    return result(
      session.hitchId,
      "escalate",
      "open in-scope P0 findings",
      metrics,
      {
        kind: "ask_human",
        findingIds: openFindingIds(
          repo,
          {
            hitchId: session.hitchId,
            scopeStatus: "in_scope",
            severity: "P0",
          },
        ),
        message: "Escalate open in-scope P0 findings.",
      },
    );
  }

  const divergingReason = divergenceReason(session, metrics);
  if (divergingReason !== null) {
    return result(session.hitchId, "diverging", divergingReason, metrics, {
      kind: "ask_human",
      message: "Stop automatic fixing: finding flow is not converging.",
    });
  }

  const outOfScopeDeferralsRequired =
    session.policy.deferOutOfScope && metrics.openOutOfScope > 0;
  if (
    allRequiredCloseConditionsPassed &&
    closeRequirementsSatisfied(session, metrics) &&
    !outOfScopeDeferralsRequired
  ) {
    return result(
      session.hitchId,
      "close_ready",
      "original close conditions satisfied",
      metrics,
      {
        kind: "close_hitch",
        message: "Close hitch and defer remaining out-of-scope follow-ups.",
      },
    );
  }

  // #197 — review a SUCCEEDED-but-unreviewed coder run ONCE before stopping at
  // the soft budget LIMIT, so its successful work is not discarded. Gated on an
  // actual `budgetLimitReason` (only this stop is deferred — the hard EXCEEDED
  // stop above still wins) so it does not shadow the ordinary under-budget #104
  // review branch below; and on review-cycle budget so it cannot loop. The
  // latest coding attempt must be deterministically `succeeded` AND carry a
  // runId (the review runner reviews the latest coding attempt WITH a run, so a
  // succeeded attempt without one would review an older run and wrongly clear
  // this one's pending-review state).
  const budgetLimitReason = hitchBudgetLimitReason(session, metrics);
  if (
    budgetLimitReason !== null &&
    reviewPending &&
    latestCodingSucceeded &&
    metrics.reviewCyclesUsed < session.maxReviewCycles
  ) {
    return result(
      session.hitchId,
      "continue",
      "review the last succeeded coder run before budget_exhausted",
      metrics,
      {
        kind: "run_review",
        message:
          "Review the latest succeeded coder run before stopping at budget.",
      },
    );
  }
  if (budgetLimitReason !== null) {
    return result(session.hitchId, "budget_exhausted", budgetLimitReason, metrics, {
      kind: "ask_human",
      message: "Stop: hitch budget is exhausted.",
    });
  }

  // #104 — when the latest coder run is unreviewed, REVIEW it before routing to
  // another coder rerun (or classification). Otherwise an open finding keeps
  // triggering needs_fix → coder reruns that are never reviewed, so the fix
  // never clears the finding and the hitch burns its rerun budget. Placed AFTER
  // the budget checks (a genuinely over-budget hitch still stops) and gated by
  // the review-cycle budget, so it is bounded: one review per coder run.
  if (reviewPending && metrics.reviewCyclesUsed < session.maxReviewCycles) {
    return result(
      session.hitchId,
      "continue",
      "review the latest coder run before another fix pass",
      metrics,
      {
        kind: "run_review",
        message: "Review the latest coder run before another fix pass.",
      },
    );
  }

  if (
    metrics.openUnknownScope > 0 &&
    (session.policy.stopOnUnknownScope ||
      session.policy.closeRequires.noUnknownScope)
  ) {
    return result(
      session.hitchId,
      "needs_classification",
      "unknown-scope findings require classification",
      metrics,
      {
        kind: "classify_findings",
        findingIds: openFindingIds(repo, {
          hitchId: session.hitchId,
          scopeStatus: "unknown",
        }),
        message: "Classify unknown-scope findings before another fix pass.",
      },
    );
  }

  if (
    metrics.openInScopeP1 > 0 &&
    session.policy.closeRequires.noOpenInScopeP1
  ) {
    return result(
      session.hitchId,
      "needs_fix",
      "open in-scope P1 findings",
      metrics,
      {
        kind: "fix_findings",
        findingIds: openFindingIds(
          repo,
          {
            hitchId: session.hitchId,
            scopeStatus: "in_scope",
            severity: "P1",
          },
        ),
        message: "Fix open in-scope P1 findings.",
      },
    );
  }

  const maxOpenInScopeP2 = session.policy.closeRequires.maxOpenInScopeP2;
  if (
    maxOpenInScopeP2 !== undefined &&
    metrics.openInScopeP2 > maxOpenInScopeP2
  ) {
    return result(
      session.hitchId,
      "needs_fix",
      "open in-scope P2 findings exceed close policy",
      metrics,
      {
        kind: "fix_findings",
        findingIds: openFindingIds(
          repo,
          {
            hitchId: session.hitchId,
            scopeStatus: "in_scope",
            severity: "P2",
          },
        ),
        message: "Fix or defer in-scope P2 findings required by close policy.",
      },
    );
  }

  if (metrics.closeConditionsFailed > 0) {
    return result(
      session.hitchId,
      "needs_fix",
      "required close conditions failed",
      metrics,
      {
        kind: "run_close_check",
        message: "Fix failed close conditions and record fresh evidence.",
      },
    );
  }

  if (
    allRequiredCloseConditionsPassed &&
    session.policy.deferOutOfScope &&
    metrics.openOutOfScope > 0
  ) {
    return result(
      session.hitchId,
      "continue",
      "out-of-scope findings require deferral",
      metrics,
      {
        kind: "defer_followups",
        findingIds: unresolvedOutOfScopeFindingIds(repo, session.hitchId),
        message: "Defer out-of-scope findings before closing the hitch.",
      },
    );
  }

  if (metrics.iterationsUsed === 0) {
    return result(
      session.hitchId,
      "needs_fix",
      "no implementation attempt yet",
      metrics,
      {
        kind: "fix_findings",
        message: "Run the initial coder pass for this hitch.",
      },
    );
  }

  if (latestCodingFailed) {
    // The most recent coding run failed before it could be reviewed (e.g.
    // failed-command / failed-codex). There is nothing in `needs_review` to
    // review, so route to a bounded coder rerun rather than letting the review
    // runner be invoked on a non-reviewable run (which threw and dead-ended the
    // hitch). The rerun budget above terminates this cleanly as budget_exhausted
    // if the run cannot be recovered.
    return result(
      session.hitchId,
      "needs_fix",
      "latest coding run failed before review; rerun",
      metrics,
      {
        kind: "fix_findings",
        message:
          "The previous coder run failed before review (a failing command, " +
          "policy violation, or codex error). Re-run the coder to fix the cause.",
      },
    );
  }

  // A required `review_consensus` close-check that went stale (e.g. a finding
  // mutation after an approved run) needs a REVIEW step, not a command close-
  // check: the review runner refreshes the consensus evidence (and, for an
  // already-approved run, short-circuits without re-invoking Codex). Routing it
  // to `run_close_check` would hand it to the command runner, which only handles
  // `kind: command` conditions. Bounded by the review-cycle budget.
  if (reviewConsensusPending && metrics.reviewCyclesUsed < session.maxReviewCycles) {
    return result(
      session.hitchId,
      "continue",
      "refresh stale review consensus before close",
      metrics,
      {
        kind: "run_review",
        message: "Refresh the review consensus close-check for this run.",
      },
    );
  }

  if (pendingCloseCheckRouting.hasRunnableCommand) {
    return result(
      session.hitchId,
      "continue",
      "more validation required",
      metrics,
      {
        kind: "run_close_check",
        message: "Record command close-check evidence.",
      },
    );
  }

  if (pendingCloseCheckRouting.externalEvidenceLabels.length > 0) {
    return result(
      session.hitchId,
      "continue",
      "external close-check evidence required",
      metrics,
      {
        kind: "ask_human",
        message:
          "Record external close-check evidence for: " +
          pendingCloseCheckRouting.externalEvidenceLabels.join(", "),
      },
    );
  }

  return result(session.hitchId, "continue", "more validation required", metrics, {
    kind: "run_close_check",
    message: "Record command close-check evidence.",
  });
}

function hitchBudgetExceededReason(
  session: HitchSession,
  metrics: HitchConvergenceMetrics,
): string | null {
  if (metrics.iterationsUsed > session.maxIterations) {
    return "max iterations exceeded";
  }
  if (metrics.reviewCyclesUsed > session.maxReviewCycles) {
    return "max review cycles exceeded";
  }
  if (metrics.rerunsUsed > session.maxReruns) {
    return "max reruns exceeded";
  }
  return null;
}

function hitchBudgetLimitReason(
  session: HitchSession,
  metrics: HitchConvergenceMetrics,
): string | null {
  if (metrics.iterationsUsed >= session.maxIterations) {
    return "max iterations reached";
  }
  if (metrics.reviewCyclesUsed >= session.maxReviewCycles) {
    return "max review cycles reached";
  }
  if (metrics.rerunsUsed >= session.maxReruns) {
    return "max reruns reached";
  }
  return null;
}

function terminalDecision(
  status: HitchSession["status"],
): HitchConvergenceDecision | null {
  if (status === "closed") return "closed";
  if (status === "cancelled") return "cancel";
  if (status === "diverging") return "diverging";
  if (status === "budget_exhausted") return "budget_exhausted";
  if (status === "escalated") return "escalate";
  return null;
}

function divergenceReason(
  session: HitchSession,
  metrics: HitchConvergenceMetrics,
): string | null {
  const policy = session.policy.divergence;
  if (metrics.harnessOriginNewFindings > session.maxTotalNewFindings) {
    return "total new findings exceeded hitch budget";
  }
  if (metrics.harnessOriginNewFindings > policy.maxTotalNewFindings) {
    return "total new findings exceeded policy budget";
  }
  if (
    metrics.harnessOriginNewFindingsThisCycle >
    policy.maxNewFindingsPerCycle
  ) {
    return "new findings in current cycle exceeded policy budget";
  }
  if (metrics.harnessOriginMaxReopenCount > policy.maxReopenedPerFinding) {
    return "a finding reopened too many times";
  }
  const threshold = policy.requireNewFindingsDecreaseAfterCycle;
  const cycleCounts = metrics.harnessOriginNewFindingsByCycle;
  if (threshold > 0 && cycleCounts.length >= threshold) {
    const latest = cycleCounts[cycleCounts.length - 1];
    const previous = cycleCounts[cycleCounts.length - 2];
    if (
      latest !== undefined &&
      previous !== undefined &&
      latest.cycleNumber >= threshold &&
      latest.findingsNew > 0 &&
      latest.findingsNew >= previous.findingsNew
    ) {
      return "new findings did not decrease across review cycles";
    }
  }
  return null;
}

function closeRequirementsSatisfied(
  session: HitchSession,
  metrics: HitchConvergenceMetrics,
): boolean {
  const requires = session.policy.closeRequires;
  if (requires.noOpenInScopeP0 && metrics.openInScopeP0 > 0) return false;
  if (requires.noOpenInScopeP1 && metrics.openInScopeP1 > 0) return false;
  if (requires.noUnknownScope && metrics.openUnknownScope > 0) return false;
  if (
    requires.maxOpenInScopeP2 !== undefined &&
    metrics.openInScopeP2 > requires.maxOpenInScopeP2
  ) {
    return false;
  }
  return true;
}

/**
 * Advisory finding IDs for the next action. Convergence decisions are based on
 * SQL aggregate metrics; this list is intentionally capped for display.
 */
function openFindingIds(
  repo: HitchRepository,
  filter: HitchFindingFilter,
): string[] {
  return repo
    .listFindings({
      ...filter,
      lifecycleStatusIn: OPEN_FINDING_LIFECYCLES,
      limit: ADVISORY_FINDING_ID_LIMIT,
    })
    .map((f) => f.findingId);
}

function unresolvedOutOfScopeFindingIds(
  repo: HitchRepository,
  hitchId: string,
): string[] {
  return repo
    .listFindings({
      hitchId,
      scopeStatus: "out_of_scope",
      lifecycleStatusIn: UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
      limit: ADVISORY_FINDING_ID_LIMIT,
    })
    .map((f) => f.findingId);
}

function result(
  hitchId: string,
  decision: HitchConvergenceDecision,
  reason: string,
  metrics: HitchConvergenceMetrics,
  recommendedNextAction: HitchNextAction,
): HitchConvergenceResult {
  return { hitchId, decision, reason, metrics, recommendedNextAction };
}
