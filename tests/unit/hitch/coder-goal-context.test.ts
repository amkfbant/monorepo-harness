import { describe, expect, it } from "vitest";
import {
  augmentGoalWithFailedCloseChecks,
  augmentGoalWithFailedRun,
  augmentGoalWithOpenFindings,
  closeCheckFailureContexts,
} from "../../../src/hitch/coder-goal-context.js";
import {
  evaluateCloseConditions,
  type EvaluatedCloseCondition,
} from "../../../src/hitch/close-checks.js";
import type {
  HitchCloseCheck,
  HitchCloseCondition,
  HitchFinding,
} from "../../../src/hitch/types.js";

function mkFinding(partial: Partial<HitchFinding>): HitchFinding {
  return {
    findingId: "f1",
    hitchId: "g1",
    stableKey: "k1",
    duplicateOf: null,
    source: "review",
    sourceRef: null,
    sourceAttemptId: null,
    sourceCycleId: null,
    severity: "P1",
    category: "bug",
    scopeStatus: "in_scope",
    lifecycleStatus: "open",
    summary: "a finding",
    detail: null,
    filePath: null,
    symbol: null,
    suggestedFix: null,
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    fixedAt: null,
    deferredAt: null,
    escalatedAt: null,
    reopenCount: 0,
    deferredBacklogItemId: null,
    classificationReason: null,
    resolutionNote: null,
    ...partial,
  };
}

describe("augmentGoalWithOpenFindings", () => {
  it("returns the goal unchanged when there are no findings (first implement pass)", () => {
    expect(augmentGoalWithOpenFindings("do the thing", [])).toBe("do the thing");
  });

  it("appends a findings block with severity + summary bullets", () => {
    const out = augmentGoalWithOpenFindings("do the thing", [
      mkFinding({ findingId: "f1", severity: "P1", summary: "missing null check" }),
      mkFinding({ findingId: "f2", severity: "P2", summary: "rename var" }),
    ]);
    expect(out.startsWith("do the thing")).toBe(true);
    expect(out).toContain("Open in-scope findings to address");
    expect(out).toContain("- (P1) missing null check");
    expect(out).toContain("- (P2) rename var");
  });

  it("includes file path / symbol and suggested fix when present", () => {
    const out = augmentGoalWithOpenFindings("g", [
      mkFinding({
        summary: "leak",
        filePath: "src/a.ts",
        symbol: "foo",
        suggestedFix: "close the handle",
      }),
    ]);
    expect(out).toContain("[src/a.ts:foo]");
    expect(out).toContain("suggested fix: close the handle");
  });

  it("caps the number of injected findings and notes the remainder (no silent truncation)", () => {
    const many = Array.from({ length: 30 }, (_unused, i) =>
      mkFinding({ findingId: `f${i}`, summary: `finding ${i}` }),
    );
    const out = augmentGoalWithOpenFindings("g", many, 25);
    expect(out).toContain("finding 24");
    expect(out).not.toContain("finding 25");
    expect(out).toContain("and 5 more open in-scope finding");
  });

  it("does not mutate the input goal string", () => {
    const goal = "original";
    const out = augmentGoalWithOpenFindings(goal, [mkFinding({})]);
    expect(goal).toBe("original");
    expect(out).not.toBe(goal);
  });
});

describe("augmentGoalWithFailedRun", () => {
  it("returns the goal unchanged when there is no failure to report", () => {
    expect(augmentGoalWithFailedRun("do the thing", "")).toBe("do the thing");
    expect(augmentGoalWithFailedRun("do the thing", "   ")).toBe("do the thing");
  });

  it("appends a failure note naming the previous run status", () => {
    const out = augmentGoalWithFailedRun("do the thing", "failed-command");
    expect(out.startsWith("do the thing")).toBe(true);
    expect(out).toContain("Previous attempt failed");
    expect(out).toContain("`failed-command`");
  });
});

function reqCondition(
  overrides: Partial<HitchCloseCondition> = {},
): HitchCloseCondition {
  return { id: "c", kind: "command", required: true, ...overrides };
}

describe("closeCheckFailureContexts (#279 P2 coder feedback)", () => {
  it("includes an evidence-INDEPENDENT facet fail-open-shape failure (no check row) and carries its message", () => {
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({ id: "facet-red", kind: "facet_red_test" }),
        status: "failed",
        check: null, // fail-open-shape failures have NO recorded check row
        message:
          "failed: auth-login: production surface changed, no covering test",
      },
    ];
    const contexts = closeCheckFailureContexts(evaluated);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.conditionKind).toBe("facet_red_test");
    expect(contexts[0]?.message).toMatch(/no covering test/i);

    // The fail-open explanation reaches the next coder prompt.
    const goal = augmentGoalWithFailedCloseChecks("rerun goal", contexts);
    expect(goal).toContain("auth-login");
    expect(goal).toContain("production surface changed, no covering test");
  });

  it("still drops a non-facet failed condition that has NO recorded check row", () => {
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({ id: "typecheck", kind: "command" }),
        status: "failed",
        check: null,
        message: "no actionable detail",
      },
    ];
    expect(closeCheckFailureContexts(evaluated)).toHaveLength(0);
  });

  // NON-facet path: a recorded failure detail is the right coder feedback, so
  // a present `check.message` is preferred over the evaluator message. (#308
  // keeps this for non-facet conditions; facet conditions use the re-derived
  // evaluator message instead — see the facet stale-message tests below.)
  it("prefers the recorded check message over the evaluator message for a NON-facet condition with a row", () => {
    const check: HitchCloseCheck = {
      checkId: "chk-1",
      hitchId: "g1",
      conditionId: "typecheck",
      status: "failed",
      checkedAt: "2026-01-01T00:00:00Z",
      checkedBy: "runner",
      evidence: {},
      message: "recorded check message",
    };
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({ id: "typecheck", kind: "command" }),
        status: "failed",
        check,
        message: "evaluator message",
      },
    ];
    expect(closeCheckFailureContexts(evaluated)[0]?.message).toBe(
      "recorded check message",
    );
  });

  // #308 (App P2): a FAILED fail-open-shape facet_red_test with a STALE prior
  // check row (e.g. an old "record fresh RED evidence" recording) must inject
  // the evaluator's CURRENT actionable "no covering test" message into the coder
  // goal — NOT the stale check.message. The evaluator re-derives the message
  // from current run_changed_files on every evaluation, so it is authoritative
  // for facets; the recorded row can be stale/misleading.
  it("#308: FAILED fail-open-shape facet with a STALE check row injects the evaluator covering-test message, not the stale one", () => {
    const staleCheck: HitchCloseCheck = {
      checkId: "chk-stale",
      hitchId: "g1",
      conditionId: "facet-red",
      status: "passed",
      checkedAt: "2026-01-01T00:00:00Z",
      checkedBy: "runner",
      evidence: {},
      message:
        "facet_red_test: recorded evidence is stale; record fresh RED evidence after latest mutation",
    };
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({ id: "facet-red", kind: "facet_red_test" }),
        status: "failed",
        check: staleCheck,
        message:
          "failed: auth-login: production surface changed, no covering test",
      },
    ];
    const contexts = closeCheckFailureContexts(evaluated);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.message).toMatch(/no covering test/i);
    expect(contexts[0]?.message).not.toMatch(/record fresh RED evidence/i);

    const goal = augmentGoalWithFailedCloseChecks("rerun goal", contexts);
    expect(goal).toContain("production surface changed, no covering test");
    expect(goal).not.toContain("record fresh RED evidence");
  });

  it("ignores optional and non-failed conditions", () => {
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({
          id: "facet-opt",
          kind: "facet_red_test",
          required: false,
        }),
        status: "failed",
        check: null,
        message: "x",
      },
      {
        condition: reqCondition({ id: "facet-pending", kind: "facet_red_test" }),
        status: "pending",
        check: null,
        message: "y",
      },
    ];
    expect(closeCheckFailureContexts(evaluated)).toHaveLength(0);
  });

  // #308 P2-2 coder feedback: a code-recoverable PENDING facet routes to the
  // coder, so its actionable "add a covering test" message must reach the coder
  // goal — otherwise the coder reruns blind and burns bounded iterations.
  it("#308 P2-2: includes a code-recoverable PENDING facet and carries its covering-test message", () => {
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({ id: "facet-red", kind: "facet_red_test" }),
        status: "pending",
        check: null,
        message:
          "pending: auth-login: no covering test changed and no production surface touched",
        facetPendingDisposition: "code_recoverable",
      },
    ];
    const contexts = closeCheckFailureContexts(evaluated);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.conditionId).toBe("facet-red");
    expect(contexts[0]?.conditionKind).toBe("facet_red_test");
    expect(contexts[0]?.message).toMatch(/covering test/i);

    const goal = augmentGoalWithFailedCloseChecks("rerun goal", contexts);
    expect(goal).toContain("facet-red");
    expect(goal).toContain("covering test");
  });

  // #308 (App P2): a code-recoverable facet pending may carry a STALE prior
  // check row whose recorded message is misleading (e.g. an old "passed" /
  // record-evidence message). The coder goal must carry the evaluator's CURRENT
  // actionable covering-test message, NOT the stale check.message — otherwise
  // the coder is misdirected to record evidence that can never satisfy it.
  it("#308: code-recoverable pending prefers the evaluator message over a STALE check row message", () => {
    const staleCheck: HitchCloseCheck = {
      checkId: "chk-stale",
      hitchId: "g1",
      conditionId: "facet-red",
      status: "passed",
      checkedAt: "2026-05-01T00:00:00Z",
      checkedBy: "runner",
      evidence: {},
      message:
        "facet_red_test: recorded evidence is stale; record fresh RED evidence after latest mutation",
    };
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({ id: "facet-red", kind: "facet_red_test" }),
        status: "pending",
        check: staleCheck,
        message:
          "pending: auth-login: no covering test changed and no production surface touched",
        facetPendingDisposition: "code_recoverable",
      },
    ];
    const contexts = closeCheckFailureContexts(evaluated);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.message).toMatch(/no covering test/i);
    expect(contexts[0]?.message).not.toMatch(/record fresh RED evidence/i);

    const goal = augmentGoalWithFailedCloseChecks("rerun goal", contexts);
    expect(goal).toContain("no covering test");
    expect(goal).not.toContain("record fresh RED evidence");
  });

  // Guard (don't over-inject): an EVIDENCE-recoverable pending facet routes to
  // ask_human (record evidence), NOT the coder — it must NOT be injected into
  // the coder goal.
  it("#308 P2-2 guard: does NOT include an evidence-recoverable PENDING facet", () => {
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({ id: "facet-ev", kind: "facet_red_test" }),
        status: "pending",
        check: null,
        message: "pending: needs RED evidence",
        facetPendingDisposition: "evidence_recoverable",
      },
    ];
    expect(closeCheckFailureContexts(evaluated)).toHaveLength(0);
  });

  // Guard: a pending NON-facet condition (e.g. an external-evidence manual
  // condition) is never injected even if it somehow carried a disposition.
  it("#308 P2-2 guard: does NOT include a pending non-facet condition", () => {
    const evaluated: EvaluatedCloseCondition[] = [
      {
        condition: reqCondition({ id: "manual-check", kind: "manual" }),
        status: "pending",
        check: null,
        message: "needs external evidence",
      },
    ];
    expect(closeCheckFailureContexts(evaluated)).toHaveLength(0);
  });

  // End-to-end through the SAME pipeline the orchestrator's
  // `failedRequiredCloseChecks` uses (real `evaluateCloseConditions` →
  // `closeCheckFailureContexts` → `augmentGoalWithFailedCloseChecks`): a
  // code-recoverable pending facet (no covering test present) reaches the coder
  // rerun goal with its covering-test instruction; an evidence-recoverable
  // pending (covering test present, evidence missing) does NOT.
  it("#308 P2-2 e2e: real evaluator → code-recoverable pending facet reaches the coder goal", () => {
    const codeRecoverable = evaluateCloseConditions({
      conditions: [
        {
          id: "facet-red",
          kind: "facet_red_test",
          required: true,
          // No changedFileGlobs: the run touches neither the test nor a
          // production surface → no_change pending → code-recoverable.
          rule: { facets: [{ id: "auth-login", testGlobs: ["tests/auth/**"] }] },
        },
      ],
      checks: [],
      findingCounts: {
        openInScopeP0: 0,
        openInScopeP1: 0,
        openInScopeP2: 0,
        openUnknownScope: 0,
      },
      changedPaths: ["src/billing/charge.ts"],
      latestCodingRunId: "run-close",
    });
    expect(codeRecoverable.conditions[0]?.status).toBe("pending");
    expect(codeRecoverable.conditions[0]?.facetPendingDisposition).toBe(
      "code_recoverable",
    );
    const contexts = closeCheckFailureContexts(codeRecoverable.conditions);
    expect(contexts).toHaveLength(1);
    const goal = augmentGoalWithFailedCloseChecks("rerun goal", contexts);
    expect(goal).toContain("facet-red");
    expect(goal).toContain("covering test");

    const evidenceRecoverable = evaluateCloseConditions({
      conditions: [
        {
          id: "facet-red",
          kind: "facet_red_test",
          required: true,
          rule: {
            facets: [
              {
                id: "auth-login",
                testGlobs: ["tests/auth/**"],
                changedFileGlobs: ["src/auth/**"],
              },
            ],
          },
        },
      ],
      checks: [],
      findingCounts: {
        openInScopeP0: 0,
        openInScopeP1: 0,
        openInScopeP2: 0,
        openUnknownScope: 0,
      },
      // Covering test changed but no evidence recorded → evidence-recoverable.
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      latestCodingRunId: "run-close",
    });
    expect(evidenceRecoverable.conditions[0]?.status).toBe("pending");
    expect(evidenceRecoverable.conditions[0]?.facetPendingDisposition).toBe(
      "evidence_recoverable",
    );
    expect(
      closeCheckFailureContexts(evidenceRecoverable.conditions),
    ).toHaveLength(0);
  });
});

describe("augmentGoalWithFailedCloseChecks", () => {
  it("returns the goal unchanged when there are no failed checks", () => {
    expect(augmentGoalWithFailedCloseChecks("do the thing", [])).toBe(
      "do the thing",
    );
  });

  it("appends failed command evidence with stdout and stderr excerpts", () => {
    const out = augmentGoalWithFailedCloseChecks("do the thing", [
      {
        conditionId: "typecheck",
        conditionKind: "command",
        command: "npm run typecheck",
        exitCode: 2,
        timedOut: false,
        message: "command close-check failed",
        stdout: "tsc stdout",
        stderr: "src/a.ts(1,1): error TS1005",
      },
    ]);

    expect(out.startsWith("do the thing")).toBe(true);
    expect(out).toContain("Failed close-check evidence to address");
    expect(out).toContain("typecheck");
    expect(out).toContain("npm run typecheck");
    expect(out).toContain("exitCode=2");
    expect(out).toContain("stdout:");
    expect(out).toContain("tsc stdout");
    expect(out).toContain("stderr:");
    expect(out).toContain("error TS1005");
  });

  it("withholds the whole stream when secret-shaped content is present (fail-closed)", () => {
    const out = augmentGoalWithFailedCloseChecks("do the thing", [
      {
        conditionId: "typecheck",
        conditionKind: "command",
        command: "npm run typecheck",
        exitCode: 1,
        timedOut: false,
        stdout: "harmless line\nAWS_KEY=AKIAIOSFODNN7EXAMPLE\nanother harmless line",
        stderr: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 leaked",
      },
    ]);

    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out).toContain("close-check output withheld");
  });

  it("withholds a MULTI-LINE secret (PEM key) entirely, not just the header line", () => {
    const pem = [
      "starting checks",
      "-----BEGIN PRIVATE KEY-----",
      "MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA0secretbodyline",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const out = augmentGoalWithFailedCloseChecks("g", [
      {
        conditionId: "typecheck",
        conditionKind: "command",
        command: "npm run typecheck",
        exitCode: 1,
        stdout: pem,
      },
    ]);

    // No part of the key body or END marker may survive.
    expect(out).not.toContain("MIIBVwIBADANBgkqhkiG");
    expect(out).not.toContain("END PRIVATE KEY");
    expect(out).toContain("close-check output withheld");
  });

  it("preserves non-secret output for the coder", () => {
    const out = augmentGoalWithFailedCloseChecks("g", [
      {
        conditionId: "typecheck",
        conditionKind: "command",
        command: "npm run typecheck",
        exitCode: 2,
        stdout: "src/a.ts(1,1): error TS1005: ';' expected.",
      },
    ]);
    expect(out).toContain("error TS1005");
  });

  it("withholds a NAME-BASED secret (no vendor prefix) — broadened scanner", () => {
    // No AKIA…/ghp_…/sk-… prefix; only the assignment shape gives it away.
    const out = augmentGoalWithFailedCloseChecks("g", [
      {
        conditionId: "typecheck",
        conditionKind: "command",
        command: "npm run typecheck",
        exitCode: 1,
        stdout:
          "config loaded\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIbKxyzzzzzz0123456789ABCDEFG\ndone",
        stderr: "api_key: hunter2longvaluethatlookssecret",
      },
    ]);
    expect(out).not.toContain("wJalrXUtnFEMIbKxyzzzzzz0123456789ABCDEFG");
    expect(out).not.toContain("hunter2longvaluethatlookssecret");
    expect(out).toContain("close-check output withheld");
  });

  it("withholds a secret in the COMMAND free-text field (not just stdout/stderr)", () => {
    const out = augmentGoalWithFailedCloseChecks("g", [
      {
        conditionId: "deploy",
        conditionKind: "command",
        command: "deploy --token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        exitCode: 1,
        stdout: "plain failure",
      },
    ]);
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out).toContain("command: [redacted]");
    // non-secret stdout still flows through.
    expect(out).toContain("plain failure");
  });

  it("withholds a secret in the MESSAGE free-text field", () => {
    const out = augmentGoalWithFailedCloseChecks("g", [
      {
        conditionId: "auth",
        conditionKind: "command",
        command: "npm run check",
        exitCode: 1,
        message: "failed with Authorization: Bearer abcdef0123456789TOKEN",
      },
    ]);
    expect(out).not.toContain("abcdef0123456789TOKEN");
    expect(out).toContain("message: [redacted]");
  });
});
