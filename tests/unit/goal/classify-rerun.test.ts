import { describe, it, expect } from "vitest";
import { classifyChainDecision } from "../../../src/goal/classify-rerun.js";

describe("classifyChainDecision", () => {
  it("chains a coder rerun only when requested AND the goal now needs_fix", () => {
    expect(classifyChainDecision(true, "needs_fix")).toEqual({ chain: true });
  });

  it("does not chain when --then-rerun was not requested", () => {
    expect(classifyChainDecision(false, "needs_fix")).toEqual({
      chain: false,
      reason: "not_requested",
    });
  });

  it("does not chain when the goal is not needs_fix after classification", () => {
    // e.g. other unknown findings remain (needs_classification) — auto-running
    // the orchestrator would just escalate; or it became close_ready — a classify
    // must not silently open a PR. Either way: do NOT auto-run; let the operator
    // drive `goal orchestrate` deliberately.
    for (const decision of [
      "needs_classification",
      "close_ready",
      "continue",
      "escalate",
      "diverging",
    ]) {
      expect(classifyChainDecision(true, decision)).toEqual({
        chain: false,
        reason: "not_needs_fix",
      });
    }
  });
});
