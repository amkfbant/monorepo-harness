import { describe, it, expect } from "vitest";
import { filterPatchEcho } from "../../../src/core/workflow-runner.js";

describe("filterPatchEcho", () => {
  it("returns empty for empty input", () => {
    expect(filterPatchEcho("")).toBe("");
  });

  it("passes clean stderr through unchanged", () => {
    const s = "warning: rate limit\napplied 2 files\n";
    expect(filterPatchEcho(s)).toBe(s);
  });

  it("truncates at the first diff --git block", () => {
    const s = [
      "warning: applied patch",
      "succeeded in 1ms",
      "diff --git a/foo.ts b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const out = filterPatchEcho(s);
    expect(out).toMatch(/warning: applied patch/);
    expect(out).toMatch(/succeeded in 1ms/);
    expect(out).not.toMatch(/diff --git/);
    expect(out).toMatch(/\[stderr omitted: patch-like output detected/);
  });

  it("handles diff --git at the very start of stderr", () => {
    const s = "diff --git a/foo b/foo\n@@ -1 +1 @@\n+x\n";
    const out = filterPatchEcho(s);
    expect(out).not.toMatch(/diff --git/);
    expect(out).toMatch(/\[stderr omitted/);
  });

  it("only strips the first diff block onward (preserves leading context)", () => {
    const s = [
      "line A",
      "line B",
      "diff --git a/x b/x",
      "+more patch",
      "diff --git a/y b/y",
      "+more",
    ].join("\n");
    const out = filterPatchEcho(s);
    expect(out).toMatch(/line A/);
    expect(out).toMatch(/line B/);
    expect(out).not.toMatch(/diff --git/);
  });
});
