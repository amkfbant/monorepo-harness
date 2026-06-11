import { describe, expect, it } from "vitest";
import {
  hitchFindingStableKey,
  normalizeFindingIdentity,
} from "../../../src/hitch/stable-key.js";

describe("goal finding stable key", () => {
  it("normalizes whitespace, case, and path separators", () => {
    const a = hitchFindingStableKey({
      filePath: "./SRC\\Goal\\Repository.ts",
      symbol: " GoalRepository ",
      category: " Correctness ",
      summary: "  Duplicate   finding row ",
    });
    const b = hitchFindingStableKey({
      filePath: "src/goal/repository.ts",
      symbol: "goalrepository",
      category: "correctness",
      summary: "duplicate finding row",
    });
    expect(a).toBe(b);
  });

  it("changes when the symbol changes", () => {
    const base = {
      filePath: "src/goal/repository.ts",
      category: "correctness",
      summary: "stable key collision",
    };
    expect(hitchFindingStableKey({ ...base, symbol: "a" })).not.toBe(
      hitchFindingStableKey({ ...base, symbol: "b" }),
    );
  });

  it("exposes the normalized identity for diagnostics", () => {
    expect(
      normalizeFindingIdentity({
        filePath: "./A\\B.ts",
        symbol: " Fn ",
        category: " Test ",
        summary: "One\nTwo",
      }),
    ).toBe("a/b.ts\nfn\ntest\none two");
  });
});
