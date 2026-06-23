import { describe, expect, it } from "vitest";
import { evaluateCloseConditions } from "../../../src/hitch/close-checks.js";
import type {
  EvidenceAttester,
  HitchCloseCheck,
  HitchCloseCondition,
  HitchEvidence,
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

function evidenceCondition(
  overrides: Partial<HitchCloseCondition> = {},
): HitchCloseCondition {
  return condition({
    id: "evidence-gate",
    kind: "evidence_attached",
    ...overrides,
  });
}

function evidenceRow(
  overrides: Partial<HitchEvidence> = {},
): HitchEvidence {
  return {
    evidenceId: "ev-a",
    hitchId: "goal-a",
    runId: null,
    conditionId: "evidence-gate",
    kind: "note",
    attester: "operator",
    label: "manual verification",
    command: null,
    exitCode: null,
    summaryMetrics: {},
    metricsSchema: 1,
    outputExcerpt: null,
    secretSuspect: false,
    redacted: false,
    createdAt: "2026-05-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("evidence_attached close condition", () => {
  it("PASS: one operator row, matching conditionId, no freshAfter => passed", () => {
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition()],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [evidenceRow()],
    });
    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
    expect(result.conditions[0]?.status).toBe("passed");
    expect(result.conditions[0]?.check).toBeNull();
    expect(result.conditions[0]?.message).toMatch(/operator evidence attached/i);
  });

  it("PASS: fresh operator row (createdAt >= freshAfter) => passed", () => {
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition()],
      checks: [],
      findingCounts: noFindingCounts(),
      freshAfter: "2026-05-20T00:00:00.000Z",
      evidenceRows: [evidenceRow({ createdAt: "2026-05-26T00:00:00.000Z" })],
    });
    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("PENDING (fail-closed): evidenceRows omitted entirely => pending", () => {
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition()],
      checks: [],
      findingCounts: noFindingCounts(),
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
    expect(result.conditions[0]?.status).toBe("pending");
    expect(result.conditions[0]?.check).toBeNull();
    expect(result.conditions[0]?.message).toMatch(/no operator evidence/i);
  });

  it("PENDING (fail-closed): no rows at all (empty array) => pending", () => {
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition()],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [],
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("PENDING: row exists but conditionId differs (unrelated evidence) => pending", () => {
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition()],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [evidenceRow({ conditionId: "some-other-condition" })],
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("PENDING: row with non-operator attester does NOT satisfy (re-verify provenance in code)", () => {
    // Simulate a future/forged non-operator row: cast through the union so a
    // value outside EVIDENCE_ATTESTERS can be constructed in the test. The
    // evaluator must re-check attester === "operator" and reject this row even
    // though the DDL CHECK would (today) also reject it.
    const forged = evidenceRow({
      attester: "harness" as unknown as EvidenceAttester,
    });
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition()],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [forged],
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("PENDING: only matching row is stale (createdAt < freshAfter) => pending", () => {
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition()],
      checks: [],
      findingCounts: noFindingCounts(),
      freshAfter: "2026-05-20T00:00:00.000Z",
      evidenceRows: [evidenceRow({ createdAt: "2026-05-01T00:00:00.000Z" })],
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
    expect(result.conditions[0]?.message).toMatch(/stale/i);
  });

  it("PENDING: rule.kind set but row.kind differs => pending", () => {
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition({ rule: { kind: "metrics" } })],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [evidenceRow({ kind: "note" })],
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("PENDING: requiredMetricKeys set but a key is missing => pending", () => {
    const result = evaluateCloseConditions({
      conditions: [
        evidenceCondition({ rule: { requiredMetricKeys: ["p95", "rps"] } }),
      ],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [
        evidenceRow({ kind: "metrics", summaryMetrics: { p95: 120 } }),
      ],
    });
    expect(result.requiredPending).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("PASS: rule.kind + requiredMetricKeys both satisfied => passed", () => {
    const result = evaluateCloseConditions({
      conditions: [
        evidenceCondition({
          rule: { kind: "metrics", requiredMetricKeys: ["p95", "rps"] },
        }),
      ],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [
        evidenceRow({
          kind: "metrics",
          summaryMetrics: { p95: 120, rps: 8000 },
        }),
      ],
    });
    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("FAILED: malformed rule — kind not in HITCH_EVIDENCE_KINDS => failed", () => {
    const result = evaluateCloseConditions({
      conditions: [evidenceCondition({ rule: { kind: "bogus" } })],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [evidenceRow()],
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
    expect(result.conditions[0]?.status).toBe("failed");
    expect(result.conditions[0]?.message).toMatch(/malformed evidence_attached/i);
  });

  it("FAILED: malformed rule — requiredMetricKeys not a string array => failed", () => {
    const result = evaluateCloseConditions({
      conditions: [
        evidenceCondition({ rule: { requiredMetricKeys: "p95" } }),
      ],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [evidenceRow()],
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("FAILED: malformed rule — requiredMetricKeys contains an empty string => failed", () => {
    const result = evaluateCloseConditions({
      conditions: [
        evidenceCondition({ rule: { requiredMetricKeys: ["p95", ""] } }),
      ],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [evidenceRow()],
    });
    expect(result.requiredFailed).toBe(1);
    expect(result.allRequiredPassed).toBe(false);
  });

  it("forward-compat: unknown rule keys are ignored, not errors", () => {
    const result = evaluateCloseConditions({
      conditions: [
        evidenceCondition({ rule: { kind: "note", futureKey: 42 } }),
      ],
      checks: [],
      findingCounts: noFindingCounts(),
      evidenceRows: [evidenceRow({ kind: "note" })],
    });
    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });
});

describe("evidence_attached gate invariance", () => {
  it("an existing condition mix evaluates byte-identically with/without evidenceRows", () => {
    // finding_policy + facet_red_test (pending) + recorded-check `manual`.
    const conditions: HitchCloseCondition[] = [
      condition({
        id: "finding-policy",
        kind: "finding_policy",
        rule: { maxOpenInScopeP1: 0 },
      }),
      facetCondition(),
      condition({ id: "manual-gate", kind: "manual" }),
    ];
    const checks = [
      check({
        checkId: "manual-check",
        conditionId: "manual-gate",
        status: "passed",
      }),
    ];
    const sharedInput = {
      conditions,
      checks,
      findingCounts: noFindingCounts(),
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      latestCodingRunId: "run-close",
    } as const;
    const baseline = evaluateCloseConditions({ ...sharedInput });
    const withEvidence = evaluateCloseConditions({
      ...sharedInput,
      evidenceRows: [
        evidenceRow({ conditionId: "manual-gate", kind: "note" }),
        evidenceRow({ conditionId: "finding-policy", kind: "metrics" }),
      ],
    });
    expect(withEvidence).toEqual(baseline);
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
