import { describe, expect, it } from "vitest";
import { nextReviewMode, reviewModePurpose } from "../../../src/hitch/review-mode.js";
import type { HitchReviewCycle, HitchSession } from "../../../src/hitch/types.js";
import { DEFAULT_HITCH_POLICY } from "../../../src/hitch/types.js";

function session(sequence = DEFAULT_HITCH_POLICY.reviewModeSequence): HitchSession {
  return {
    hitchId: "goal-a",
    title: "Goal",
    description: null,
    projectId: null,
    repoId: null,
    domain: null,
    backlogItemId: null,
    status: "open",
    scope: {},
    closeConditions: [],
    policy: { ...DEFAULT_HITCH_POLICY, reviewModeSequence: sequence },
    maxIterations: 3,
    maxReviewCycles: 3,
    maxReruns: 2,
    maxTotalNewFindings: 12,
    currentIteration: 0,
    currentReviewCycle: 0,
    createdBy: "test",
    createdSource: "cli",
    createdAt: "t",
    updatedAt: "t",
    closedAt: null,
    closeSummary: null,
    escalationReason: null,
  };
}

function cycle(n: number): HitchReviewCycle {
  return {
    cycleId: `cycle-${n}`,
    hitchId: "goal-a",
    cycleNumber: n,
    reviewMode: "initial",
    triggerAttemptId: null,
    sourceReviewId: null,
    sourceRunId: null,
    findingsSeen: 0,
    findingsNew: 0,
    findingsReopened: 0,
    findingsFixed: 0,
    findingsDeferred: 0,
    findingsInScopeOpen: 0,
    createdAt: "t",
    completedAt: "t",
    summary: null,
  };
}

describe("review mode sequence", () => {
  it("selects initial, delta, then close by default", () => {
    const s = session();
    expect(nextReviewMode(s, [])).toBe("initial");
    expect(nextReviewMode(s, [cycle(1)])).toBe("delta");
    expect(nextReviewMode(s, [cycle(1), cycle(2)])).toBe("close");
    expect(nextReviewMode(s, [cycle(1), cycle(2), cycle(3)])).toBe("close");
  });

  it("returns manual for an empty sequence", () => {
    expect(nextReviewMode(session([]), [])).toBe("manual");
  });

  it("documents delta as changed-file focused", () => {
    expect(reviewModePurpose("delta")).toMatch(/changed files/);
  });
});
