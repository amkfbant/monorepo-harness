import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildReviewDecision } from "../../../src/reporter/review-decision.js";

describe("buildReviewDecision", () => {
  it("emits a pending decision skeleton with empty lists", () => {
    const yaml = buildReviewDecision({
      runId: "run-1",
      domain: "apps/user",
    });
    const parsed = parseYaml(yaml);
    expect(parsed).toEqual({
      runId: "run-1",
      domain: "apps/user",
      decision: "pending",
      required_changes: [],
      non_blocking_comments: [],
      out_of_scope_suggestions: [],
      reviewer: null,
      reviewed_at: null,
    });
  });
});
