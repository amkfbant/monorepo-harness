import { describe, it, expect } from "vitest";
import {
  harnessPaths,
  assertValidRepoId,
} from "../../../src/config/paths.js";

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

  it("rejects repo policy ids that try to escape policies/repos", () => {
    const p = harnessPaths("/tmp/h");
    expect(() => p.repoPolicyPath("../etc/passwd")).toThrow(/invalid repo id/);
    expect(() => p.repoPolicyPath("foo/bar")).toThrow(/invalid repo id/);
    expect(() => p.repoPolicyPath("..")).toThrow(/invalid repo id/);
    expect(() => p.repoPolicyPath(".hidden")).toThrow(/invalid repo id/);
    expect(() => p.repoPolicyPath("")).toThrow(/invalid repo id/);
    expect(() => p.repoPolicyPath("a".repeat(100))).toThrow(/invalid repo id/);
  });
});

describe("assertValidRepoId", () => {
  it("accepts alphanumeric, dots, underscore, hyphen", () => {
    expect(() => assertValidRepoId("sample-monorepo")).not.toThrow();
    expect(() => assertValidRepoId("my_repo.v2")).not.toThrow();
    expect(() => assertValidRepoId("abc")).not.toThrow();
  });

  it("rejects path traversal and separators", () => {
    expect(() => assertValidRepoId("..")).toThrow();
    expect(() => assertValidRepoId("../foo")).toThrow();
    expect(() => assertValidRepoId("foo/bar")).toThrow();
    expect(() => assertValidRepoId("foo\\bar")).toThrow();
    expect(() => assertValidRepoId("a..b")).toThrow();
  });
});
