import { describe, expect, it } from "vitest";
import { computeAutoMergeTier } from "../../../src/core/automerge-tiers.js";

describe("computeAutoMergeTier", () => {
  it.each([
    ["src/policy/rules.ts", 2],
    ["docs/workflow.md", 0],
    ["src/cli/hitch.ts", 1],
    ["tests/unit/core/example.test.ts", 0],
    // #125 A15: reviewer-agent.ts and its extracted modules are all Tier-2.
    // The glob preserves the safety classification across the file split — a
    // prompt-only change to an extracted module must not auto-merge.
    ["src/core/reviewer-agent.ts", 2],
    ["src/core/reviewer-agent-prompt.ts", 2],
    ["src/core/reviewer-agent-decision.ts", 2],
    ["src/core/reviewer-agent-types.ts", 2],
    ["src/core/reviewer-agent-usage.ts", 2],
  ] as const)("%s maps to Tier-%d", (path, tier) => {
    expect(computeAutoMergeTier([path])).toBe(tier);
  });

  it("returns the highest tier across all changed paths", () => {
    expect(
      computeAutoMergeTier([
        "docs/workflow.md",
        "tests/unit/core/example.test.ts",
        "src/core/merge-gate.ts",
      ]),
    ).toBe(2);
  });

  it("returns the highest tier when one path matches multiple rules", () => {
    expect(
      computeAutoMergeTier(["docs/specs/hitch-convergence.md"], [
        { glob: "docs/**", tier: 0 },
        { glob: "docs/specs/**", tier: 2 },
      ]),
    ).toBe(2);
  });
});
