import { describe, expect, it } from "vitest";
import path from "node:path";
import process from "node:process";
import { resolveSummaryOutPath } from "../../../src/cli/hitch/summary-commands.js";

describe("resolveSummaryOutPath (#84 --out traversal guard, fail-closed)", () => {
  it("resolves a path within the current directory", () => {
    expect(resolveSummaryOutPath("report.md")).toBe(
      path.join(process.cwd(), "report.md"),
    );
    expect(resolveSummaryOutPath("sub/dir/report.md")).toBe(
      path.join(process.cwd(), "sub/dir/report.md"),
    );
  });

  it("rejects a parent-traversal path", () => {
    expect(() => resolveSummaryOutPath("../escape.md")).toThrow(/--out/);
    expect(() => resolveSummaryOutPath("a/../../escape.md")).toThrow(/--out/);
  });

  it("rejects an absolute path outside the cwd", () => {
    expect(() => resolveSummaryOutPath("/etc/passwd")).toThrow(/--out/);
  });

  it("accepts an absolute path inside the cwd", () => {
    const inside = path.join(process.cwd(), "nested", "out.md");
    expect(resolveSummaryOutPath(inside)).toBe(inside);
  });
});
