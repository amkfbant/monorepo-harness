import { OPEN_FINDING_LIFECYCLES, UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES, type HitchFindingFilter, type HitchRepository, type LinkedPhaseSpecApprovalDrift } from "./repository.js";
import { evaluateCloseConditions } from "./close-checks.js";
import type { HitchConvergenceDecision, HitchConvergenceMetrics, HitchConvergenceResult, HitchNextAction, HitchReviewCycle, HitchSession } from "./types.js";
import { ADVISORY_FINDING_ID_LIMIT } from "./convergence-types.js";
import type { PendingCloseCheckRouting } from "./convergence-types.js";
import { buildMetrics, externalEvidenceAskHumanMessage, isLatestCodingAttemptFailed, isLatestCodingAttemptSucceeded, isReviewPending, lastCloseCheckInvalidatingMutationAt, maxAttemptIteration, requiredPendingCloseCheckRouting } from "./convergence-metrics.js";
// lastCloseCheckInvalidatingMutationAt moved to convergence-metrics.ts; re-export
// so existing importers keep using "./convergence.js".
export { lastCloseCheckInvalidatingMutationAt };

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
    // Deterministic facet_red_test inputs (#279). For hitches that never declare
    // a facet_red_test condition these are simply unused; for those that do, a
    // null runId / empty paths keep the gate fail-closed (never passed).
    const facetGate = this.repo.latestCodingRunChangedPaths(hitchId);
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
      changedPaths: facetGate.paths,
      latestCodingRunId: facetGate.runId,
      evidenceRows: this.repo.listEvidence(hitchId),
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
      cycles,
    );
    const linkedPhaseSpecDrifts = this.repo.linkedPhaseSpecApprovalDrifts(
      session.hitchId,
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
      linkedPhaseSpecDrifts,
    );
  }
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
  linkedPhaseSpecDrifts: readonly LinkedPhaseSpecApprovalDrift[],
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

  // #308 P2-2: a pending facet_red_test condition that can ONLY be satisfied by
  // a code/test change (no covering test present → no evidence row can clear it)
  // routes to a bounded coder rerun, NOT ask_human/external-evidence. An
  // evidence-recoverable facet pending (covering test present, RED evidence
  // missing) is NOT routed here — it falls through to the external-evidence
  // branch below, preserving the pre-#308 ask_human/record-evidence routing.
  if (pendingCloseCheckRouting.codeRecoverableFacetConditionIds.length > 0) {
    return result(
      session.hitchId,
      "needs_fix",
      "facet_red_test pending requires a covering test",
      metrics,
      {
        kind: "fix_findings",
        message:
          "A required facet_red_test condition has no covering test " +
          `(${pendingCloseCheckRouting.codeRecoverableFacetConditionIds.join(", ")}). ` +
          "Re-run the coder to add a RED covering test for the facet; recorded " +
          "evidence alone cannot satisfy it.",
      },
    );
  }

  if (pendingCloseCheckRouting.externalEvidenceConditions.length > 0) {
    return result(
      session.hitchId,
      "continue",
      "external close-check evidence required",
      metrics,
      {
        kind: "ask_human",
        message: externalEvidenceAskHumanMessage(
          pendingCloseCheckRouting.externalEvidenceConditions,
          linkedPhaseSpecDrifts,
        ),
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
  // `diverging` is intentionally NOT short-circuited here (#164): unlike the
  // hard terminals above (and the operator-gated budget_exhausted / escalated),
  // divergence is a DERIVED condition. A transient trigger (per-cycle count /
  // non-decreasing) clears once a later review cycle is clean, so a stored
  // `diverging` status must be RE-DERIVED live via `divergenceReason` below —
  // otherwise it caches a stale stop and never re-evaluates. A genuinely
  // persistent (cumulative budget / max-reopen) divergence simply re-fires on
  // re-derivation, so it stays diverging; only a cleared one self-heals.
  if (status === "budget_exhausted") return "budget_exhausted";
  if (status === "escalated") return "escalate";
  return null;
}

/**
 * #280 — the single divergence reason recoverable via a session-budget bump
 * (`hitch recover-diverging`). All OTHER triggers (policy-total / per-cycle /
 * reopen-count / non-decreasing trend) are NOT cleared by raising
 * `max_total_new_findings`, so the recovery command must fail-closed on them.
 * Kept here next to {@link divergenceReason} so the recoverable reason cannot
 * drift from the trigger that actually produces it.
 */
export const RECOVERABLE_DIVERGENCE_REASON =
  "total new findings exceeded hitch budget" as const;

/**
 * #280 — deterministic re-derivation of the divergence reason under a
 * HYPOTHETICAL session budget, reusing the exact frozen {@link divergenceReason}
 * logic. The recovery CLI calls this with the post-bump budget to PROVE the
 * extension clears the trigger (no re-fire) before flipping status. Returns the
 * first active divergence reason, or null when none would fire.
 */
export function divergenceReasonForBudget(
  session: HitchSession,
  metrics: HitchConvergenceMetrics,
  hypotheticalMaxTotalNewFindings: number,
): string | null {
  return divergenceReason(
    { ...session, maxTotalNewFindings: hypotheticalMaxTotalNewFindings },
    metrics,
  );
}

function divergenceReason(
  session: HitchSession,
  metrics: HitchConvergenceMetrics,
): string | null {
  const policy = session.policy.divergence;
  if (metrics.harnessOriginNewFindings > session.maxTotalNewFindings) {
    return "total new findings exceeded hitch budget";
  }
  // #280 — the policy default is a FLOOR, not an independent ceiling: an explicit
  // per-hitch session budget that is RAISED above policy (e.g. by the audited
  // `recover-diverging` extension) authorizes that count for THIS hitch, so the
  // shared policy default must not re-fire under it. A LOWERED session budget can
  // never pull the effective ceiling below policy here because the SESSION check
  // above decides tightening first and returns before this line is reached. So
  // `max(...)` preserves the session-tightening behavior byte-identically while
  // letting recovery lift the effective total ceiling above both ceilings.
  const effectiveTotalCeiling = Math.max(
    policy.maxTotalNewFindings,
    session.maxTotalNewFindings,
  );
  if (metrics.harnessOriginNewFindings > effectiveTotalCeiling) {
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
