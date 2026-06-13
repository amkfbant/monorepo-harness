import { describe, expect, it } from "vitest";
import {
  augmentGoalWithFailedCloseChecks,
  augmentGoalWithFailedRun,
  augmentGoalWithOpenFindings,
} from "../../../src/hitch/coder-goal-context.js";
import type { HitchFinding } from "../../../src/hitch/types.js";

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
