import type {
  HitchCloseCheck,
  HitchCloseCheckStatus,
  HitchCloseCondition,
} from "./types.js";
import {
  evaluateFacetRedCoverage,
  parseFacetRule,
  type FacetRedEvidence,
} from "./facet-coverage.js";

export interface EvaluatedCloseCondition {
  condition: HitchCloseCondition;
  status: HitchCloseCheckStatus;
  check: HitchCloseCheck | null;
  message: string;
}

export interface CloseConditionEvaluation {
  conditions: EvaluatedCloseCondition[];
  requiredPassed: number;
  requiredFailed: number;
  requiredPending: number;
  allRequiredPassed: boolean;
}

export interface FindingPolicyCounts {
  openInScopeP0: number;
  openInScopeP1: number;
  openInScopeP2: number;
  openUnknownScope: number;
}

export function latestCloseChecksByCondition(
  checks: HitchCloseCheck[],
): Map<string, HitchCloseCheck> {
  const latest = new Map<string, HitchCloseCheck>();
  for (const check of checks) {
    const previous = latest.get(check.conditionId);
    if (
      previous === undefined ||
      check.checkedAt > previous.checkedAt ||
      (check.checkedAt === previous.checkedAt && check.checkId > previous.checkId)
    ) {
      latest.set(check.conditionId, check);
    }
  }
  return latest;
}

export function evaluateCloseConditions(input: {
  conditions: HitchCloseCondition[];
  checks: HitchCloseCheck[];
  findingCounts: FindingPolicyCounts;
  freshAfter?: string | null;
  allowEmptyCloseConditions?: boolean;
  /**
   * Deterministic facet_red_test inputs (opt-in). When absent, a facet_red_test
   * condition evaluates fail-closed (pending/failed, never passed). Existing
   * hitches that never declare facet_red_test are unaffected by these params.
   */
  changedPaths?: readonly string[];
  latestCodingRunId?: string | null;
}): CloseConditionEvaluation {
  if (
    input.conditions.length === 0 &&
    input.allowEmptyCloseConditions !== true
  ) {
    return {
      conditions: [],
      requiredPassed: 0,
      requiredFailed: 0,
      requiredPending: 1,
      allRequiredPassed: false,
    };
  }
  const latest = latestCloseChecksByCondition(input.checks);
  const conditions = input.conditions.map((condition) => {
    if (condition.kind === "finding_policy") {
      return evaluateFindingPolicy(condition, input.findingCounts);
    }
    if (condition.kind === "facet_red_test") {
      return evaluateFacetRedTest(
        condition,
        latest.get(condition.id) ?? null,
        input.freshAfter ?? null,
        input.changedPaths ?? [],
        input.latestCodingRunId ?? null,
      );
    }
    return evaluateRecordedCheck(
      condition,
      latest.get(condition.id) ?? null,
      input.freshAfter ?? null,
    );
  });
  let requiredPassed = 0;
  let requiredFailed = 0;
  let requiredPending = 0;
  for (const evaluated of conditions) {
    if (!evaluated.condition.required) continue;
    if (evaluated.status === "passed") requiredPassed += 1;
    else if (evaluated.status === "failed") requiredFailed += 1;
    else requiredPending += 1;
  }
  return {
    conditions,
    requiredPassed,
    requiredFailed,
    requiredPending,
    allRequiredPassed: requiredFailed === 0 && requiredPending === 0,
  };
}

function evaluateRecordedCheck(
  condition: HitchCloseCondition,
  check: HitchCloseCheck | null,
  freshAfter: string | null,
): EvaluatedCloseCondition {
  if (check === null) {
    return {
      condition,
      status: "pending",
      check,
      message: "no close-check evidence recorded",
    };
  }
  if (freshAfter !== null && check.checkedAt < freshAfter) {
    return {
      condition,
      status: "pending",
      check,
      message:
        "close-check evidence is stale; record fresh evidence after latest mutation",
    };
  }
  return {
    condition,
    status: check.status,
    check,
    message: check.message ?? check.status,
  };
}

/**
 * Deterministic facet_red_test gate (#279). Evaluated ONLY from the run's
 * changed paths (run_changed_files) and operator/runner-recorded RED evidence —
 * NEVER from any LLM/reviewer verdict. Fail-closed at every junction:
 * - unresolvable runId (null) / changedPaths empty input from a caller that
 *   could not resolve them => never passed;
 * - no recorded evidence row => pending;
 * - stale recorded evidence (older than freshAfter) => pending;
 * - malformed rule.facets => failed (a malformed contract must not pass);
 * - a facet whose production surface changed but has no covering test => failed
 *   (the fail-open shape the reviewer-depth gap let through).
 */
function evaluateFacetRedTest(
  condition: HitchCloseCondition,
  check: HitchCloseCheck | null,
  freshAfter: string | null,
  changedPaths: readonly string[],
  latestCodingRunId: string | null,
): EvaluatedCloseCondition {
  const parsed = parseFacetRule(condition.rule);
  if (parsed.errors.length > 0) {
    return {
      condition,
      status: "failed",
      check,
      message: `malformed facet_red_test contract: ${parsed.errors.join("; ")}`,
    };
  }
  if (latestCodingRunId === null || latestCodingRunId === "") {
    return {
      condition,
      status: "pending",
      check,
      message: "facet_red_test: no resolvable run to evaluate coverage against",
    };
  }
  // Stale recorded evidence is treated as ABSENT (fail-closed): a facet cannot
  // be satisfied by RED evidence older than the latest invalidating mutation.
  // The fail-open shape (production touched, no covering test) is still detected
  // deterministically from changedPaths even with no/stale evidence — that is
  // the depth gap #279 closes, and it does not depend on a recorded row.
  const evidenceIsFresh =
    check !== null &&
    (freshAfter === null || check.checkedAt >= freshAfter);
  const evidence = evidenceIsFresh
    ? parseFacetEvidence(check?.evidence ?? {})
    : [];
  const result = evaluateFacetRedCoverage({
    facets: parsed.facets,
    changedPaths,
    evidence,
    runId: latestCodingRunId,
  });
  // When NO fresh evidence row exists, a facet that merely lacks a RED
  // demonstration is RECOVERABLE (record evidence) → pending, not a hard fail.
  // A fail-open shape (production touched, no covering test) stays FAILED — it
  // needs a new run, not just evidence. A stale row also withholds the message
  // so the operator records fresh evidence.
  const status: HitchCloseCheckStatus = evidenceIsFresh
    ? result.status
    : downgradeMissingEvidenceToPending(result);
  const message =
    check !== null && !evidenceIsFresh
      ? "facet_red_test: recorded evidence is stale; record fresh RED evidence after latest mutation"
      : result.message;
  return { condition, status, check, message };
}

/**
 * With no fresh evidence row, only the deterministic fail-open shape is a hard
 * FAIL; a facet that merely lacks a recorded RED demonstration is pending
 * (recoverable by recording evidence). Fail-closed: never upgrades to passed.
 */
function downgradeMissingEvidenceToPending(
  result: ReturnType<typeof evaluateFacetRedCoverage>,
): HitchCloseCheckStatus {
  if (result.perFacet.some((f) => f.reasonCode === "fail_open_shape")) {
    return "failed";
  }
  return result.perFacet.every((f) => f.status === "passed")
    ? "passed"
    : "pending";
}

function parseFacetEvidence(
  evidence: Record<string, unknown>,
): FacetRedEvidence[] {
  const raw = evidence.facets;
  if (!Array.isArray(raw)) return [];
  const parsed: FacetRedEvidence[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.facetId !== "string" || e.facetId === "") continue;
    if (typeof e.redTestPath !== "string" || e.redTestPath === "") continue;
    if (typeof e.runId !== "string" || e.runId === "") continue;
    // A non-boolean redDemonstrated never counts (fail-closed): coerce to a
    // strict boolean so only an explicit `true` can satisfy the facet.
    parsed.push({
      facetId: e.facetId,
      redTestPath: e.redTestPath,
      redDemonstrated: e.redDemonstrated === true,
      runId: e.runId,
      ...(typeof e.evidenceRef === "string"
        ? { evidenceRef: e.evidenceRef }
        : {}),
    });
  }
  return parsed;
}

function evaluateFindingPolicy(
  condition: HitchCloseCondition,
  counts: FindingPolicyCounts,
): EvaluatedCloseCondition {
  const rule = condition.rule ?? {};

  const checks: Array<[string, number, number]> = [
    [
      "maxOpenInScopeP0",
      numberRule(rule.maxOpenInScopeP0, Number.POSITIVE_INFINITY),
      counts.openInScopeP0,
    ],
    [
      "maxOpenInScopeP1",
      numberRule(rule.maxOpenInScopeP1, Number.POSITIVE_INFINITY),
      counts.openInScopeP1,
    ],
    [
      "maxOpenInScopeP2",
      numberRule(rule.maxOpenInScopeP2, Number.POSITIVE_INFINITY),
      counts.openInScopeP2,
    ],
    [
      "maxOpenUnknownScope",
      numberRule(rule.maxOpenUnknownScope, Number.POSITIVE_INFINITY),
      counts.openUnknownScope,
    ],
  ];
  const failed = checks.filter(([, max, actual]) => actual > max);
  return {
    condition,
    status: failed.length === 0 ? "passed" : "failed",
    check: null,
    message:
      failed.length === 0
        ? "finding policy passed"
        : failed
            .map(([name, max, actual]) => `${name}: ${actual} > ${max}`)
            .join("; "),
  };
}

function numberRule(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}
