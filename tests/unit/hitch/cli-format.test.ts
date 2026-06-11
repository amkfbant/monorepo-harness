import { describe, expect, it } from "vitest";
import {
  formatGoalOrchestrateResultLine,
  formatGoalStatusLine,
} from "../../../src/cli/goal.js";

describe("goal CLI formatting", () => {
  it("prints draft state as a separate field without changing outcome", () => {
    const line = formatGoalOrchestrateResultLine(
      "g-draft",
      {
        hitchId: "g-draft",
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

  it("labels passed review_consensus checks as static-only approval", () => {
    const line = formatGoalStatusLine({
      session: {
        hitchId: "g-static",
        status: "close_ready",
        closeConditions: [
          { id: "review-ok", kind: "review_consensus", required: true },
        ],
      },
      convergence: {
        decision: "close_ready",
        metrics: {
          openInScopeP1: 0,
          openUnknownScope: 0,
        },
      },
      closeChecks: [
        {
          conditionId: "review-ok",
          status: "passed",
          evidence: {
            reviewerAdvisories: [
              {
                source: "non_blocking_comment",
                index: 0,
                category: "test-execution-unverified",
                text: "No command logs were present.",
              },
            ],
          },
        },
      ],
    });

    expect(line).toContain("review_consensus=static_pass");
    expect(line).toContain("tests=not_run_by_consensus");
    expect(line).toContain("review_advisories=1");
  });
});
