import { describe, it, expect } from "vitest";
import { classifyReviewGate } from "../../../src/core/review-gate-classify.js";

describe("classifyReviewGate (#77 escalation disambiguation)", () => {
  it("ok when the decision file exists and status is needs_review", () => {
    expect(
      classifyReviewGate({
        runId: "run-1",
        status: "needs_review",
        decisionFileExists: true,
        recordedDecision: null,
      }).kind,
    ).toBe("ok");
  });

  it("already_decided when status is not needs_review (re-orchestrate is a no-op)", () => {
    const c = classifyReviewGate({
      runId: "run-1",
      status: "approved",
      decisionFileExists: false,
      recordedDecision: null,
    });
    expect(c.kind).toBe("already_decided");
    if (c.kind !== "ok") expect(c.message).toMatch(/no re-review|no-op/i);
  });

  it("already_decided when the sidecar is missing but the DB has a recorded decision (export OFF)", () => {
    const c = classifyReviewGate({
      runId: "run-1",
      status: "needs_review",
      decisionFileExists: false,
      recordedDecision: "approved",
    });
    expect(c.kind).toBe("already_decided");
    if (c.kind !== "ok") {
      expect(c.message).toMatch(/already reviewed/i);
      expect(c.message).toMatch(/export is OFF|sidecar/i);
    }
  });

  it("run_incomplete when needs_review, no sidecar, and no recorded decision", () => {
    const c = classifyReviewGate({
      runId: "run-1",
      status: "needs_review",
      decisionFileExists: false,
      recordedDecision: null,
    });
    expect(c.kind).toBe("run_incomplete");
    if (c.kind !== "ok") expect(c.message).toMatch(/incomplete|recover/i);
  });
});
