import { describe, it, expect } from "vitest";
import { lintGlobs } from "../../../src/project/glob-linter.js";

describe("lintGlobs", () => {
  it("E5-6-1: flags a root-anchored build-dir glob", () => {
    const findings = lintGlobs(["dist/**"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/\*\*\/dist\/\*\*/);
  });

  it("does not flag a properly nested build-dir glob", () => {
    expect(lintGlobs(["**/dist/**"])).toHaveLength(0);
  });

  it("does not flag an ordinary domain glob", () => {
    expect(lintGlobs(["apps/catalog/**", "docs/**", "package.json"])).toEqual(
      [],
    );
  });

  it("flags node_modules and coverage too", () => {
    expect(lintGlobs(["node_modules/**", "coverage/**"])).toHaveLength(2);
  });
});
