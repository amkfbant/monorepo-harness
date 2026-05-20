import { describe, it, expect } from "vitest";
import { resolvePolicy } from "../../../src/policy/resolver.js";
import {
  DEFAULT_CODEX_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
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

  it("defaults commandDefaults.timeoutMs and leaves envAllowlist absent", () => {
    const r = resolvePolicy(GLOBAL, REPO as never, "apps/user");
    expect(r.commandDefaults.timeoutMs).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(r.commandDefaults.envAllowlist).toBeUndefined();
  });

  it("resolves a structured command with empty args as shell:false (argv form)", () => {
    const r = resolvePolicy(
      GLOBAL,
      {
        repo_id: "x",
        read: [],
        domains: {
          "apps/user": {
            read: [],
            write: [],
            deny_write: [],
            commands: {
              allow: [{ id: "lint", cmd: "ls", args: [] }],
            },
          },
        },
      } as never,
      "apps/user",
    );
    expect(r.allowedCommands[0]?.shell).toBe(false);
    expect(r.allowedCommands[0]?.id).toBe("lint");
  });

  it("string commands stay shell:true (legacy backward compat)", () => {
    const r = resolvePolicy(
      GLOBAL,
      {
        repo_id: "x",
        read: [],
        domains: {
          "apps/user": {
            read: [],
            write: [],
            deny_write: [],
            commands: { allow: ["npm test"] },
          },
        },
      } as never,
      "apps/user",
    );
    expect(r.allowedCommands[0]?.shell).toBe(true);
    expect(r.allowedCommands[0]?.id).toBe("cmd-0");
  });

  it("rejects duplicate command ids within a domain", () => {
    expect(() =>
      resolvePolicy(
        GLOBAL,
        {
          repo_id: "x",
          read: [],
          domains: {
            "apps/user": {
              read: [],
              write: [],
              deny_write: [],
              commands: {
                allow: [
                  { id: "same", cmd: "ls", args: [] },
                  { id: "same", cmd: "pwd", args: [] },
                ],
              },
            },
          },
        } as never,
        "apps/user",
      ),
    ).toThrow(/duplicate command id/);
  });

  it("propagates per-domain commands.defaults (timeout + env_allowlist)", () => {
    const r = resolvePolicy(
      GLOBAL,
      {
        repo_id: "x",
        read: [],
        domains: {
          "apps/user": {
            read: [],
            write: [],
            deny_write: [],
            commands: {
              allow: ["pnpm test"],
              defaults: {
                timeout_ms: 120_000,
                env_allowlist: ["PATH", "NODE_ENV"],
              },
            },
          },
        },
      } as never,
      "apps/user",
    );
    expect(r.commandDefaults.timeoutMs).toBe(120_000);
    expect(r.commandDefaults.envAllowlist).toEqual(["PATH", "NODE_ENV"]);
  });
});
