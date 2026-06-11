import { describe, it, expect } from "vitest";
import { derivePhaseReadiness } from "../../../src/roadmap/ready-to-close.js";
import type { HitchConvergenceResult } from "../../../src/hitch/types.js";

function conv(decision: HitchConvergenceResult["decision"]): HitchConvergenceResult {
  return {
    hitchId: "h",
    decision,
    reason: "",
    metrics: {
      openInScopeP0: 0, openInScopeP1: 0, openInScopeP2: 0, openUnknownScope: 0,
      openOutOfScope: 0, totalNewFindings: 0, newFindingsThisCycle: 0,
      reviewCyclesUsed: 0, iterationsUsed: 0, rerunsUsed: 0,
      closeConditionsPassed: 0, closeConditionsFailed: 0, closeConditionsPending: 0,
      maxReopenCount: 0,
    },
    recommendedNextAction: { kind: "close_hitch", message: "" },
  };
}

describe("derivePhaseReadiness", () => {
  it("false when the phase has no hitches", () => {
    expect(derivePhaseReadiness({ hitchConvergences: [], derivedOpenP0: 0, derivedOpenP1: 0 })).toBe(false);
  });
  it("true when all hitches are close_ready/closed and 0 open P0/P1", () => {
    expect(derivePhaseReadiness({
      hitchConvergences: [conv("close_ready"), conv("closed")], derivedOpenP0: 0, derivedOpenP1: 0,
    })).toBe(true);
  });
  it("false when any hitch is not close_ready/closed", () => {
    expect(derivePhaseReadiness({
      hitchConvergences: [conv("close_ready"), conv("needs_fix")], derivedOpenP0: 0, derivedOpenP1: 0,
    })).toBe(false);
  });
  it("false when there are open in-scope P0/P1 (defense-in-depth)", () => {
    expect(derivePhaseReadiness({
      hitchConvergences: [conv("close_ready")], derivedOpenP0: 1, derivedOpenP1: 0,
    })).toBe(false);
  });
});
