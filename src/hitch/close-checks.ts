import type {
  HitchCloseCheck,
  HitchCloseCheckStatus,
  HitchCloseCondition,
} from "./types.js";

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
  const conditions = input.conditions.map((condition) =>
    condition.kind === "finding_policy"
      ? evaluateFindingPolicy(condition, input.findingCounts)
      : evaluateRecordedCheck(
          condition,
          latest.get(condition.id) ?? null,
          input.freshAfter ?? null,
        ),
  );
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
