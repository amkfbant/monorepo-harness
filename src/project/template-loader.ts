import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z, ZodError } from "zod";
import { ProjectTemplateError } from "./errors.js";
import {
  PolicyTemplateSchema,
  TEMPLATE_ID_RE,
  type PolicyTemplate,
} from "./template-schema.js";
import { CommandPresetSchema, type CommandPreset } from "./command-preset.js";
import {
  ContextPackPresetSchema,
  type ContextPackPreset,
} from "./context-pack-spec.js";

/**
 * Loaders for the reusable template catalogs under `templates/` (Phase 5-2):
 * `templates/policy/`, `templates/commands/`, `templates/context-packs/`.
 *
 * Override / extend rule: a catalog entry is the *baseline*. A project
 * profile overrides it by inline definition — a domain's explicit
 * `read`/`write`/`deny_write` override the policy template's
 * `domain_defaults` (merged by the compiler in Phase 5-4); a profile
 * `context_packs[name]` entry shadows a catalog preset of the same name.
 * Catalog entries are never mutated; resolution is pure precedence.
 */

function assertValidTemplateId(id: string): void {
  if (!TEMPLATE_ID_RE.test(id) || id.includes("..")) {
    throw new ProjectTemplateError(
      `invalid template/preset id: ${JSON.stringify(id)} (allowed: [A-Za-z0-9][A-Za-z0-9._-]{0,63}, no '..')`,
    );
  }
}

async function loadCatalogEntry<S extends z.ZodTypeAny>(
  kind: string,
  templatesDir: string,
  subdir: string,
  id: string,
  schema: S,
  idField: keyof z.infer<S>,
): Promise<z.infer<S>> {
  assertValidTemplateId(id);
  const path = join(templatesDir, subdir, `${id}.yaml`);
  if (!existsSync(path)) {
    throw new ProjectTemplateError(`no ${kind} "${id}" (expected ${path})`);
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new ProjectTemplateError(
      `cannot read ${kind} "${id}": ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new ProjectTemplateError(
      `${kind} "${id}" is not valid YAML: ${(e as Error).message}`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ProjectTemplateError(
      `${kind} "${id}" failed validation:\n${formatZodError(result.error)}`,
    );
  }
  // the declared id must match the filename, mirroring repo_id ↔ filename.
  const declared = result.data[idField];
  if (declared !== id) {
    throw new ProjectTemplateError(
      `${kind} "${id}" declares a mismatched id ${JSON.stringify(declared)}`,
    );
  }
  return result.data;
}

export function loadPolicyTemplate(
  templatesDir: string,
  id: string,
): Promise<PolicyTemplate> {
  return loadCatalogEntry(
    "policy template",
    templatesDir,
    "policy",
    id,
    PolicyTemplateSchema,
    "template_id",
  );
}

export function loadCommandPreset(
  templatesDir: string,
  id: string,
): Promise<CommandPreset> {
  return loadCatalogEntry(
    "command preset",
    templatesDir,
    "commands",
    id,
    CommandPresetSchema,
    "preset_id",
  );
}

export function loadContextPackPreset(
  templatesDir: string,
  id: string,
): Promise<ContextPackPreset> {
  return loadCatalogEntry(
    "context pack preset",
    templatesDir,
    "context-packs",
    id,
    ContextPackPresetSchema,
    "pack_id",
  );
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}
