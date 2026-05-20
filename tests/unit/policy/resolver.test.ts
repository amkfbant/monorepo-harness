import { describe, it, expect } from "vitest";
import { resolvePolicy } from "../../../src/policy/resolver.js";

const GLOBAL = {
  always_deny_write: [".git/**", "package.json"],
};

const REPO = {
  repo_id: "sample-monorepo",
  read: ["README.md"],
  domains: {
    "apps/user": {
      read: ["apps/user/**", "docs/**"],
      write: ["apps/user/**"],
      deny_write: ["apps/admin/**"],
      commands: { allow: ["pnpm test"] },
    },
  },
} as const;

describe("resolvePolicy", () => {
  it("merges global deny_write with domain deny_write", () => {
    const r = resolvePolicy(GLOBAL, REPO as never, "apps/user");
    expect(r.denyWrite).toEqual(
      expect.arrayContaining([".git/**", "package.json", "apps/admin/**"]),
    );
  });

  it("returns read = repo.read ∪ domain.read", () => {
    const r = resolvePolicy(GLOBAL, REPO as never, "apps/user");
    expect(r.read).toEqual(
      expect.arrayContaining(["README.md", "apps/user/**", "docs/**"]),
    );
  });

  it("throws when domain is missing", () => {
    expect(() =>
      resolvePolicy(GLOBAL, REPO as never, "apps/missing"),
    ).toThrow(/domain.*apps\/missing/);
  });

  it("defaults codex.sandbox to workspace-write when unset", () => {
    const r = resolvePolicy(GLOBAL, REPO as never, "apps/user");
    expect(r.codex.sandbox).toBe("workspace-write");
    expect(r.codex.approval).toBeUndefined();
  });

  it("propagates codex defaults from global policy", () => {
    const r = resolvePolicy(
      {
        always_deny_write: [],
        defaults: { codex: { sandbox: "read-only", approval: "on-request" } },
      },
      REPO as never,
      "apps/user",
    );
    expect(r.codex.sandbox).toBe("read-only");
    expect(r.codex.approval).toBe("on-request");
  });
});
