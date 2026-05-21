import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ZodError } from "zod";
import { ProjectProfileSchema, type ProjectProfile } from "./schema.js";
import { ProjectProfileError } from "./errors.js";

/**
 * Load and validate a project profile from a YAML file.
 *
 * Every failure mode (unreadable file, malformed YAML, schema violation)
 * surfaces as `ProjectProfileError` with a human-readable message, so the
 * CLI can map it to exit code 1 without leaking stack traces.
 */
export async function loadProjectProfile(
  path: string,
): Promise<ProjectProfile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new ProjectProfileError(
      `cannot read project profile: ${path} (${(e as Error).message})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new ProjectProfileError(
      `project profile is not valid YAML: ${path} (${(e as Error).message})`,
    );
  }

  const result = ProjectProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProjectProfileError(
      `project profile failed validation: ${path}\n${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}
