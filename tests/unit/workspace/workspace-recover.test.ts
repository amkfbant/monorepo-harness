import { describe, expect, it } from "vitest";
import { buildRecoveryBriefing } from "../../../src/workspace/workspace-recover.js";
import type { WorkspaceInspection } from "../../../src/workspace/agent-workspace.js";

function insp(over: Partial<WorkspaceInspection> = {}): WorkspaceInspection {
  return {
    agent: "alice",
    path: "/p/alice",
    branch: "agent/alice",
    head: "a".repeat(40),
    base: "main",
    baseResolved: true,
    ahead: 0,
    behind: 0,
    dirtyFiles: [],
    lastCommit: { sha: "a".repeat(40), subject: "init" },
    ...over,
  };
}

describe("buildRecoveryBriefing nextSteps (deterministic)", () => {
  it("reports nothing pending for a clean, up-to-date workspace with no goal", () => {
    const b = buildRecoveryBriefing({
      inspection: insp(),
      objective: null,
      goal: null,
      latestCheckpoint: null,
    });
    expect(b.nextSteps).toEqual([
      "workspace is clean and up to date — nothing pending",
    ]);
  });

  it("derives steps from dirty / ahead / behind", () => {
    const b = buildRecoveryBriefing({
      inspection: insp({ dirtyFiles: ["a.ts", "b.ts"], ahead: 2, behind: 1 }),
      objective: null,
      goal: null,
      latestCheckpoint: null,
    });
    expect(b.nextSteps[0]).toMatch(/commit or stash 2/);
    expect(b.nextSteps[1]).toMatch(/push agent\/alice .*2 commit\(s\) ahead/);
    expect(b.nextSteps[2]).toMatch(/integrate main into agent\/alice \(1 behind\)/);
  });

  it("does not emit ahead/behind steps when the base is unresolved", () => {
    const b = buildRecoveryBriefing({
      inspection: insp({ baseResolved: false, ahead: 0, behind: 0 }),
      objective: null,
      goal: null,
      latestCheckpoint: null,
    });
    expect(b.nextSteps.join(" ")).not.toMatch(/ahead|behind/);
  });

  it("projects the linked goal's convergence decision into a step", () => {
    // realistic (decision, nextActionKind) pairs as ConvergenceService emits.
    const mk = (decision: string, nextActionKind: string) =>
      buildRecoveryBriefing({
        inspection: insp(),
        objective: null,
        goal: { hitchId: "g1", convergence: { decision, reason: "r", nextActionKind } },
        latestCheckpoint: null,
      }).nextSteps.join(" | ");
    expect(mk("needs_fix", "fix_findings")).toMatch(/run the coder for goal g1/);
    expect(mk("needs_classification", "classify_findings")).toMatch(/classify unknown-scope/);
    expect(mk("continue", "run_close_check")).toMatch(/run review \/ record close-check/);
    expect(mk("close_ready", "close_goal")).toMatch(/close goal g1 and open the PR/);
    expect(mk("escalate", "ask_human")).toMatch(/escalate goal g1 \(escalate: r\)/);
    // a closed goal contributes no goal step → clean message.
    expect(mk("closed", "close_goal")).toMatch(/nothing pending/);
  });

  it("fail-closes (escalate) on an unrecognized decision or an unsupported continue action", () => {
    const steps = (decision: string, nextActionKind: string) =>
      buildRecoveryBriefing({
        inspection: insp(),
        objective: null,
        goal: { hitchId: "g1", convergence: { decision, reason: "r", nextActionKind } },
        latestCheckpoint: null,
      }).nextSteps.join(" | ");
    // a future/unknown decision must not be guessed as "review".
    expect(steps("brand_new_decision", "whatever")).toMatch(
      /unrecognized convergence decision \(brand_new_decision\) — escalate/,
    );
    expect(steps("brand_new_decision", "whatever")).not.toMatch(/run review/);
    // continue with an unsupported next action also escalates.
    expect(steps("continue", "some_future_action")).toMatch(
      /unsupported action \(continue\/some_future_action\) — escalate/,
    );
  });

  it("respects the authoritative nextActionKind for a `continue` decision", () => {
    const mk = (nextActionKind: string) =>
      buildRecoveryBriefing({
        inspection: insp(),
        objective: null,
        goal: { hitchId: "g1", convergence: { decision: "continue", reason: "r", nextActionKind } },
        latestCheckpoint: null,
      }).nextSteps.join(" | ");
    expect(mk("defer_followups")).toMatch(/defer out-of-scope follow-ups for goal g1/);
    expect(mk("defer_followups")).not.toMatch(/review/);
    expect(mk("run_close_check")).toMatch(/run review \/ record close-check/);
  });

  it("flags a dangling goal link (goal no longer exists)", () => {
    const b = buildRecoveryBriefing({
      inspection: insp(),
      objective: null,
      goal: { hitchId: "gone", convergence: null },
      latestCheckpoint: null,
    });
    expect(b.nextSteps.join(" ")).toMatch(/goal gone no longer exists/);
  });

  it("treats the checkpoint note as advisory: it never adds a step", () => {
    const withNote = buildRecoveryBriefing({
      inspection: insp(),
      objective: "ship it",
      goal: null,
      latestCheckpoint: {
        note: "I think we should rewrite everything",
        createdAt: "t",
        createdBy: "alice",
      },
    });
    // the note is preserved for context but does not influence the steps.
    expect(withNote.latestCheckpoint?.note).toMatch(/rewrite everything/);
    expect(withNote.nextSteps).toEqual([
      "workspace is clean and up to date — nothing pending",
    ]);
  });
});
