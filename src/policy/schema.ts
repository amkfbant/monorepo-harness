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
  })
  .strict();
export type CodexDefaults = z.infer<typeof CodexDefaultsSchema>;

export const GlobalPolicySchema = z
  .object({
    defaults: z
      .object({
        codex: CodexDefaultsSchema.optional(),
      })
      .optional(),
    always_deny_write: z.array(Glob).default([]),
    commands: z
      .object({
        default_allow: z.array(z.string()).default([]),
      })
      .optional(),
  })
  .strict();
export type GlobalPolicy = z.infer<typeof GlobalPolicySchema>;

export const DomainPolicySchema = z
  .object({
    read: z.array(Glob).default([]),
    write: z.array(Glob).default([]),
    deny_write: z.array(Glob).default([]),
    commands: z
      .object({
        allow: z.array(z.string()).default([]),
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
  codex: {
    sandbox: SandboxMode;
    approval?: string;
  };
}
