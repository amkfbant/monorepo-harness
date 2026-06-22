import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("resolveSummaryOutPath symlink hardening (#84 P1 fix)", () => {
  const original = process.cwd();
  afterEach(() => process.chdir(original));

  it("rejects a path that escapes the cwd through a symlinked directory", () => {
    const work = mkdtempSync(path.join(tmpdir(), "harness-outpath-work-"));
    const outside = mkdtempSync(path.join(tmpdir(), "harness-outpath-out-"));
    symlinkSync(outside, path.join(work, "link")); // work/link -> outside
    process.chdir(work);
    // lexically inside cwd, but realpath of the existing ancestor escapes it
    expect(() => resolveSummaryOutPath("link/report.md")).toThrow(/--out/);
  });

  it("refuses to write through an existing symlink target (even one inside cwd)", () => {
    const work = mkdtempSync(path.join(tmpdir(), "harness-outpath-work-"));
    const real = path.join(work, "real.md");
    writeFileSync(real, "x");
    symlinkSync(real, path.join(work, "report.md")); // report.md -> ./real.md (in cwd)
    process.chdir(work);
    // resolves inside cwd (so the realpath gate passes) but the target itself
    // is a symlink writeFileSync would follow — must still be rejected.
    expect(() => resolveSummaryOutPath("report.md")).toThrow(/symlink/);
  });

  it("still allows a not-yet-created file in a real subdirectory of cwd", () => {
    const work = mkdtempSync(path.join(tmpdir(), "harness-outpath-work-"));
    mkdirSync(path.join(work, "reports"));
    process.chdir(work);
    // compare against process.cwd() (canonicalized on macOS) — the function
    // resolves against it, not against the raw mkdtemp path.
    expect(resolveSummaryOutPath("reports/out.md")).toBe(
      path.join(process.cwd(), "reports/out.md"),
    );
  });
});
