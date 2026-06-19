import { describe, expect, it } from "vitest";
import { evaluateCloseConditions } from "../../../src/hitch/close-checks.js";
import type {
  HitchCloseCheck,
  HitchCloseCondition,
} from "../../../src/hitch/types.js";

function noFindingCounts() {
  return {
    openInScopeP0: 0,
    openInScopeP1: 0,
    openInScopeP2: 0,
    openUnknownScope: 0,
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
      findingCounts: noFindingCounts(),
    });
    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("required failed conditions block allRequiredPassed", () => {
    const result = evaluateCloseConditions({
      conditions: [condition({})],
      checks: [check({ status: "failed" })],
      findingCounts: noFindingCounts(),
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("optional failed conditions do not block allRequiredPassed", () => {
    const result = evaluateCloseConditions({
      conditions: [condition({ required: false })],
      checks: [check({ status: "failed" })],
      findingCounts: noFindingCounts(),
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
      findingCounts: {
        ...noFindingCounts(),
        openInScopeP1: 1,
        openUnknownScope: 1,
      },
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.conditions[0]?.message).toMatch(/maxOpenInScopeP1/);
  });
});

function facetCondition(
  overrides: Partial<HitchCloseCondition> = {},
): HitchCloseCondition {
  return condition({
    id: "facet-red",
    kind: "facet_red_test",
    rule: {
      facets: [
        {
          id: "auth-login",
          testGlobs: ["tests/auth/**"],
          changedFileGlobs: ["src/auth/**"],
        },
      ],
    },
    ...overrides,
  });
}

function facetCheck(facets: unknown, overrides: Partial<HitchCloseCheck> = {}) {
  return check({
    conditionId: "facet-red",
    status: "passed",
    evidence: { facets },
    ...overrides,
  });
}

describe("facet_red_test close condition", () => {
  it("fail-closed: no recorded check row => pending (never passed)", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition()],
      checks: [],
      findingCounts: noFindingCounts(),
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      latestCodingRunId: "run-close",
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("GATE (#279): production surface changed but testGlobs match nothing => FAILED", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition()],
      checks: [facetCheck([])],
      findingCounts: noFindingCounts(),
      changedPaths: ["src/auth/login.ts"],
      latestCodingRunId: "run-close",
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
    expect(result.conditions[0]?.message).toMatch(/no covering test/i);
  });

  it("happy path: changed test + matching RED evidence from close run => passed", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition()],
      checks: [
        facetCheck([
          {
            facetId: "auth-login",
            redTestPath: "tests/auth/login.test.ts",
            redDemonstrated: true,
            runId: "run-close",
          },
        ]),
      ],
      findingCounts: noFindingCounts(),
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      latestCodingRunId: "run-close",
    });
    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("fail-closed: unresolvable runId (null) => never passed", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition()],
      checks: [
        facetCheck([
          {
            facetId: "auth-login",
            redTestPath: "tests/auth/login.test.ts",
            redDemonstrated: true,
            runId: "run-close",
          },
        ]),
      ],
      findingCounts: noFindingCounts(),
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      latestCodingRunId: null,
    });
    expect(result.allRequiredPassed).toBe(false);
  });

  it("fail-closed: malformed rule.facets => failed (never passed)", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition({ rule: { facets: "tests/**" } })],
      checks: [facetCheck([])],
      findingCounts: noFindingCounts(),
      changedPaths: ["tests/auth/login.test.ts"],
      latestCodingRunId: "run-close",
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("freshness: a recorded facet check older than freshAfter => pending", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition()],
      checks: [
        facetCheck(
          [
            {
              facetId: "auth-login",
              redTestPath: "tests/auth/login.test.ts",
              redDemonstrated: true,
              runId: "run-close",
            },
          ],
          { checkedAt: "2026-05-01T00:00:00.000Z" },
        ),
      ],
      findingCounts: noFindingCounts(),
      freshAfter: "2026-05-20T00:00:00.000Z",
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      latestCodingRunId: "run-close",
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("fail-closed: changedPaths / latestCodingRunId absent => pending (never passed)", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition()],
      checks: [
        facetCheck([
          {
            facetId: "auth-login",
            redTestPath: "tests/auth/login.test.ts",
            redDemonstrated: true,
            runId: "run-close",
          },
        ]),
      ],
      findingCounts: noFindingCounts(),
    });
    expect(result.allRequiredPassed).toBe(false);
  });

  // P2-1 (#308): a fail-open-shape FAILURE keeps its actionable message even
  // when the only recorded evidence row is STALE. A fail-open shape can be
  // cleared ONLY by adding a covering test, so misdirecting the coder to
  // "record fresh evidence" (the stale-evidence message) would dead-end it.
  it("#308 P2-1: fail-open shape with a STALE prior evidence row keeps the no-covering-test message", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition()],
      checks: [
        facetCheck(
          [
            {
              facetId: "auth-login",
              redTestPath: "tests/auth/login.test.ts",
              redDemonstrated: true,
              runId: "run-prior",
            },
          ],
          { checkedAt: "2026-05-01T00:00:00.000Z" },
        ),
      ],
      findingCounts: noFindingCounts(),
      freshAfter: "2026-05-20T00:00:00.000Z",
      // Newest coding run touched the production surface but changed NO test.
      changedPaths: ["src/auth/login.ts"],
      latestCodingRunId: "run-close",
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.conditions[0]?.status).toBe("failed");
    expect(result.conditions[0]?.message).toMatch(/no covering test/i);
    expect(result.conditions[0]?.message).not.toMatch(/stale|record fresh/i);
  });

  // The evidence-recoverable case (covering test present, no fresh evidence yet)
  // still emits the stale/record-evidence message — recording RED evidence CAN
  // clear it, so the operator/runner guidance is correct there.
  it("#308 P2-1: test-present-no-fresh-evidence keeps the stale/record-evidence message", () => {
    const result = evaluateCloseConditions({
      conditions: [facetCondition()],
      checks: [
        facetCheck(
          [
            {
              facetId: "auth-login",
              redTestPath: "tests/auth/login.test.ts",
              redDemonstrated: true,
              runId: "run-prior",
            },
          ],
          { checkedAt: "2026-05-01T00:00:00.000Z" },
        ),
      ],
      findingCounts: noFindingCounts(),
      freshAfter: "2026-05-20T00:00:00.000Z",
      // Covering test changed in the newest run, but the evidence row is stale.
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      latestCodingRunId: "run-close",
    });
    expect(result.requiredPending).toBe(1);
    expect(result.conditions[0]?.message).toMatch(/stale|record fresh/i);
  });

  // P2 (#308, App): a CODE-recoverable facet pending (no covering test present,
  // reasonCode `no_change`) that has a STALE prior check row must STILL surface
  // the actionable "no covering test" message — never the record-evidence/stale
  // message — because recording evidence can NEVER satisfy it. Same root as
  // P2-1, but the disposition is code_recoverable (not fail_open_shape).
  it("#308: code-recoverable pending with a STALE prior check row keeps the covering-test message", () => {
    const result = evaluateCloseConditions({
      // No changedFileGlobs → an unrelated change yields a `no_change` pending.
      conditions: [
        facetCondition({
          rule: {
            facets: [{ id: "auth-login", testGlobs: ["tests/auth/**"] }],
          },
        }),
      ],
      checks: [
        facetCheck(
          [
            {
              facetId: "auth-login",
              redTestPath: "tests/auth/login.test.ts",
              redDemonstrated: true,
              runId: "run-prior",
            },
          ],
          { checkedAt: "2026-05-01T00:00:00.000Z" },
        ),
      ],
      findingCounts: noFindingCounts(),
      freshAfter: "2026-05-20T00:00:00.000Z",
      // Newest coding run touched neither the test nor a production surface.
      changedPaths: ["src/billing/charge.ts"],
      latestCodingRunId: "run-close",
    });
    expect(result.requiredPending).toBe(1);
    expect(result.conditions[0]?.status).toBe("pending");
    expect(result.conditions[0]?.facetPendingDisposition).toBe(
      "code_recoverable",
    );
    expect(result.conditions[0]?.message).toMatch(/no covering test/i);
    expect(result.conditions[0]?.message).not.toMatch(/stale|record fresh/i);
  });
});

describe("opt-in invariance (#279)", () => {
  it("a condition set WITHOUT facet_red_test is byte-identical with/without new params", () => {
    const conditions = [
      condition({}),
      condition({
        id: "finding-policy",
        kind: "finding_policy",
        rule: { maxOpenInScopeP1: 0 },
      }),
    ];
    const checks = [check({ status: "passed" })];
    const baseline = evaluateCloseConditions({
      conditions,
      checks,
      findingCounts: noFindingCounts(),
    });
    const withNewParams = evaluateCloseConditions({
      conditions,
      checks,
      findingCounts: noFindingCounts(),
      changedPaths: ["src/auth/login.ts"],
      latestCodingRunId: "run-close",
    });
    expect(withNewParams).toEqual(baseline);
  });
});
