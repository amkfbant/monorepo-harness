import { describe, it, expect } from "vitest";
import {
  snapshotFromSession,
  renderScopeSnapshot,
  type HitchScopeSnapshot,
} from "../../../../src/hitch/jury/scope-snapshot.js";
import {
  DEFAULT_HITCH_POLICY,
  type HitchSession,
} from "../../../../src/hitch/types.js";

/**
 * #230 FIX 1 (codex#254 ROUND-3 P1) — the READ-ONLY frozen scope snapshot the
 * jury prompts classify against. Pure projection + deterministic render.
 */

function session(overrides: Partial<HitchSession> = {}): HitchSession {
  return {
    hitchId: "h1",
    title: "refactor renderer",
    description: null,
    projectId: null,
    repoId: "r1",
    domain: "src/core",
    backlogItemId: null,
    status: "open",
    scope: {},
    closeConditions: [],
    policy: DEFAULT_HITCH_POLICY,
    maxIterations: 10,
    maxReviewCycles: 5,
    maxReruns: 3,
    maxTotalNewFindings: 100,
    currentIteration: 0,
    currentReviewCycle: 0,
    createdBy: "tester",
    createdSource: "cli",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    ...overrides,
  } as HitchSession;
}

describe("snapshotFromSession", () => {
  it("goal is the title alone when no description", () => {
    const snap = snapshotFromSession(session({ description: null }));
    expect(snap.goal).toBe("refactor renderer");
  });

  it("goal folds in the description when present", () => {
    const snap = snapshotFromSession(
      session({ description: "narrow the widget renderer" }),
    );
    expect(snap.goal).toBe("refactor renderer — narrow the widget renderer");
  });

  it("projects domain / scope lists / notes / close conditions", () => {
    const snap = snapshotFromSession(
      session({
        domain: "src/core",
        scope: {
          targetSummary: "widget renderer only",
          targetFiles: ["src/core/widget.ts"],
          targetOperations: ["refactor_render"],
          allowedFindingCategories: ["core"],
          excludedCategories: ["persistence"],
          notes: "keep API stable",
        },
        closeConditions: [
          { id: "typecheck", kind: "command", required: true, description: "tsc" },
        ],
      }),
    );
    expect(snap.domain).toBe("src/core");
    expect(snap.targetSummary).toBe("widget renderer only");
    expect(snap.targetFiles).toEqual(["src/core/widget.ts"]);
    expect(snap.targetOperations).toEqual(["refactor_render"]);
    expect(snap.allowedFindingCategories).toEqual(["core"]);
    expect(snap.excludedCategories).toEqual(["persistence"]);
    expect(snap.notes).toBe("keep API stable");
    expect(snap.closeConditions).toEqual([
      "typecheck (command, required) — tsc",
    ]);
  });

  it("omits empty / whitespace-only optional fields (only goal remains)", () => {
    const snap = snapshotFromSession(
      session({
        domain: "   ",
        scope: {
          targetSummary: "  ",
          targetFiles: ["", "  "],
          targetOperations: [],
          notes: "",
        },
        closeConditions: [],
      }),
    );
    expect(snap).toEqual({ goal: "refactor renderer" });
  });
});

describe("renderScopeSnapshot", () => {
  it("renders the labelled READ-ONLY block with comma-joined lists", () => {
    const snap: HitchScopeSnapshot = {
      goal: "G",
      domain: "D",
      targetOperations: ["op1", "op2"],
      excludedCategories: ["x"],
      closeConditions: ["cc-1 (command, required)"],
    };
    const text = renderScopeSnapshot(snap);
    expect(text).toContain("Frozen hitch scope (READ-ONLY)");
    expect(text).toContain("- goal: G");
    expect(text).toContain("- domain: D");
    expect(text).toContain("- targetOperations: op1, op2");
    expect(text).toContain("- excludedCategories: x");
    expect(text).toContain("- closeConditions:");
    expect(text).toContain("    - cc-1 (command, required)");
  });

  it("omits absent optional fields but always renders the goal line", () => {
    const text = renderScopeSnapshot({ goal: "only the goal" });
    expect(text).toContain("- goal: only the goal");
    expect(text).not.toContain("- domain:");
    expect(text).not.toContain("- targetOperations:");
    expect(text).not.toContain("- closeConditions:");
  });
});
