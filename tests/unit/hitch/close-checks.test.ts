import { describe, expect, it } from "vitest";
import { evaluateCloseConditions } from "../../../src/hitch/close-checks.js";
import type {
  HitchCloseCheck,
  HitchCloseCondition,
  HitchFinding,
} from "../../../src/hitch/types.js";

function finding(overrides: Partial<HitchFinding>): HitchFinding {
  return {
    findingId: "finding-a",
    hitchId: "goal-a",
    stableKey: "stable",
    duplicateOf: null,
    source: "review",
    sourceRef: null,
    sourceAttemptId: null,
    sourceCycleId: null,
    severity: "P1",
    category: "correctness",
    scopeStatus: "in_scope",
    lifecycleStatus: "open",
    summary: "summary",
    detail: null,
    filePath: null,
    symbol: null,
    suggestedFix: null,
    firstSeenAt: "t1",
    lastSeenAt: "t1",
    fixedAt: null,
    deferredAt: null,
    escalatedAt: null,
    reopenCount: 0,
    deferredBacklogItemId: null,
    classificationReason: null,
    resolutionNote: null,
    ...overrides,
  };
}

function condition(
  overrides: Partial<HitchCloseCondition>,
): HitchCloseCondition {
  return {
    id: "typecheck",
    kind: "command",
    required: true,
    ...overrides,
  };
}

function check(overrides: Partial<HitchCloseCheck>): HitchCloseCheck {
  return {
    checkId: "check-a",
    hitchId: "goal-a",
    conditionId: "typecheck",
    status: "passed",
    checkedAt: "2026-05-26T00:00:00.000Z",
    checkedBy: "test",
    evidence: {},
    message: null,
    ...overrides,
  };
}

describe("close check evaluation", () => {
  it("uses the latest check per condition", () => {
    const result = evaluateCloseConditions({
      conditions: [condition({})],
      checks: [
        check({ checkId: "old", status: "failed", checkedAt: "t1" }),
        check({ checkId: "new", status: "passed", checkedAt: "t2" }),
      ],
      findings: [],
    });
    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("required failed conditions block allRequiredPassed", () => {
    const result = evaluateCloseConditions({
      conditions: [condition({})],
      checks: [check({ status: "failed" })],
      findings: [],
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("optional failed conditions do not block allRequiredPassed", () => {
    const result = evaluateCloseConditions({
      conditions: [condition({ required: false })],
      checks: [check({ status: "failed" })],
      findings: [],
    });
    expect(result.requiredFailed).toBe(0);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("finding_policy counts open in-scope P1 and unknown findings", () => {
    const result = evaluateCloseConditions({
      conditions: [
        condition({
          id: "finding-policy",
          kind: "finding_policy",
          rule: { maxOpenInScopeP1: 0, maxOpenUnknownScope: 0 },
        }),
      ],
      checks: [],
      findings: [
        finding({ severity: "P1", scopeStatus: "in_scope" }),
        finding({
          findingId: "finding-b",
          severity: "P2",
          scopeStatus: "unknown",
        }),
        finding({
          findingId: "finding-c",
          severity: "P1",
          scopeStatus: "in_scope",
          lifecycleStatus: "fixed",
        }),
      ],
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.conditions[0]?.message).toMatch(/maxOpenInScopeP1/);
  });
});
