import { z } from "zod";
import type { StructuredCommand } from "../policy/schema.js";
import { TemplateId } from "./template-schema.js";

/**
 * Command preset schema (Phase 5-2).
 *
 * A preset is a reusable list of verification commands. Entries are either
 * a concrete structured command, or an abstract `package_script` command
 * that the compiler resolves against a target repo's package manager.
 *
 * The compiled output is the existing policy `StructuredCommand` shape, so
 * presets feed straight into a domain's `commands.allow`.
 */

const CommandId = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** package manager tools a package_script command can target. */
export const PackageManagerToolSchema = z.enum(["npm", "pnpm", "yarn", "bun"]);
export type PackageManagerTool = z.infer<typeof PackageManagerToolSchema>;

/** A concrete command. `cmd`/`args` may use `{domain_root}` placeholders. */
export const PlainPresetCommandSchema = z
  .object({
    id: CommandId,
    cmd: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeout_ms: z.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type PlainPresetCommand = z.infer<typeof PlainPresetCommandSchema>;

const PackageManagerInvocationSchema = z
  .object({
    cmd: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();

/**
 * An abstract command bound to a package script. The compiler picks the
 * invocation matching the repo's package manager and substitutes
 * `{package_name}` / `{domain_root}` placeholders.
 */
export const PackageScriptCommandSchema = z
  .object({
    id: CommandId,
    kind: z.literal("package_script"),
    package_scope: z.enum(["domain", "root"]),
    script: z.string().min(1),
    package_managers: z
      .record(PackageManagerToolSchema, PackageManagerInvocationSchema)
      .refine((m) => Object.keys(m).length > 0, {
        message: "package_managers must define at least one tool",
      }),
    timeout_ms: z.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type PackageScriptCommand = z.infer<typeof PackageScriptCommandSchema>;

export const PresetCommandSchema = z.union([
  PackageScriptCommandSchema,
  PlainPresetCommandSchema,
]);
export type PresetCommand = z.infer<typeof PresetCommandSchema>;

export const CommandPresetSchema = z
  .object({
    version: z.literal(1),
    preset_id: TemplateId,
    description: z.string().optional(),
    defaults: z
      .object({
        timeout_ms: z.number().int().positive().optional(),
        env_allowlist: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    commands: z.array(PresetCommandSchema).default([]),
  })
  .strict();
export type CommandPreset = z.infer<typeof CommandPresetSchema>;

/** Context the compiler supplies to resolve an abstract command. */
export interface CommandCompileContext {
  /** repo-relative root of the domain (e.g. `apps/catalog`) */
  domainRoot: string;
  /** the repo's package manager, when known */
  packageManager?: PackageManagerTool;
  /** the domain package's name from its package.json, when known */
  packageName?: string;
}

export type CompiledCommand =
  | { ok: true; command: StructuredCommand }
  | { ok: false; reason: string };

/**
 * Compile one preset command into a concrete `StructuredCommand`, or
 * report why it was skipped (unknown package manager, missing package
 * name, unresolved placeholder). Pure — no filesystem access.
 */
export function compilePresetCommand(
  entry: PresetCommand,
  ctx: CommandCompileContext,
): CompiledCommand {
  return "kind" in entry
    ? compilePackageScript(entry, ctx)
    : compilePlain(entry, ctx);
}

function compilePlain(
  entry: PlainPresetCommand,
  ctx: CommandCompileContext,
): CompiledCommand {
  const vars = placeholderVars(ctx);
  const cmd = substitute(entry.cmd, vars);
  if (!cmd.ok) return { ok: false, reason: `command ${entry.id}: ${cmd.reason}` };
  const args: string[] = [];
  for (const a of entry.args) {
    const r = substitute(a, vars);
    if (!r.ok) return { ok: false, reason: `command ${entry.id}: ${r.reason}` };
    args.push(r.value);
  }
  return {
    ok: true,
    command: {
      id: entry.id,
      cmd: cmd.value,
      args,
      ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}),
      ...(entry.env !== undefined ? { env: entry.env } : {}),
    },
  };
}

function compilePackageScript(
  entry: PackageScriptCommand,
  ctx: CommandCompileContext,
): CompiledCommand {
  if (ctx.packageManager === undefined) {
    return {
      ok: false,
      reason: `command ${entry.id}: package manager unknown — cannot resolve package_script`,
    };
  }
  const invocation = entry.package_managers[ctx.packageManager];
  if (invocation === undefined) {
    return {
      ok: false,
      reason: `command ${entry.id}: no invocation for package manager '${ctx.packageManager}'`,
    };
  }
  const vars = placeholderVars(ctx);
  const cmd = substitute(invocation.cmd, vars);
  if (!cmd.ok) return { ok: false, reason: `command ${entry.id}: ${cmd.reason}` };
  const args: string[] = [];
  for (const a of invocation.args) {
    const r = substitute(a, vars);
    if (!r.ok) return { ok: false, reason: `command ${entry.id}: ${r.reason}` };
    args.push(r.value);
  }
  return {
    ok: true,
    command: {
      id: entry.id,
      cmd: cmd.value,
      args,
      ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}),
      ...(entry.env !== undefined ? { env: entry.env } : {}),
    },
  };
}

function placeholderVars(ctx: CommandCompileContext): Record<string, string> {
  const vars: Record<string, string> = { domain_root: ctx.domainRoot };
  if (ctx.packageName !== undefined) vars.package_name = ctx.packageName;
  return vars;
}

type SubstituteResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

const KNOWN_PLACEHOLDER_RE = /\{([a-z_]+)\}/g;
// any brace token left after substitution — a typo (`{domain-root}`,
// `{packageName}`, `{xyz}`) — must NOT compile into an argv literal.
const ANY_BRACE_TOKEN_RE = /\{[^{}]*\}/;

/**
 * Replace `{key}` tokens from `vars`. An unresolved or misspelled
 * placeholder is an error — a command must never run with a literal
 * `{package_name}` (or `{domain-root}`) baked into its argv.
 */
function substitute(
  template: string,
  vars: Record<string, string>,
): SubstituteResult {
  const value = template.replace(
    KNOWN_PLACEHOLDER_RE,
    (whole, key: string) => vars[key] ?? whole,
  );
  const leftover = value.match(ANY_BRACE_TOKEN_RE);
  if (leftover !== null) {
    return { ok: false, reason: `unresolved placeholder ${leftover[0]}` };
  }
  return { ok: true, value };
}
