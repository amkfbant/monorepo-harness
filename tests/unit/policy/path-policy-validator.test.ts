import { describe, it, expect } from "vitest";
import { validateChangedPaths } from "../../../src/policy/path-policy-validator.js";
import type { ResolvedPolicy } from "../../../src/policy/schema.js";

const POLICY: ResolvedPolicy = {
  repoId: "sample",
  domain: "apps/user",
  read: [],
  write: ["apps/user/**"],
  denyWrite: ["packages/shared/**", "package.json"],
  allowedCommands: [],
  ignoreUntracked: [],
  codex: { sandbox: "workspace-write" },
  limits: { gitTimeoutMs: 30_000 },
};

describe("validateChangedPaths", () => {
  it("accepts changes only inside write scope", () => {
    const r = validateChangedPaths(POLICY, [
      "apps/user/src/profile.ts",
      "apps/user/test/profile.test.ts",
    ]);
    expect(r.status).toBe("allowed");
  });

  it("rejects changes that hit deny_write", () => {
    const r = validateChangedPaths(POLICY, [
      "apps/user/src/profile.ts",
      "package.json",
    ]);
    expect(r.status).toBe("denied");
    expect(r.violations).toEqual([
      { path: "package.json", reason: "deny_write" },
    ]);
  });

  it("rejects changes outside write scope", () => {
    const r = validateChangedPaths(POLICY, ["apps/admin/foo.ts"]);
    expect(r.status).toBe("denied");
    expect(r.violations[0]?.reason).toBe("not_in_write_scope");
  });

  it("treats deny_write as higher priority than write", () => {
    const policy: ResolvedPolicy = {
      ...POLICY,
      write: ["**"],
      denyWrite: ["package.json"],
    };
    const r = validateChangedPaths(policy, ["package.json"]);
    expect(r.status).toBe("denied");
    expect(r.violations[0]?.reason).toBe("deny_write");
  });

  it("rejects absolute paths as unsafe_path", () => {
    const r = validateChangedPaths(POLICY, ["/etc/passwd"]);
    expect(r.violations[0]?.reason).toBe("unsafe_path");
  });

  it("rejects parent-directory traversal as unsafe_path", () => {
    const r = validateChangedPaths(POLICY, ["apps/user/../package.json"]);
    expect(r.violations[0]?.reason).toBe("unsafe_path");
  });

  it("rejects backslash-containing paths as unsafe_path", () => {
    const r = validateChangedPaths(POLICY, ["apps\\user\\foo.ts"]);
    expect(r.violations[0]?.reason).toBe("unsafe_path");
  });

  it("rejects NUL-containing paths as unsafe_path", () => {
    const evil = "apps/user/foo" + String.fromCharCode(0) + ".ts";
    const r = validateChangedPaths(POLICY, [evil]);
    expect(r.violations[0]?.reason).toBe("unsafe_path");
  });

  it("rejects empty paths as unsafe_path", () => {
    const r = validateChangedPaths(POLICY, [""]);
    expect(r.violations[0]?.reason).toBe("unsafe_path");
  });
});
