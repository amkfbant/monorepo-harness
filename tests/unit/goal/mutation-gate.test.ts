import { describe, expect, it } from "vitest";
import { allowedByConvergence } from "../../../src/goal/mutation-gate.js";
import type { GoalLinkedMutationKind } from "../../../src/goal/mutation-gate.js";
import type {
  GoalConvergenceDecision,
  GoalConvergenceResult,
  GoalNextActionKind,
} from "../../../src/goal/types.js";
import {
  GOAL_CONVERGENCE_DECISIONS,
  GOAL_NEXT_ACTION_KINDS,
} from "../../../src/goal/types.js";

const ALL_MUTATIONS: GoalLinkedMutationKind[] = [
  "run.start",
  "review.auto",
  "rerun.start",
  "review.process",
];

function convergence(
  decision: GoalConvergenceDecision,
  actionKind: GoalNextActionKind,
): GoalConvergenceResult {
  return {
    goalId: "goal-1",
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
  "continue|run_close_check|review.auto",
  "continue|run_close_check|review.process",
]);

describe("allowedByConvergence — permit matrix is fail-closed", () => {
  it("permits exactly the documented (decision, action, mutation) combinations", () => {
    for (const decision of GOAL_CONVERGENCE_DECISIONS) {
      for (const actionKind of GOAL_NEXT_ACTION_KINDS) {
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
    const denyAll: GoalConvergenceDecision[] = [
      "close_ready",
      "closed",
      "cancel",
      "diverging",
      "budget_exhausted",
      "escalate",
      "needs_classification",
    ];
    for (const decision of denyAll) {
      for (const actionKind of GOAL_NEXT_ACTION_KINDS) {
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
});

// (#83) The MCP `harness.goal.orchestrate` driver is permitted exactly when the
// loop has a permitted autonomous next step — i.e. when SOME per-step mutation
// would be allowed. Everything else (close_ready, terminal, defer/classify) must
// require an operator, so the driver is denied.
const ORCHESTRATE_PERMITTED = new Set<string>([
  "needs_fix|fix_findings",
  "needs_fix|run_close_check",
  "continue|run_close_check",
]);

describe("allowedByConvergence — goal.orchestrate driver is fail-closed", () => {
  it("permits the driver iff a per-step mutation is permitted", () => {
    for (const decision of GOAL_CONVERGENCE_DECISIONS) {
      for (const actionKind of GOAL_NEXT_ACTION_KINDS) {
        const c = convergence(decision, actionKind);
        const anyStepPermitted = ALL_MUTATIONS.some((m) =>
          allowedByConvergence(m, c),
        );
        const expected = ORCHESTRATE_PERMITTED.has(`${decision}|${actionKind}`);
        // the driver gate must agree with "some step is permitted"
        expect(anyStepPermitted, `${decision}|${actionKind} step-permit`).toBe(
          expected,
        );
        expect(
          allowedByConvergence("goal.orchestrate", c),
          `${decision}|${actionKind} orchestrate-permit`,
        ).toBe(expected);
      }
    }
  });

  it("denies the driver at close_ready and every terminal decision", () => {
    const denyAll: GoalConvergenceDecision[] = [
      "close_ready",
      "closed",
      "cancel",
      "diverging",
      "budget_exhausted",
      "escalate",
      "needs_classification",
    ];
    for (const decision of denyAll) {
      for (const actionKind of GOAL_NEXT_ACTION_KINDS) {
        expect(
          allowedByConvergence("goal.orchestrate", convergence(decision, actionKind)),
          `${decision}|${actionKind} must deny orchestrate`,
        ).toBe(false);
      }
    }
  });

  it("denies the driver under continue + defer_followups (operator must defer)", () => {
    expect(
      allowedByConvergence("goal.orchestrate", convergence("continue", "defer_followups")),
    ).toBe(false);
  });
});
