import { z } from "zod";

const Glob = z.string().min(1);

export const SandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

// Which agent backend drives the CODER for runs resolved under this policy
// (#191 per-project). 'claude' is OPT-IN; absent → the harness default (codex),
// keeping codex's OS-sandbox behaviour the safe default. The reviewer stays
// codex regardless for now (F16 recommended config + the S4 reviewer-redaction
// follow-up). Lives in `codex` defaults to reuse the single execution-config
// channel rather than add a parallel one.
export const AgentBackendSchema = z.enum(["codex", "claude"]);
export type AgentBackend = z.infer<typeof AgentBackendSchema>;

export const CodexDefaultsSchema = z
  .object({
    sandbox: SandboxModeSchema.default("workspace-write"),
    approval: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
    /**
     * Advisory model name recorded into agent-usage telemetry (#206). The
     * harness does NOT inject `-m`, so this is the operator's declared model,
     * not a verified one — best-effort metadata for cost attribution by
     * downstream consumers (#191/#235). Absent → telemetry model stays NULL
     * (no-config byte-stability; DEFAULT_CODEX_MODEL = null).
     */
    model: z.string().min(1).optional(),
    /**
     * (#191) Coder backend for this policy's runs. Absent → codex (env
     * HARNESS_CODER_BACKEND can still opt a no-config run into claude). Enables
     * project A=claude / B=codex from ONE ops driver without env juggling.
     */
    backend: AgentBackendSchema.optional(),
    /** (#191) Advisory claude model when backend=claude (mirror of `model`). */
    claude_model: z.string().min(1).optional(),
  })
  .strict();
export type CodexDefaults = z.infer<typeof CodexDefaultsSchema>;

export const DEFAULT_MAX_DELETED_LINES = 800;
export const DEFAULT_MAX_TOTAL_CHANGED_LINES = 5_000;
export const DEFAULT_MAX_DELETED_FILES = 20;
export const DEFAULT_MAX_CHANGED_FILES = 40;

export const ChangeBudgetSchema = z
  .object({
    max_deleted_lines: z.number().int().nonnegative().optional(),
    max_total_changed_lines: z.number().int().nonnegative().optional(),
    max_deleted_files: z.number().int().nonnegative().optional(),
    max_changed_files: z.number().int().nonnegative().optional(),
    enforce: z.boolean().optional(),
  })
  .strict();
export type ChangeBudgetConfig = z.infer<typeof ChangeBudgetSchema>;

export interface ChangeBudget {
  maxDeletedLines: number;
  maxTotalChangedLines: number;
  maxDeletedFiles: number;
  maxChangedFiles: number;
  enforce: boolean;
}

export const DEFAULT_CHANGE_BUDGET: ChangeBudget = {
  maxDeletedLines: DEFAULT_MAX_DELETED_LINES,
  maxTotalChangedLines: DEFAULT_MAX_TOTAL_CHANGED_LINES,
  maxDeletedFiles: DEFAULT_MAX_DELETED_FILES,
  maxChangedFiles: DEFAULT_MAX_CHANGED_FILES,
  enforce: true,
};

export const LimitsSchema = z
  .object({
    git_timeout_ms: z.number().int().positive().default(30_000),
    change_budget: ChangeBudgetSchema.optional(),
  })
  .strict();
export type Limits = z.infer<typeof LimitsSchema>;

// #410 Phase 2: how a run's workspace is materialized from the target repo.
// `worktree` is the historical default (`git worktree add`, sharing the
// target's `.git`). `clone` is opt-in: an independent local clone so a run
// can never write the target's shared `.git/config` (the core.bare flip in
// #410). Default stays `worktree` so non-self targets are byte-stable.
export const WorkspaceIsolationSchema = z.enum(["worktree", "clone"]);
export type WorkspaceIsolation = z.infer<typeof WorkspaceIsolationSchema>;
export const DEFAULT_WORKSPACE_ISOLATION: WorkspaceIsolation = "worktree";
export const WorkspaceConfigSchema = z
  .object({ isolation: WorkspaceIsolationSchema.default("worktree") })
  .strict();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const GlobalPolicySchema = z
  .object({
    defaults: z
      .object({
        codex: CodexDefaultsSchema.optional(),
      })
      .optional(),
    limits: LimitsSchema.optional(),
    workspace: WorkspaceConfigSchema.optional(),
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

/**
 * Structured form of an allowed command.
 *
 * Operators get:
 *   - shell-escape-free argv invocation (no string splitting surprises)
 *   - per-command timeout / env override on top of commands.defaults
 *   - a stable `id` for log filename and result correlation
 *
 * String entries in commands.allow are kept for backward compat; the
 * resolver lifts them to this shape with auto-generated ids.
 */
export const StructuredCommandSchema = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    cmd: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeout_ms: z.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type StructuredCommand = z.infer<typeof StructuredCommandSchema>;

export const CommandEntrySchema = z.union([
  z.string().min(1),
  StructuredCommandSchema,
]);
export type CommandEntry = z.infer<typeof CommandEntrySchema>;

export const DomainPolicySchema = z
  .object({
    read: z.array(Glob).default([]),
    write: z.array(Glob).default([]),
    deny_write: z.array(Glob).default([]),
    commands: z
      .object({
        allow: z.array(CommandEntrySchema).default([]),
        defaults: CommandDefaultsSchema.optional(),
      })
      .optional(),
    change_budget: ChangeBudgetSchema.optional(),
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

/**
 * One allowed command after resolution. String entries from YAML are
 * lifted to `{ id: "cmd-<idx>", cmd: <raw-string>, args: [], shell: true }`
 * so runner is uniform.
 */
export interface ResolvedCommand {
  id: string;
  /** when `shell` is true, this is the whole `sh -c` argument; otherwise it's argv[0]. */
  cmd: string;
  args: string[];
  /** true → runner uses `sh -c cmd`; false → spawn(cmd, args). */
  shell: boolean;
  /** per-command timeout override (overrides commandDefaults.timeoutMs). */
  timeoutMs?: number;
  /** per-command env overrides merged on top of the env-allowlist-filtered process.env. */
  env?: Record<string, string>;
}

export interface ResolvedPolicy {
  repoId: string;
  domain: string;
  read: string[];
  write: string[];
  denyWrite: string[];
  allowedCommands: ResolvedCommand[];
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
    /** Advisory model for agent-usage telemetry (#206); absent → NULL. */
    model?: string;
    /** (#191) Coder backend; absent → codex (env can still opt into claude). */
    backend?: AgentBackend;
    /** (#191) Advisory claude model when backend=claude; absent → NULL. */
    claudeModel?: string;
  };
  limits: {
    gitTimeoutMs: number;
    changeBudget: ChangeBudget;
  };
  /**
   * (#410 Phase 2) Run workspace isolation mode. Always present after
   * resolution — defaults to "worktree" so every run path can branch on it.
   */
  workspace: {
    isolation: WorkspaceIsolation;
  };
}

export const DEFAULT_CODEX_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_GIT_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
