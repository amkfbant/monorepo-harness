import { describe, it, expect } from "vitest";
import { conventionalPrTitle } from "../../../src/goal/conventional-pr-title.js";

describe("conventionalPrTitle (#103)", () => {
  it("prefixes a default fix: type for a non-conventional goal title", () => {
    expect(
      conventionalPrTitle({
        goalTitle: "project import write-through",
        runId: "run-1",
      }),
    ).toBe("fix: project import write-through (run-1)");
  });

  it("keeps an already-conventional goal title verbatim", () => {
    expect(
      conventionalPrTitle({ goalTitle: "feat: add operational knowledge", runId: "run-1" }),
    ).toBe("feat: add operational knowledge (run-1)");
  });

  it("recognizes a scoped / breaking conventional type", () => {
    expect(conventionalPrTitle({ goalTitle: "fix(core)!: bug", runId: "run-2" })).toBe(
      "fix(core)!: bug (run-2)",
    );
  });

  it("honors a custom default type for feature goals", () => {
    expect(
      conventionalPrTitle({ goalTitle: "add Y", runId: "run-3", defaultType: "feat" }),
    ).toBe("feat: add Y (run-3)");
  });

  it("falls back to the run id when the goal title is empty", () => {
    expect(conventionalPrTitle({ goalTitle: "   ", runId: "run-4" })).toBe(
      "fix: run-4 (run-4)",
    );
  });
});
