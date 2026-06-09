import { describe, it, expect } from "vitest";
import {
  parseGitPathList,
  assertPathsSubset,
} from "../../../src/core/reviewed-branch-push.js";

describe("parseGitPathList (git diff -z parsing)", () => {
  it("splits NUL-terminated paths and preserves leading/trailing whitespace", () => {
    // `git diff -z --name-only` emits NUL-terminated paths with a trailing NUL.
    expect(parseGitPathList("a\0 a\0b/c\0")).toEqual(["a", " a", "b/c"]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseGitPathList("")).toEqual([]);
  });

  it("keeps a whitespace path distinct from a reviewed path (subset gate holds)", () => {
    // Reviewed set is exactly {"a"}; an existing change adds the distinct path
    // " a". With line-trimming this would collapse to "a" and slip past the
    // gate; with exact NUL parsing it must be rejected as unreviewed.
    const reviewed = ["a"];
    const changed = parseGitPathList("a\0 a\0");
    expect(() => assertPathsSubset(changed, reviewed, "branch diff")).toThrow(
      /unreviewed path/,
    );
  });
});
