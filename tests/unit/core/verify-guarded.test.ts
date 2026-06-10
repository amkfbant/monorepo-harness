import { describe, it, expect } from "vitest";
import {
  guardedWriteGlobs,
  findGuardedChanges,
  parseNulPaths,
} from "../../../src/core/verify-guarded.js";
import type { ProjectProfile } from "../../../src/project/schema.js";

function profile(domains: ProjectProfile["domains"]): ProjectProfile {
  return {
    version: 1,
    project_id: "p",
    repo: { id: "p" },
    domains,
  } as ProjectProfile;
}

describe("guardedWriteGlobs (#69)", () => {
  it("collects every domain's write + deny_write globs", () => {
    const p = profile([
      { id: "web", root: "apps/web", write: ["apps/web/**"], deny_write: ["apps/web/secrets/**"] },
      { id: "api", root: "apps/api", write: ["apps/api/**"] },
    ] as ProjectProfile["domains"]);
    expect(guardedWriteGlobs(p).sort()).toEqual(
      ["apps/api/**", "apps/web/**", "apps/web/secrets/**"].sort(),
    );
  });

  it("tolerates domains without write/deny_write", () => {
    const p = profile([
      { id: "x", root: "x", read: ["x/**"] },
    ] as ProjectProfile["domains"]);
    expect(guardedWriteGlobs(p)).toEqual([]);
  });
});

describe("findGuardedChanges (#69)", () => {
  const guarded = ["apps/web/**", "apps/web/secrets/**"];

  it("flags an uncommitted change inside a guarded scope", () => {
    expect(findGuardedChanges(["apps/web/page.tsx"], guarded)).toEqual([
      "apps/web/page.tsx",
    ]);
  });

  it("flags a change to a deny_write path", () => {
    expect(findGuardedChanges(["apps/web/secrets/key.txt"], guarded)).toEqual([
      "apps/web/secrets/key.txt",
    ]);
  });

  it("ignores changes outside any guarded scope", () => {
    expect(findGuardedChanges(["docs/readme.md", "apps/cli/x.ts"], guarded)).toEqual([]);
  });

  it("matches dotfiles (dot: true)", () => {
    expect(findGuardedChanges(["apps/web/.env"], ["apps/web/**"])).toEqual([
      "apps/web/.env",
    ]);
  });
});

describe("parseNulPaths", () => {
  it("splits NUL-delimited paths preserving whitespace, dropping empties", () => {
    expect(parseNulPaths("a\0 b\0c/d\0")).toEqual(["a", " b", "c/d"]);
    expect(parseNulPaths("")).toEqual([]);
  });
});
