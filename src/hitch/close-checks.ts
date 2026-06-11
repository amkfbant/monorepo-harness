import type {
  HitchCloseCheck,
  HitchCloseCheckStatus,
  HitchCloseCondition,
  HitchFinding,
  HitchLifecycleStatus,
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

const OPEN_LIFECYCLES = new Set<HitchLifecycleStatus>(["open", "reopened"]);

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
  findings: HitchFinding[];
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
      ? evaluateFindingPolicy(condition, input.findings)
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
  findings: HitchFinding[],
): EvaluatedCloseCondition {
  const rule = condition.rule ?? {};
  const open = findings.filter((f) => OPEN_LIFECYCLES.has(f.lifecycleStatus));
  const openInScopeP0 = open.filter(
    (f) => f.scopeStatus === "in_scope" && f.severity === "P0",
  ).length;
  const openInScopeP1 = open.filter(
    (f) => f.scopeStatus === "in_scope" && f.severity === "P1",
  ).length;
  const openInScopeP2 = open.filter(
    (f) => f.scopeStatus === "in_scope" && f.severity === "P2",
  ).length;
  const openUnknownScope = open.filter(
    (f) => f.scopeStatus === "unknown",
  ).length;

  const checks: Array<[string, number, number]> = [
    ["maxOpenInScopeP0", numberRule(rule.maxOpenInScopeP0, Number.POSITIVE_INFINITY), openInScopeP0],
    ["maxOpenInScopeP1", numberRule(rule.maxOpenInScopeP1, Number.POSITIVE_INFINITY), openInScopeP1],
    ["maxOpenInScopeP2", numberRule(rule.maxOpenInScopeP2, Number.POSITIVE_INFINITY), openInScopeP2],
    ["maxOpenUnknownScope", numberRule(rule.maxOpenUnknownScope, Number.POSITIVE_INFINITY), openUnknownScope],
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
