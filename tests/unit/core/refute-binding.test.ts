import { describe, expect, it } from "vitest";
import {
  normalizeChangeText,
  targetChangeHash,
  verifyRefuteBinding,
} from "../../../src/core/refute-binding.js";

describe("normalizeChangeText", () => {
  it("normalizes NFC, line endings, horizontal whitespace, and outer trim", () => {
    expect(
      normalizeChangeText("  Cafe\u0301\t\tneeds   validation  \r\n\tsoon  "),
    ).toBe("Café needs validation\n soon");
  });

  it("keeps case and punctuation differences distinct", () => {
    expect(targetChangeHash("Add validation.")).not.toBe(
      targetChangeHash("add validation"),
    );
  });

  it("hashes equivalent normalized forms to the same target id", () => {
    expect(targetChangeHash("Café needs validation\nsoon")).toBe(
      targetChangeHash(" Cafe\u0301\tneeds   validation\r\nsoon "),
    );
  });
});

describe("verifyRefuteBinding", () => {
  const activeRequiredChanges = [
    { idx: 2, change_text: "different target" },
    { idx: 0, change_text: "add validation" },
  ];

  it("binds a declared target hash to an active required change", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: {
          target_change_hash: targetChangeHash(" add   validation "),
        },
        activeRequiredChanges,
      }),
    ).toMatchObject({
      bound: true,
      boundToIdx: 0,
      targetChangeHash: targetChangeHash("add validation"),
    });
  });

  it("binds target text by harness-computed hash", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: { target_change_text: "different\ttarget" },
        activeRequiredChanges,
      }),
    ).toMatchObject({
      bound: true,
      boundToIdx: 2,
      targetChangeHash: targetChangeHash("different target"),
    });
  });

  it("rejects a target text whose declared hash disagrees", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: {
          target_change_text: "add validation",
          target_change_hash: targetChangeHash("different target"),
        },
        activeRequiredChanges,
      }),
    ).toMatchObject({
      bound: false,
      reason: "hash_mismatch",
      targetChangeHash: targetChangeHash("add validation"),
      declaredTargetChangeHash: targetChangeHash("different target"),
      computedTargetChangeHash: targetChangeHash("add validation"),
    });
  });

  it("rejects a hash that is not present in active required changes", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: { target_change_hash: targetChangeHash("unknown") },
        activeRequiredChanges,
      }),
    ).toMatchObject({
      bound: false,
      reason: "unknown_target",
      targetChangeHash: targetChangeHash("unknown"),
    });
  });

  it("rejects votes with no target hash or target text", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: {},
        activeRequiredChanges,
      }),
    ).toEqual({
      bound: false,
      reason: "missing_target",
      targetChangeHash: null,
    });
  });

  it("uses the lowest idx when duplicate active changes share a hash", () => {
    expect(
      verifyRefuteBinding({
        refuteVote: { target_change_hash: targetChangeHash("same target") },
        activeRequiredChanges: [
          { idx: 5, change_text: "same target" },
          { idx: 3, change_text: " same   target " },
        ],
      }),
    ).toMatchObject({
      bound: true,
      boundToIdx: 3,
    });
  });
});
