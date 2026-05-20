import { describe, it, expect } from "vitest";
import { resolvePolicy } from "../../../src/policy/resolver.js";
import {
  DEFAULT_CODEX_TIMEOUT_MS,
  DEFAULT_GIT_TIMEOUT_MS,
} from "../../../src/policy/schema.js";

const GLOBAL = {
  always_deny_write: [".git/**", "package.json"],
  ignore_untracked: [],
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

  it("defaults codex.sandbox / timeoutMs and git_timeout_ms when unset", () => {
    const r = resolvePolicy(GLOBAL, REPO as never, "apps/user");
    expect(r.codex.sandbox).toBe("workspace-write");
    expect(r.codex.approval).toBeUndefined();
    expect(r.codex.timeoutMs).toBe(DEFAULT_CODEX_TIMEOUT_MS);
    expect(r.limits.gitTimeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS);
    expect(r.ignoreUntracked).toEqual([]);
  });

  it("propagates codex / limits / ignore_untracked from global policy", () => {
    const r = resolvePolicy(
      {
        always_deny_write: [],
        ignore_untracked: ["node_modules/**", "dist/**"],
        defaults: {
          codex: {
            sandbox: "read-only",
            approval: "on-request",
            timeout_ms: 60_000,
          },
        },
        limits: { git_timeout_ms: 10_000 },
      },
      REPO as never,
      "apps/user",
    );
    expect(r.codex.sandbox).toBe("read-only");
    expect(r.codex.approval).toBe("on-request");
    expect(r.codex.timeoutMs).toBe(60_000);
    expect(r.limits.gitTimeoutMs).toBe(10_000);
    expect(r.ignoreUntracked).toEqual(["node_modules/**", "dist/**"]);
  });
});
