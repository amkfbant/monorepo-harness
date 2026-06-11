import { describe, expect, it } from "vitest";
import {
  isHeartbeatStale,
  progressLabel,
  summarizeWorkspace,
  type WorkspaceStatusInput,
} from "../../../src/workspace/workspace-status.js";

function base(over: Partial<WorkspaceStatusInput> = {}): WorkspaceStatusInput {
  return {
    agent: "alice",
    branch: "agent/alice",
    git: { ahead: 0, behind: 0, baseResolved: true, dirtyCount: 0 },
    hitchId: null,
    hitchDecision: null,
    objective: null,
    lastActiveAt: null,
    lastCheckpointAt: null,
    stale: false,
    ...over,
  };
}

describe("progressLabel (deterministic projection)", () => {
  it("clean for a tidy, goal-less workspace", () => {
    expect(progressLabel(base())).toBe("clean");
  });

  it("stale dominates everything", () => {
    expect(
      progressLabel(base({ stale: true, git: null, hitchDecision: "needs_fix", hitchId: "g" })),
    ).toBe("stale");
  });

  it("treats a non-stale entry with no git state as stale (fail-closed)", () => {
    // a degenerate input (missing/failed inspection) must not read as `clean`.
    expect(progressLabel(base({ stale: false, git: null, hitchId: "g", hitchDecision: "needs_fix" }))).toBe("stale");
  });

  it("goal-missing for a dangling link", () => {
    expect(progressLabel(base({ hitchId: "gone", hitchDecision: null }))).toBe(
      "goal-missing",
    );
  });

  it("blocked for diverging / budget_exhausted / escalate", () => {
    for (const d of ["diverging", "budget_exhausted", "escalate"]) {
      expect(progressLabel(base({ hitchId: "g", hitchDecision: d }))).toBe("blocked");
    }
  });

  it("needs-work for needs_fix / needs_classification", () => {
    expect(progressLabel(base({ hitchId: "g", hitchDecision: "needs_fix" }))).toBe("needs-work");
    expect(progressLabel(base({ hitchId: "g", hitchDecision: "needs_classification" }))).toBe("needs-work");
  });

  it("ready-to-close for close_ready", () => {
    expect(progressLabel(base({ hitchId: "g", hitchDecision: "close_ready" }))).toBe("ready-to-close");
  });

  it("in-progress for a `continue` goal (does not fall through to clean)", () => {
    expect(progressLabel(base({ hitchId: "g", hitchDecision: "continue" }))).toBe("in-progress");
  });

  it("blocked (fail-closed) for an unrecognized decision", () => {
    expect(progressLabel(base({ hitchId: "g", hitchDecision: "brand_new" }))).toBe("blocked");
  });

  it("base-unknown when the base ref does not resolve (hides ahead/behind)", () => {
    expect(
      progressLabel(base({ git: { ahead: 0, behind: 0, baseResolved: false, dirtyCount: 0 } })),
    ).toBe("base-unknown");
    // dirty still takes priority over an unresolved base.
    expect(
      progressLabel(base({ git: { ahead: 0, behind: 0, baseResolved: false, dirtyCount: 3 } })),
    ).toBe("dirty");
  });

  it("falls back to git state (dirty > ahead > behind) when the goal is calm", () => {
    expect(progressLabel(base({ git: { ahead: 1, behind: 1, baseResolved: true, dirtyCount: 2 } }))).toBe("dirty");
    expect(progressLabel(base({ git: { ahead: 1, behind: 1, baseResolved: true, dirtyCount: 0 } }))).toBe("ahead");
    expect(progressLabel(base({ git: { ahead: 0, behind: 1, baseResolved: true, dirtyCount: 0 } }))).toBe("behind");
  });

  it("a calm closed goal with a tidy tree is clean", () => {
    expect(progressLabel(base({ hitchId: "g", hitchDecision: "closed" }))).toBe("clean");
  });

  it("summarizeWorkspace attaches the label", () => {
    const s = summarizeWorkspace(base({ hitchId: "g", hitchDecision: "needs_fix" }));
    expect(s.label).toBe("needs-work");
    expect(s.agent).toBe("alice");
  });
});

describe("isHeartbeatStale", () => {
  const NOW = Date.parse("2026-06-07T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;

  it("is stale when last activity is older than the threshold", () => {
    expect(isHeartbeatStale("2026-06-06T11:00:00.000Z", NOW, DAY)).toBe(true);
  });

  it("is not stale within the threshold", () => {
    expect(isHeartbeatStale("2026-06-07T06:00:00.000Z", NOW, DAY)).toBe(false);
  });

  it("treats exactly the threshold as stale (>=)", () => {
    expect(isHeartbeatStale("2026-06-06T12:00:00.000Z", NOW, DAY)).toBe(true);
  });

  it("is never stale when there is no activity timestamp or it is unparseable", () => {
    expect(isHeartbeatStale(null, NOW, DAY)).toBe(false);
    expect(isHeartbeatStale("not-a-date", NOW, DAY)).toBe(false);
  });
});
