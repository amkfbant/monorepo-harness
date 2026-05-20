import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadReviewDecision,
  writeReviewDecision,
} from "../../../src/core/review-decision-loader.js";

describe("loadReviewDecision", () => {
  it("loads a valid YAML file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-rd-"));
    writeFileSync(
      join(dir, "review-decision.yaml"),
      [
        "runId: run-1",
        "domain: apps/user",
        "decision: approved",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: alice",
        "reviewed_at: 2026-05-20T12:00:00Z",
        "",
      ].join("\n"),
    );
    const p = await loadReviewDecision(join(dir, "review-decision.yaml"));
    expect(p.decision).toBe("approved");
    expect(p.reviewer).toBe("alice");
  });

  it("throws on invalid yaml content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-rd-"));
    writeFileSync(join(dir, "review-decision.yaml"), "decision: garbage\n");
    await expect(
      loadReviewDecision(join(dir, "review-decision.yaml")),
    ).rejects.toThrow();
  });
});

describe("writeReviewDecision", () => {
  it("serializes back to YAML round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-rd-"));
    const path = join(dir, "review-decision.yaml");
    await writeReviewDecision(path, {
      runId: "run-1",
      domain: "apps/user",
      decision: "approved",
      required_changes: [],
      non_blocking_comments: [],
      out_of_scope_suggestions: [],
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    const reloaded = await loadReviewDecision(path);
    expect(reloaded.decision).toBe("approved");
    expect(reloaded.reviewer).toBe("alice");
  });
});
