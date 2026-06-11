import { describe, expect, it } from "vitest";
import {
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
