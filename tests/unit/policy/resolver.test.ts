import { describe, it, expect } from "vitest";
import { resolvePolicy } from "../../../src/policy/resolver.js";
import {
  DEFAULT_CHANGE_BUDGET,
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
    // #206: model is undefined when policy does not set it (no-config →
    // run_usage.model stays NULL → telemetry byte-stable).
    expect(r.codex.model).toBeUndefined();
    // #191: backend/claudeModel undefined when unset → resolveAgentBackend
    // falls back to env then codex; an unconfigured policy stays byte-stable.
    expect(r.codex.backend).toBeUndefined();
    expect(r.codex.claudeModel).toBeUndefined();
    expect(r.codex.timeoutMs).toBe(DEFAULT_CODEX_TIMEOUT_MS);
    expect(r.limits.gitTimeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS);
    expect(r.limits.changeBudget).toEqual(DEFAULT_CHANGE_BUDGET);
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
            model: "gpt-5.5",
            backend: "claude",
            claude_model: "opus-4.8",
          },
        },
        limits: {
          git_timeout_ms: 10_000,
          change_budget: {
            max_deleted_lines: 11,
            max_total_changed_lines: 22,
            max_deleted_files: 3,
            max_changed_files: 4,
          },
        },
      },
      REPO as never,
      "apps/user",
    );
    expect(r.codex.sandbox).toBe("read-only");
    expect(r.codex.approval).toBe("on-request");
    expect(r.codex.model).toBe("gpt-5.5");
    // #191: per-project coder backend + advisory claude model resolved.
    expect(r.codex.backend).toBe("claude");
    expect(r.codex.claudeModel).toBe("opus-4.8");
    expect(r.codex.timeoutMs).toBe(60_000);
    expect(r.limits.gitTimeoutMs).toBe(10_000);
    expect(r.limits.changeBudget).toEqual({
      enforce: true,
      maxDeletedLines: 11,
      maxTotalChangedLines: 22,
      maxDeletedFiles: 3,
      maxChangedFiles: 4,
    });
    expect(r.ignoreUntracked).toEqual(["node_modules/**", "dist/**"]);
  });

  it("applies global change_budget when the domain leaves it unset", () => {
    const r = resolvePolicy(
      {
        always_deny_write: [],
        ignore_untracked: [],
        limits: {
          change_budget: {
            max_deleted_lines: 12,
            max_total_changed_lines: 34,
          },
        },
      },
      REPO as never,
      "apps/user",
    );

    expect(r.limits.changeBudget).toEqual({
      enforce: true,
      maxDeletedLines: 12,
      maxTotalChangedLines: 34,
      maxDeletedFiles: DEFAULT_CHANGE_BUDGET.maxDeletedFiles,
      maxChangedFiles: DEFAULT_CHANGE_BUDGET.maxChangedFiles,
    });
  });

  it("accepts zero change_budget limits", () => {
    const r = resolvePolicy(
      {
        always_deny_write: [],
        ignore_untracked: [],
        limits: {
          change_budget: {
            max_deleted_lines: 0,
            max_deleted_files: 0,
          },
        },
      },
      REPO as never,
      "apps/user",
    );

    expect(r.limits.changeBudget).toEqual({
      enforce: true,
      maxDeletedLines: 0,
      maxTotalChangedLines: DEFAULT_CHANGE_BUDGET.maxTotalChangedLines,
      maxDeletedFiles: 0,
      maxChangedFiles: DEFAULT_CHANGE_BUDGET.maxChangedFiles,
    });
  });

  it("lets domain change_budget override global per field and folds defaults", () => {
    const r = resolvePolicy(
      {
        always_deny_write: [],
        ignore_untracked: [],
        limits: {
          change_budget: {
            max_deleted_lines: 12,
            max_total_changed_lines: 34,
            max_deleted_files: 2,
            max_changed_files: 3,
          },
        },
      },
      {
        repo_id: "x",
        read: [],
        domains: {
          "apps/user": {
            read: [],
            write: [],
            deny_write: [],
            change_budget: {
              max_total_changed_lines: 99,
              max_changed_files: 9,
            },
          },
        },
      } as never,
      "apps/user",
    );

    expect(r.limits.changeBudget).toEqual({
      enforce: true,
      maxDeletedLines: 12,
      maxTotalChangedLines: 99,
      maxDeletedFiles: 2,
      maxChangedFiles: 9,
    });
  });

  it("carries enforce:false through the domain override", () => {
    const r = resolvePolicy(
      {
        always_deny_write: [],
        ignore_untracked: [],
        limits: { change_budget: { max_deleted_lines: 12 } },
      },
      {
        repo_id: "x",
        read: [],
        domains: {
          "apps/user": {
            read: [],
            write: [],
            deny_write: [],
            change_budget: { enforce: false },
          },
        },
      } as never,
      "apps/user",
    );

    expect(r.limits.changeBudget).toEqual({
      ...DEFAULT_CHANGE_BUDGET,
      maxDeletedLines: 12,
      enforce: false,
    });
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
