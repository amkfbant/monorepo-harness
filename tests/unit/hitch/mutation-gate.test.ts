import { describe, expect, it } from "vitest";
import { allowedByConvergence } from "../../../src/hitch/mutation-gate.js";
import type { HitchLinkedMutationKind } from "../../../src/hitch/mutation-gate.js";
import type {
  HitchConvergenceDecision,
  HitchConvergenceResult,
  HitchNextActionKind,
} from "../../../src/hitch/types.js";
import {
  HITCH_CONVERGENCE_DECISIONS,
  HITCH_NEXT_ACTION_KINDS,
} from "../../../src/hitch/types.js";

const ALL_MUTATIONS: HitchLinkedMutationKind[] = [
  "run.start",
  "review.auto",
  "rerun.start",
  "review.process",
];

function convergence(
  decision: HitchConvergenceDecision,
  actionKind: HitchNextActionKind,
): HitchConvergenceResult {
  return {
    hitchId: "goal-1",
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
    recommendedNextAction: { kind: actionKind, message: "test" },
  };
}

// The only two permitted (decision, nextAction, mutation) combinations. Every
// other combination must be denied — this is the fail-closed contract.
const PERMITTED = new Set<string>([
  "needs_fix|fix_findings|run.start",
  "needs_fix|fix_findings|rerun.start",
  "needs_fix|run_close_check|run.start",
  "needs_fix|run_close_check|rerun.start",
  "continue|run_review|review.auto",
  "continue|run_review|review.process",
]);

describe("allowedByConvergence — permit matrix is fail-closed", () => {
  it("permits exactly the documented (decision, action, mutation) combinations", () => {
    for (const decision of HITCH_CONVERGENCE_DECISIONS) {
      for (const actionKind of HITCH_NEXT_ACTION_KINDS) {
        for (const mutation of ALL_MUTATIONS) {
          const key = `${decision}|${actionKind}|${mutation}`;
          const expected = PERMITTED.has(key);
          expect(
            allowedByConvergence(mutation, convergence(decision, actionKind)),
            `${key} should be ${expected ? "allowed" : "denied"}`,
          ).toBe(expected);
        }
      }
    }
  });

  it("denies every mutation for terminal / unsafe decisions regardless of action", () => {
    const denyAll: HitchConvergenceDecision[] = [
      "close_ready",
      "closed",
      "cancel",
      "diverging",
      "budget_exhausted",
      "escalate",
      "needs_classification",
    ];
    for (const decision of denyAll) {
      for (const actionKind of HITCH_NEXT_ACTION_KINDS) {
        for (const mutation of ALL_MUTATIONS) {
          expect(
            allowedByConvergence(mutation, convergence(decision, actionKind)),
            `${decision}|${actionKind}|${mutation} must be denied`,
          ).toBe(false);
        }
      }
    }
  });

  it("denies continue + defer_followups (no close check pending)", () => {
    for (const mutation of ALL_MUTATIONS) {
      expect(
        allowedByConvergence(mutation, convergence("continue", "defer_followups")),
      ).toBe(false);
    }
  });

  it("does not permit review mutations under needs_fix", () => {
    expect(allowedByConvergence("review.auto", convergence("needs_fix", "fix_findings"))).toBe(false);
    expect(
      allowedByConvergence("review.process", convergence("needs_fix", "run_close_check")),
    ).toBe(false);
  });

  it("does not permit run mutations under continue", () => {
    expect(allowedByConvergence("run.start", convergence("continue", "run_close_check"))).toBe(false);
    expect(allowedByConvergence("rerun.start", convergence("continue", "run_close_check"))).toBe(false);
  });

  it("does not permit review mutations for command close-check execution", () => {
    expect(allowedByConvergence("review.auto", convergence("continue", "run_close_check"))).toBe(false);
    expect(allowedByConvergence("review.process", convergence("continue", "run_close_check"))).toBe(false);
  });
});

// (#83) The MCP `harness.hitch.orchestrate` driver is permitted exactly when the
// loop has a permitted autonomous next step. Some steps are guarded mutations
// (fix/review), while command close checks are internal deterministic dispatch.
// Everything else (close_ready, terminal, defer/classify) must require an
// operator, so the driver is denied.
const ORCHESTRATE_PERMITTED = new Set<string>([
  "needs_fix|fix_findings",
  "needs_fix|run_close_check",
  "continue|run_review",
  "continue|run_close_check",
]);

describe("allowedByConvergence — hitch.orchestrate driver is fail-closed", () => {
  it("permits the driver for autonomous fix, review, and command close-check steps", () => {
    for (const decision of HITCH_CONVERGENCE_DECISIONS) {
      for (const actionKind of HITCH_NEXT_ACTION_KINDS) {
        const c = convergence(decision, actionKind);
        const expected = ORCHESTRATE_PERMITTED.has(`${decision}|${actionKind}`);
        expect(
          allowedByConvergence("hitch.orchestrate", c),
          `${decision}|${actionKind} orchestrate-permit`,
        ).toBe(expected);
      }
    }
  });

  it("denies the driver at close_ready and every terminal decision", () => {
    const denyAll: HitchConvergenceDecision[] = [
      "close_ready",
      "closed",
      "cancel",
      "diverging",
      "budget_exhausted",
      "escalate",
      "needs_classification",
    ];
    for (const decision of denyAll) {
      for (const actionKind of HITCH_NEXT_ACTION_KINDS) {
        expect(
          allowedByConvergence("hitch.orchestrate", convergence(decision, actionKind)),
          `${decision}|${actionKind} must deny orchestrate`,
        ).toBe(false);
      }
    }
  });

  it("denies the driver under continue + defer_followups (operator must defer)", () => {
    expect(
      allowedByConvergence("hitch.orchestrate", convergence("continue", "defer_followups")),
    ).toBe(false);
  });
});
