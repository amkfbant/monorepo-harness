import { describe, it, expect } from "vitest";
import { harnessPaths } from "../../../src/config/paths.js";

describe("harnessPaths", () => {
  it("returns absolute paths under a given root", () => {
    const p = harnessPaths("/tmp/h");
    expect(p.runsDir).toBe("/tmp/h/runs");
    expect(p.workspacesDir).toBe("/tmp/h/workspaces");
    expect(p.locksDir).toBe("/tmp/h/locks");
    expect(p.policiesDir).toBe("/tmp/h/policies");
  });

  it("resolves repo policy path by id", () => {
    const p = harnessPaths("/tmp/h");
    expect(p.repoPolicyPath("sample-monorepo")).toBe(
      "/tmp/h/policies/repos/sample-monorepo.yaml",
    );
  });
});
