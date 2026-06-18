import { describe, expect, it } from "vitest";
import {
  closeConditionsLoosenGate,
  isScopeWidening,
} from "../../../src/hitch/spec-gates.js";
import type {
  HitchCloseCondition,
  HitchScope,
} from "../../../src/hitch/types.js";

function condition(
  overrides: Partial<HitchCloseCondition>,
): HitchCloseCondition {
  return {
    id: "typecheck",
    kind: "command",
    required: true,
    ...overrides,
  };
}

describe("spec gates", () => {
  it.each([
    [
      "adding a target operation from an empty matcher widens",
      { notes: "baseline" },
      { notes: "baseline", targetOperations: ["run.start"] },
      true,
    ],
    [
      "removing a target operation narrows",
      { targetOperations: ["run.start", "review.process"] },
      { targetOperations: ["run.start"] },
      false,
    ],
    [
      "removing the targetFiles gate widens",
      { targetFiles: ["src/**"] },
      {},
      true,
    ],
    [
      "adding to targetFiles widens",
      { targetFiles: ["src/**"] },
      { targetFiles: ["src/**", "tests/**"] },
      true,
    ],
    [
      "dropping an excluded category widens",
      { excludedCategories: ["future-feature"] },
      {},
      true,
    ],
    [
      "changing the target summary is conservatively widening",
      { targetSummary: "docs only" },
      { targetSummary: "docs and code" },
      true,
    ],
  ] satisfies Array<[string, HitchScope, HitchScope, boolean]>)(
    "%s",
    (_name, previous, next, expected) => {
      expect(isScopeWidening(previous, next)).toBe(expected);
    },
  );

  it("detects required close-gate loosening by condition id and fingerprint", () => {
    const previous = [
      condition({ id: "typecheck", command: "npm run typecheck" }),
      condition({ id: "lint", command: "npm run lint", required: false }),
    ];

    expect(
      closeConditionsLoosenGate(previous, [
        condition({ id: "typecheck", command: "npm run typecheck" }),
      ]),
    ).toBe(false);
    expect(closeConditionsLoosenGate(previous, [])).toBe(true);
    expect(
      closeConditionsLoosenGate(previous, [
        condition({ id: "typecheck", required: false }),
      ]),
    ).toBe(true);
    expect(
      closeConditionsLoosenGate(previous, [
        condition({ id: "typecheck", command: "npm test" }),
      ]),
    ).toBe(true);
  });
});
