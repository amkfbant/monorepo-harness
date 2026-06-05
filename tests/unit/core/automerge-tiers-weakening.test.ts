import { describe, expect, it } from "vitest";
import { detectsTestWeakening } from "../../../src/core/automerge-tiers.js";

const additive = [
  "diff --git a/tests/unit/foo.test.ts b/tests/unit/foo.test.ts",
  "--- a/tests/unit/foo.test.ts",
  "+++ b/tests/unit/foo.test.ts",
  "@@ -1,3 +1,6 @@",
  ' it("existing", () => { expect(1).toBe(1); });',
  '+it("new edge case", () => {',
  "+  expect(2).toBe(2);",
  "+});",
].join("\n");

describe("detectsTestWeakening", () => {
  it("does NOT flag a purely additive test change", () => {
    expect(detectsTestWeakening(additive)).toBe(false);
  });

  it("flags an added .skip marker in a tests/ file", () => {
    const patch = [
      "diff --git a/tests/unit/foo.test.ts b/tests/unit/foo.test.ts",
      "--- a/tests/unit/foo.test.ts",
      "+++ b/tests/unit/foo.test.ts",
      "@@ -1,1 +1,1 @@",
      '-it("works", () => {});',
      '+it.skip("works", () => {});',
    ].join("\n");
    expect(detectsTestWeakening(patch)).toBe(true);
  });

  it("flags an added .only marker (narrows the suite)", () => {
    const patch = [
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "+++ b/tests/a.test.ts",
      '+describe.only("x", () => {});',
    ].join("\n");
    expect(detectsTestWeakening(patch)).toBe(true);
  });

  it("flags an added xit() family marker", () => {
    const patch = [
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "+++ b/tests/a.test.ts",
      '+xit("disabled", () => {});',
    ].join("\n");
    expect(detectsTestWeakening(patch)).toBe(true);
  });

  it("flags a DELETED tests/ file", () => {
    const patch = [
      "diff --git a/tests/unit/gone.test.ts b/tests/unit/gone.test.ts",
      "deleted file mode 100644",
      "index 1234567..0000000",
      "--- a/tests/unit/gone.test.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      '-it("was here", () => {});',
    ].join("\n");
    expect(detectsTestWeakening(patch)).toBe(true);
  });

  it("does NOT flag skip-looking text in a NON-test (src) file", () => {
    const patch = [
      "diff --git a/src/core/x.ts b/src/core/x.ts",
      "+++ b/src/core/x.ts",
      "+// it.skip is just a comment here, not a test",
      '+export const only = "field";',
    ].join("\n");
    expect(detectsTestWeakening(patch)).toBe(false);
  });

  it("does NOT flag a deleted NON-test file", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
    ].join("\n");
    expect(detectsTestWeakening(patch)).toBe(false);
  });
});
