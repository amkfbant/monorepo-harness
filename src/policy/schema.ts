import { z } from "zod";

const Glob = z.string().min(1);

export const SandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const CodexDefaultsSchema = z
  .object({
    sandbox: SandboxModeSchema.default("workspace-write"),
    approval: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();
export type CodexDefaults = z.infer<typeof CodexDefaultsSchema>;

export const LimitsSchema = z
  .object({
    git_timeout_ms: z.number().int().positive().default(30_000),
  })
  .strict();
export type Limits = z.infer<typeof LimitsSchema>;

export const GlobalPolicySchema = z
  .object({
    defaults: z
      .object({
        codex: CodexDefaultsSchema.optional(),
      })
      .optional(),
    limits: LimitsSchema.optional(),
    always_deny_write: z.array(Glob).default([]),
    // minimatch root-anchored patterns. Use `**/dist/**` (NOT `dist/**`)
    // to match nested directories. See docs/policy-semantics.md.
    ignore_untracked: z.array(Glob).default([]),
    commands: z
      .object({
        default_allow: z.array(z.string()).default([]),
      })
      .optional(),
  })
  .strict();
export type GlobalPolicy = z.infer<typeof GlobalPolicySchema>;

export const CommandDefaultsSchema = z
  .object({
    timeout_ms: z.number().int().positive().optional(),
    /**
     * Environment variables to pass to allowed commands. If absent, falls
     * back to DEFAULT_COMMAND_ENV_ALLOWLIST inside the runner.
     */
    env_allowlist: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type CommandDefaults = z.infer<typeof CommandDefaultsSchema>;

export const DomainPolicySchema = z
  .object({
    read: z.array(Glob).default([]),
    write: z.array(Glob).default([]),
    deny_write: z.array(Glob).default([]),
    commands: z
      .object({
        allow: z.array(z.string()).default([]),
        defaults: CommandDefaultsSchema.optional(),
      })
      .optional(),
  })
  .strict();
export type DomainPolicy = z.infer<typeof DomainPolicySchema>;

export const RepoPolicySchema = z
  .object({
    repo_id: z.string().min(1),
    read: z.array(Glob).default([]),
    domains: z.record(z.string(), DomainPolicySchema),
  })
  .strict();
export type RepoPolicy = z.infer<typeof RepoPolicySchema>;

export interface ResolvedPolicy {
  repoId: string;
  domain: string;
  read: string[];
  write: string[];
  denyWrite: string[];
  allowedCommands: string[];
  /**
   * Defaults applied to every entry in allowedCommands.
   * timeoutMs comes from domain.commands.defaults.timeout_ms or the
   * harness default; envAllowlist is undefined → runner uses
   * DEFAULT_COMMAND_ENV_ALLOWLIST; defined empty → strict empty env.
   */
  commandDefaults: {
    timeoutMs: number;
    envAllowlist?: string[];
  };
  ignoreUntracked: string[];
  codex: {
    sandbox: SandboxMode;
    approval?: string;
    timeoutMs?: number;
  };
  limits: {
    gitTimeoutMs: number;
  };
}

export const DEFAULT_CODEX_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_GIT_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
