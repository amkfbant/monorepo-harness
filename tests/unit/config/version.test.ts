import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { harnessVersion } from "../../../src/config/version.js";

describe("harnessVersion", () => {
  it("returns the version from the harness's own package.json", () => {
    // resolve package.json independently of the implementation and compare.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "..", "package.json");
    const expected = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;

    expect(harnessVersion()).toBe(expected);
  });

  it("returns a non-empty semver-shaped string (never the stale 0.1.0 literal)", () => {
    const v = harnessVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).not.toBe("0.0.0-unknown");
  });
});
