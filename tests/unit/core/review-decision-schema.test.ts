import { describe, it, expect } from "vitest";
import { ReviewDecisionFileSchema } from "../../../src/core/review-decision-schema.js";

const VALID_PENDING = {
  runId: "run-1",
  domain: "apps/user",
  decision: "pending",
  required_changes: [],
  non_blocking_comments: [],
  out_of_scope_suggestions: [],
  reviewer: null,
  reviewed_at: null,
};

describe("ReviewDecisionFileSchema", () => {
  it("parses the initial pending shape", () => {
    expect(ReviewDecisionFileSchema.parse(VALID_PENDING).decision).toBe(
      "pending",
    );
  });

  it("accepts approved with reviewer + reviewed_at", () => {
    const p = ReviewDecisionFileSchema.parse({
      ...VALID_PENDING,
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    expect(p.decision).toBe("approved");
    expect(p.reviewer).toBe("alice");
  });

  it("accepts changes_requested and rejected", () => {
    expect(
      ReviewDecisionFileSchema.parse({
        ...VALID_PENDING,
        decision: "changes_requested",
        required_changes: ["fix validation"],
      }).decision,
    ).toBe("changes_requested");
    expect(
      ReviewDecisionFileSchema.parse({ ...VALID_PENDING, decision: "rejected" })
        .decision,
    ).toBe("rejected");
  });

  it("rejects unknown decision values", () => {
    expect(() =>
      ReviewDecisionFileSchema.parse({ ...VALID_PENDING, decision: "maybe" }),
    ).toThrow();
  });

  it("rejects extra top-level fields", () => {
    expect(() =>
      ReviewDecisionFileSchema.parse({ ...VALID_PENDING, extra: true }),
    ).toThrow();
  });

  it("requires required_changes / comments / suggestions to be arrays of strings", () => {
    expect(() =>
      ReviewDecisionFileSchema.parse({
        ...VALID_PENDING,
        required_changes: [1, 2],
      }),
    ).toThrow();
  });
});
