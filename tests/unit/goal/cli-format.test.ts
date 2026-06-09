import { describe, expect, it } from "vitest";
import { formatGoalOrchestrateResultLine } from "../../../src/cli/goal.js";

describe("goal CLI formatting", () => {
  it("prints draft state as a separate field without changing outcome", () => {
    const line = formatGoalOrchestrateResultLine(
      "g-draft",
      {
        goalId: "g-draft",
        outcome: "pr_created",
        draft: true,
        prUrl: "https://example.test/pr/1",
        steps: [],
        finalDecision: "close_ready",
      },
      { linked: false },
    );

    expect(line).toContain("outcome=pr_created draft=true");
    expect(line).toContain("pr=https://example.test/pr/1");
    expect(line).not.toContain("pr_created(draft)");
  });
});
