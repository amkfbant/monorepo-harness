import type { GoalRepository } from "./repository.js";
import { evaluateCloseConditions } from "./close-checks.js";
import type {
  GoalAttempt,
  GoalConvergenceDecision,
  GoalConvergenceMetrics,
  GoalConvergenceResult,
  GoalFinding,
  GoalLifecycleStatus,
  GoalNextAction,
  GoalReviewCycle,
  GoalSession,
} from "./types.js";

const OPEN_LIFECYCLES = new Set<GoalLifecycleStatus>(["open", "reopened"]);
const UNRESOLVED_OUT_OF_SCOPE_LIFECYCLES = new Set<GoalLifecycleStatus>([
  "open",
  "reopened",
  "out_of_scope",
]);
const CLOSE_CHECK_ATTEMPT_TYPE = "close-check";

export class ConvergenceService {
  constructor(private readonly repo: GoalRepository) {}

  evaluate(goalId: string): GoalConvergenceResult {
    const session = this.repo.requireSession(goalId);
    const findings = this.repo.listFindings({ goalId, limit: 10_000 });
    const cycles = this.repo.listReviewCycles(goalId);
    const attempts = this.repo.listAttempts(goalId);
    const closeChecks = this.repo.listCloseChecks(goalId);
    const close = evaluateCloseConditions({
      conditions: session.closeConditions,
      checks: closeChecks,
      findings,
      freshAfter: lastCloseCheckInvalidatingMutationAt({
        attempts,
        findings,
        cycles,
      }),
      allowEmptyCloseConditions: session.policy.allowEmptyCloseConditions,
    });
    const metrics = buildMetrics(
      session,
      findings,
      cycles,
      maxAttemptIteration(attempts),
      attempts.filter((a) => a.attemptType === "rerun").length,
      {
        passed: close.requiredPassed,
        failed: close.requiredFailed,
        pending: close.requiredPending,
      },
    );
    const latestCodingFailed = isLatestCodingAttemptFailed(attempts);
    return decide(
      session,
      findings,
      cycles,
      metrics,
      close.allRequiredPassed,
      latestCodingFailed,
      isReviewPending(attempts, cycles, latestCodingFailed),
    );
  }
}

export function buildConvergenceMetrics(input: {
  session: GoalSession;
  findings: GoalFinding[];
  cycles: GoalReviewCycle[];
  attemptsUsed: number;
  rerunsUsed?: number;
  closeConditionsPassed: number;
  closeConditionsFailed: number;
  closeConditionsPending: number;
}): GoalConvergenceMetrics {
  return buildMetrics(
    input.session,
    input.findings,
    input.cycles,
    input.attemptsUsed,
    input.rerunsUsed ?? 0,
    {
      passed: input.closeConditionsPassed,
      failed: input.closeConditionsFailed,
      pending: input.closeConditionsPending,
    },
  );
}

function buildMetrics(
  session: GoalSession,
  findings: GoalFinding[],
  cycles: GoalReviewCycle[],
  attemptsUsed: number,
  rerunsUsed: number,
  closeCounts: { passed: number; failed: number; pending: number },
): GoalConvergenceMetrics {
  const open = findings.filter((f) => OPEN_LIFECYCLES.has(f.lifecycleStatus));
  const latestCycle = cycles[cycles.length - 1];
  return {
    openInScopeP0: open.filter(
      (f) => f.scopeStatus === "in_scope" && f.severity === "P0",
    ).length,
    openInScopeP1: open.filter(
      (f) => f.scopeStatus === "in_scope" && f.severity === "P1",
    ).length,
    openInScopeP2: open.filter(
      (f) => f.scopeStatus === "in_scope" && f.severity === "P2",
    ).length,
    openUnknownScope: open.filter((f) => f.scopeStatus === "unknown").length,
    openOutOfScope: findings.filter(
      (f) =>
        f.scopeStatus === "out_of_scope" &&
        UNRESOLVED_OUT_OF_SCOPE_LIFECYCLES.has(f.lifecycleStatus),
    ).length,
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
    maxReopenCount: findings.reduce(
      (max, finding) => Math.max(max, finding.reopenCount),
      0,
    ),
  };
}

function maxAttemptIteration(attempts: GoalAttempt[]): number {
  return attempts.reduce(
    (max, attempt) => Math.max(max, attempt.iteration),
    0,
  );
}

const CODING_ATTEMPT_TYPES = new Set<GoalAttempt["attemptType"]>([
  "implement",
  "rerun",
]);

/**
 * Whether the most recent coding attempt (implement / rerun) ended `failed`.
 * Attempts are ordered (iteration ASC, created_at ASC), so the last coding
 * attempt is the most recent. A failed coding run produces no review proposal,
 * so convergence must route to a rerun instead of a review that would throw.
 */
function isLatestCodingAttemptFailed(attempts: GoalAttempt[]): boolean {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    return attempt.status === "failed";
  }
  return false;
}

/**
 * #104 — true when the latest (non-failed) coding attempt produced a run that
 * has not been reviewed yet: there is a coding attempt newer than the latest
 * review cycle (or no review cycle at all). In that state the next step must be
 * a review (so the fix can clear the open finding), not another coder rerun /
 * budget_exhausted — otherwise reruns keep re-opening the same finding without
 * ever reviewing the fix, and the goal dead-ends at budget with the finding
 * still open.
 */
function isReviewPending(
  attempts: GoalAttempt[],
  cycles: GoalReviewCycle[],
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

function lastCloseCheckInvalidatingMutationAt(input: {
  attempts: GoalAttempt[];
  findings: GoalFinding[];
  cycles: GoalReviewCycle[];
}): string | null {
  const timestamps: string[] = [];
  for (const attempt of input.attempts) {
    if (attempt.attemptType === CLOSE_CHECK_ATTEMPT_TYPE) continue;
    const timestamp =
      attempt.completedAt ?? attempt.startedAt ?? attempt.createdAt;
    timestamps.push(timestamp);
  }
  for (const finding of input.findings) {
    timestamps.push(finding.lastSeenAt);
    if (finding.fixedAt !== null) timestamps.push(finding.fixedAt);
    if (finding.deferredAt !== null) timestamps.push(finding.deferredAt);
    if (finding.escalatedAt !== null) timestamps.push(finding.escalatedAt);
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
  session: GoalSession,
  findings: GoalFinding[],
  cycles: GoalReviewCycle[],
  metrics: GoalConvergenceMetrics,
  allRequiredCloseConditionsPassed: boolean,
  latestCodingFailed: boolean,
  reviewPending: boolean,
): GoalConvergenceResult {
  const terminal = terminalDecision(session.status);
  if (terminal !== null) {
    return result(session.goalId, terminal, `goal is ${session.status}`, metrics, {
      kind: "ask_human",
      message: `Goal is already ${session.status}.`,
    });
  }

  const budgetExceededReason = goalBudgetExceededReason(session, metrics);
  if (budgetExceededReason !== null) {
    return result(
      session.goalId,
      "budget_exhausted",
      budgetExceededReason,
      metrics,
      {
        kind: "ask_human",
        message: "Stop: goal budget is exhausted.",
      },
    );
  }

  if (metrics.openInScopeP0 > 0) {
    return result(
      session.goalId,
      "escalate",
      "open in-scope P0 findings",
      metrics,
      {
        kind: "ask_human",
        findingIds: openFindingIds(
          findings,
          (f) => f.scopeStatus === "in_scope" && f.severity === "P0",
        ),
        message: "Escalate open in-scope P0 findings.",
      },
    );
  }

  const divergingReason = divergenceReason(session, cycles, metrics);
  if (divergingReason !== null) {
    return result(session.goalId, "diverging", divergingReason, metrics, {
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
      session.goalId,
      "close_ready",
      "original close conditions satisfied",
      metrics,
      {
        kind: "close_goal",
        message: "Close goal and defer remaining out-of-scope follow-ups.",
      },
    );
  }

  const budgetLimitReason = goalBudgetLimitReason(session, metrics);
  if (budgetLimitReason !== null) {
    return result(session.goalId, "budget_exhausted", budgetLimitReason, metrics, {
      kind: "ask_human",
      message: "Stop: goal budget is exhausted.",
    });
  }

  // #104 — when the latest coder run is unreviewed, REVIEW it before routing to
  // another coder rerun (or classification). Otherwise an open finding keeps
  // triggering needs_fix → coder reruns that are never reviewed, so the fix
  // never clears the finding and the goal burns its rerun budget. Placed AFTER
  // the budget checks (a genuinely over-budget goal still stops) and gated by
  // the review-cycle budget, so it is bounded: one review per coder run.
  if (reviewPending && metrics.reviewCyclesUsed < session.maxReviewCycles) {
    return result(
      session.goalId,
      "continue",
      "review the latest coder run before another fix pass",
      metrics,
      {
        kind: "run_close_check",
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
      session.goalId,
      "needs_classification",
      "unknown-scope findings require classification",
      metrics,
      {
        kind: "classify_findings",
        findingIds: openFindingIds(findings, (f) => f.scopeStatus === "unknown"),
        message: "Classify unknown-scope findings before another fix pass.",
      },
    );
  }

  if (
    metrics.openInScopeP1 > 0 &&
    session.policy.closeRequires.noOpenInScopeP1
  ) {
    return result(
      session.goalId,
      "needs_fix",
      "open in-scope P1 findings",
      metrics,
      {
        kind: "fix_findings",
        findingIds: openFindingIds(
          findings,
          (f) => f.scopeStatus === "in_scope" && f.severity === "P1",
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
      session.goalId,
      "needs_fix",
      "open in-scope P2 findings exceed close policy",
      metrics,
      {
        kind: "fix_findings",
        findingIds: openFindingIds(
          findings,
          (f) => f.scopeStatus === "in_scope" && f.severity === "P2",
        ),
        message: "Fix or defer in-scope P2 findings required by close policy.",
      },
    );
  }

  if (metrics.closeConditionsFailed > 0) {
    return result(
      session.goalId,
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
      session.goalId,
      "continue",
      "out-of-scope findings require deferral",
      metrics,
      {
        kind: "defer_followups",
        findingIds: unresolvedOutOfScopeFindingIds(findings),
        message: "Defer out-of-scope findings before closing the goal.",
      },
    );
  }

  if (metrics.iterationsUsed === 0) {
    return result(
      session.goalId,
      "needs_fix",
      "no implementation attempt yet",
      metrics,
      {
        kind: "fix_findings",
        message: "Run the initial coder pass for this goal.",
      },
    );
  }

  if (latestCodingFailed) {
    // The most recent coding run failed before it could be reviewed (e.g.
    // failed-command / failed-codex). There is nothing in `needs_review` to
    // review, so route to a bounded coder rerun rather than letting the review
    // runner be invoked on a non-reviewable run (which threw and dead-ended the
    // goal). The rerun budget above terminates this cleanly as budget_exhausted
    // if the run cannot be recovered.
    return result(
      session.goalId,
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

  return result(session.goalId, "continue", "more validation required", metrics, {
    kind: "run_close_check",
    message: "Record close-check evidence or run the next review mode.",
  });
}

function goalBudgetExceededReason(
  session: GoalSession,
  metrics: GoalConvergenceMetrics,
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

function goalBudgetLimitReason(
  session: GoalSession,
  metrics: GoalConvergenceMetrics,
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
  status: GoalSession["status"],
): GoalConvergenceDecision | null {
  if (status === "closed") return "closed";
  if (status === "cancelled") return "cancel";
  if (status === "diverging") return "diverging";
  if (status === "budget_exhausted") return "budget_exhausted";
  if (status === "escalated") return "escalate";
  return null;
}

function divergenceReason(
  session: GoalSession,
  cycles: GoalReviewCycle[],
  metrics: GoalConvergenceMetrics,
): string | null {
  const policy = session.policy.divergence;
  if (metrics.totalNewFindings > session.maxTotalNewFindings) {
    return "total new findings exceeded goal budget";
  }
  if (metrics.totalNewFindings > policy.maxTotalNewFindings) {
    return "total new findings exceeded policy budget";
  }
  if (metrics.newFindingsThisCycle > policy.maxNewFindingsPerCycle) {
    return "new findings in current cycle exceeded policy budget";
  }
  if (metrics.maxReopenCount > policy.maxReopenedPerFinding) {
    return "a finding reopened too many times";
  }
  const threshold = policy.requireNewFindingsDecreaseAfterCycle;
  if (threshold > 0 && cycles.length >= threshold) {
    const latest = cycles[cycles.length - 1];
    const previous = cycles[cycles.length - 2];
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
  session: GoalSession,
  metrics: GoalConvergenceMetrics,
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

function openFindingIds(
  findings: GoalFinding[],
  predicate: (finding: GoalFinding) => boolean,
): string[] {
  return findings
    .filter((f) => OPEN_LIFECYCLES.has(f.lifecycleStatus) && predicate(f))
    .map((f) => f.findingId);
}

function unresolvedOutOfScopeFindingIds(findings: GoalFinding[]): string[] {
  return findings
    .filter(
      (f) =>
        f.scopeStatus === "out_of_scope" &&
        UNRESOLVED_OUT_OF_SCOPE_LIFECYCLES.has(f.lifecycleStatus),
    )
    .map((f) => f.findingId);
}

function result(
  goalId: string,
  decision: GoalConvergenceDecision,
  reason: string,
  metrics: GoalConvergenceMetrics,
  recommendedNextAction: GoalNextAction,
): GoalConvergenceResult {
  return { goalId, decision, reason, metrics, recommendedNextAction };
}
