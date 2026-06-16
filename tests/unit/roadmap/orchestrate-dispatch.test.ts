import { describe, it, expect } from "vitest";
import { decideCoursePhaseAction } from "../../../src/roadmap/orchestrate-dispatch.js";
import type {
  HitchConvergenceDecision,
  HitchConvergenceResult,
} from "../../../src/hitch/types.js";

function conv(
  hitchId: string,
  decision: HitchConvergenceResult["decision"],
  action: HitchConvergenceResult["recommendedNextAction"]["kind"] = "run_close_check",
): HitchConvergenceResult {
  return {
    hitchId,
    decision,
    reason: "",
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
      harnessOriginNewFindings: 0,
      harnessOriginNewFindingsThisCycle: 0,
      harnessOriginMaxReopenCount: 0,
      harnessOriginNewFindingsByCycle: [],
    },
    recommendedNextAction: { kind: action, message: "" },
  };
}

describe("decideCoursePhaseAction", () => {
  it("skip_closed for a declared-closed phase", () => {
    expect(
      decideCoursePhaseAction({
        declaredStatus: "closed",
        isLeaf: true,
        hitches: [],
        derivedOpenP0: 0,
        derivedOpenP1: 0,
      }).kind,
    ).toBe("skip_closed");
  });

  it("skip_blocked for a declared-blocked phase", () => {
    expect(
      decideCoursePhaseAction({
        declaredStatus: "blocked",
        isLeaf: true,
        hitches: [],
        derivedOpenP0: 0,
        derivedOpenP1: 0,
      }).kind,
    ).toBe("skip_blocked");
  });

  it("container for a non-leaf phase with no hitches", () => {
    expect(
      decideCoursePhaseAction({
        declaredStatus: "pending",
        isLeaf: false,
        hitches: [],
        derivedOpenP0: 0,
        derivedOpenP1: 0,
      }).kind,
    ).toBe("container");
  });

  it("needs_link for a leaf actionable phase with no hitches", () => {
    expect(
      decideCoursePhaseAction({
        declaredStatus: "pending",
        isLeaf: true,
        hitches: [],
        derivedOpenP0: 0,
        derivedOpenP1: 0,
      }).kind,
    ).toBe("needs_link");
  });

  it.each([
    "escalate",
    "diverging",
    "budget_exhausted",
    "needs_classification",
  ] satisfies HitchConvergenceDecision[])(
    "blocked_hitch takes precedence over drive for %s",
    (decision) => {
      const r = decideCoursePhaseAction({
        declaredStatus: "in_progress",
        isLeaf: true,
        hitches: [
          {
            hitchId: "h1",
            convergence: conv("h1", "needs_fix", "fix_findings"),
          },
          { hitchId: "h2", convergence: conv("h2", decision, "ask_human") },
        ],
        derivedOpenP0: 1,
        derivedOpenP1: 0,
      });
      expect(r.kind).toBe("blocked_hitch");
      if (r.kind === "blocked_hitch") {
        expect(r.hitchId).toBe("h2");
        expect(r.decision).toBe(decision);
      }
    },
  );

  it("report_only for a single hitch with cancel decision", () => {
    expect(
      decideCoursePhaseAction({
        declaredStatus: "in_progress",
        isLeaf: true,
        hitches: [
          { hitchId: "h1", convergence: conv("h1", "cancel", "ask_human") },
        ],
        derivedOpenP0: 0,
        derivedOpenP1: 0,
      }).kind,
    ).toBe("report_only");
  });

  it.each([
    ["needs_fix", "fix_findings"],
    ["needs_fix", "run_close_check"],
    ["continue", "run_close_check"],
  ] satisfies [
    HitchConvergenceResult["decision"],
    HitchConvergenceResult["recommendedNextAction"]["kind"],
  ][])("drive for %s + %s", (decision, action) => {
    const r = decideCoursePhaseAction({
      declaredStatus: "pending",
      isLeaf: true,
      hitches: [{ hitchId: "h1", convergence: conv("h1", decision, action) }],
      derivedOpenP0: 1,
      derivedOpenP1: 0,
    });
    expect(r.kind).toBe("drive");
    if (r.kind === "drive") expect(r.hitchIds).toEqual(["h1"]);
  });

  it("ready_to_close when all hitches are close_ready and 0 open P0/P1", () => {
    expect(
      decideCoursePhaseAction({
        declaredStatus: "in_progress",
        isLeaf: true,
        hitches: [
          {
            hitchId: "h1",
            convergence: conv("h1", "close_ready", "close_hitch"),
          },
        ],
        derivedOpenP0: 0,
        derivedOpenP1: 0,
      }).kind,
    ).toBe("ready_to_close");
  });

  it("D2b/codex#252-P2: the advisory severity record decision ('continue') is rollup-neutral (NOT blocked_hitch)", () => {
    // The D2b non-escalating severity-audit record writes a decision="continue"
    // row (recommendedNextAction.kind="ask_human"). The rollup/dispatch path keys
    // blocking on the (newest) convergence decision; "continue" must stay OUTSIDE
    // the blocked-set so an advisory severity divergence never blocks the linked
    // phase or isolates its subtree. With its own advisory ask_human action it is
    // a non-isolating report_only (NOT blocked_hitch).
    const advisory = decideCoursePhaseAction({
      declaredStatus: "in_progress",
      isLeaf: true,
      hitches: [
        { hitchId: "h1", convergence: conv("h1", "continue", "ask_human") },
      ],
      derivedOpenP0: 1,
      derivedOpenP1: 0,
    });
    expect(advisory.kind).not.toBe("blocked_hitch");
    expect(advisory.kind).toBe("report_only");

    // And because "continue" is outside the blocked-set, a hitch whose newest
    // decision is "continue" still drives normally when its next action is a
    // drivable one — the advisory record does not poison subsequent progress.
    const drive = decideCoursePhaseAction({
      declaredStatus: "in_progress",
      isLeaf: true,
      hitches: [
        { hitchId: "h1", convergence: conv("h1", "continue", "run_close_check") },
      ],
      derivedOpenP0: 1,
      derivedOpenP1: 0,
    });
    expect(drive.kind).not.toBe("blocked_hitch");
    expect(drive.kind).toBe("drive");
    if (drive.kind === "drive") expect(drive.hitchIds).toEqual(["h1"]);
  });

  it("report_only when a hitch is neither drivable nor ready (e.g. defer)", () => {
    expect(
      decideCoursePhaseAction({
        declaredStatus: "in_progress",
        isLeaf: true,
        hitches: [
          {
            hitchId: "h1",
            convergence: conv("h1", "continue", "defer_followups"),
          },
        ],
        derivedOpenP0: 0,
        derivedOpenP1: 0,
      }).kind,
    ).toBe("report_only");
  });
});
