import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z, type ZodError } from "zod";
import { DomainKindSchema } from "./schema.js";
import { TEMPLATE_ID_RE, TemplateId } from "./template-schema.js";
import { ProjectTemplateError } from "./errors.js";

/**
 * Domain registry schema and loader (Phase 5-3).
 *
 * A domain registry is a reusable catalog of patterns that `project
 * inspect` matches against a target repo to propose candidate domains.
 * Each pattern maps a directory glob to a domain kind plus suggested
 * command presets / context packs.
 */

export const RegistryPatternSchema = z
  .object({
    /** id template with a `{name}` placeholder, e.g. `apps/{name}` */
    id_template: z.string().min(1),
    /** directory glob matched against repo-relative dir paths, e.g. `apps/*` */
    root_glob: z.string().min(1),
    kind: DomainKindSchema,
    // catalog ids — validated as TemplateId so an invalid reference is
    // caught here, not deep inside a later init/check flow.
    command_presets: z.array(TemplateId).default([]),
    context_packs: z.array(TemplateId).default([]),
  })
  .strict();
export type RegistryPattern = z.infer<typeof RegistryPatternSchema>;

export const DomainRegistrySchema = z
  .object({
    version: z.literal(1),
    registry_id: TemplateId,
    description: z.string().optional(),
    /** repo-wide policy template suggested for projects built from this registry */
    suggested_policy_template: TemplateId.optional(),
    patterns: z.array(RegistryPatternSchema).min(1),
  })
  .strict();
export type DomainRegistry = z.infer<typeof DomainRegistrySchema>;

/** Load `templates/domain-registries/<id>.yaml`. */
export async function loadDomainRegistry(
  templatesDir: string,
  id: string,
): Promise<DomainRegistry> {
  if (!TEMPLATE_ID_RE.test(id) || id.includes("..")) {
    throw new ProjectTemplateError(
      `invalid domain registry id: ${JSON.stringify(id)}`,
    );
  }
  const path = join(templatesDir, "domain-registries", `${id}.yaml`);
  if (!existsSync(path)) {
    throw new ProjectTemplateError(
      `no domain registry "${id}" (expected ${path})`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new ProjectTemplateError(
      `cannot read domain registry "${id}": ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new ProjectTemplateError(
      `domain registry "${id}" is not valid YAML: ${(e as Error).message}`,
    );
  }

  const result = DomainRegistrySchema.safeParse(parsed);
  if (!result.success) {
    throw new ProjectTemplateError(
      `domain registry "${id}" failed validation:\n${formatZodError(result.error)}`,
    );
  }
  if (result.data.registry_id !== id) {
    throw new ProjectTemplateError(
      `domain registry "${id}" declares a mismatched registry_id ${JSON.stringify(result.data.registry_id)}`,
    );
  }
  return result.data;
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}
