import { describe, it, expect } from "vitest";
import { conventionalPrTitle } from "../../../src/hitch/conventional-pr-title.js";

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

  it("takes only the first line so a body/footer cannot reach the commit (release-please safety)", () => {
    // a multi-line goal title must not smuggle a `BREAKING CHANGE:` footer into
    // the squash commit and force a major bump from non-operator input.
    const title = conventionalPrTitle({
      goalTitle: "add a thing\n\nBREAKING CHANGE: drops the old API",
      runId: "run-5",
    });
    expect(title).toBe("fix: add a thing (run-5)");
    expect(title).not.toMatch(/BREAKING CHANGE/);
    expect(title).not.toContain("\n");
  });

  it("strips control characters from the title", () => {
    expect(
      conventionalPrTitle({ goalTitle: "feat: a\tb\r\nc", runId: "run-6" }),
    ).toBe("feat: a b (run-6)");
  });

  it("caps an absurdly long title", () => {
    const title = conventionalPrTitle({
      goalTitle: "fix: " + "x".repeat(500),
      runId: "run-7",
    });
    // subject capped; run-id suffix still appended
    expect(title.length).toBeLessThanOrEqual(120 + " (run-7)".length);
    expect(title.endsWith(" (run-7)")).toBe(true);
  });
});
