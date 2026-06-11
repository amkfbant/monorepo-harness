import { describe, expect, it } from "vitest";
import { decideOrchestratorAction } from "../../../src/hitch/orchestrator-dispatch.js";
import type {
  HitchConvergenceDecision,
  HitchConvergenceResult,
  HitchNextActionKind,
} from "../../../src/hitch/types.js";

function conv(
  decision: HitchConvergenceDecision,
  actionKind: HitchNextActionKind,
): HitchConvergenceResult {
  return {
    hitchId: "g1",
    decision,
    reason: "test",
    metrics: {
      openInScopeP0: 0,
      openInScopeP1: 0,
      openInScopeP2: 0,
      openUnknownScope: 0,
      openOutOfScope: 0,
      totalNewFindings: 0,
      newFindingsThisCycle: 0,
      reviewCyclesUsed: 0,
      iterationsUsed: 0,
      rerunsUsed: 0,
      closeConditionsPassed: 0,
      closeConditionsFailed: 0,
      closeConditionsPending: 0,
      maxReopenCount: 0,
    },
    recommendedNextAction: { kind: actionKind, message: "m" },
  };
}

describe("decideOrchestratorAction", () => {
  it("maps needs_fix + fix_findings/run_close_check to coder", () => {
    expect(decideOrchestratorAction(conv("needs_fix", "fix_findings")).kind).toBe("coder");
    expect(decideOrchestratorAction(conv("needs_fix", "run_close_check")).kind).toBe("coder");
  });

  it("escalates needs_fix with an unsupported next action", () => {
    expect(decideOrchestratorAction(conv("needs_fix", "ask_human")).kind).toBe("escalate");
  });

  it("maps continue + run_close_check to review, escalates other continue actions", () => {
    expect(decideOrchestratorAction(conv("continue", "run_close_check")).kind).toBe("review");
    expect(decideOrchestratorAction(conv("continue", "fix_findings")).kind).toBe("escalate");
  });

  it("maps continue + defer_followups to defer", () => {
    expect(decideOrchestratorAction(conv("continue", "defer_followups")).kind).toBe("defer");
  });

  it("maps needs_classification to classify and close_ready to close_and_pr", () => {
    expect(decideOrchestratorAction(conv("needs_classification", "classify_findings")).kind).toBe("classify");
    expect(decideOrchestratorAction(conv("close_ready", "close_hitch")).kind).toBe("close_and_pr");
  });

  it("stops on terminal decisions and escalates unsafe ones", () => {
    expect(decideOrchestratorAction(conv("closed", "close_hitch"))).toEqual({ kind: "stop", outcome: "closed" });
    expect(decideOrchestratorAction(conv("cancel", "ask_human"))).toEqual({ kind: "stop", outcome: "cancelled" });
    for (const d of ["diverging", "budget_exhausted", "escalate"] as const) {
      const a = decideOrchestratorAction(conv(d, "ask_human"));
      expect(a.kind).toBe("escalate");
    }
  });
});
