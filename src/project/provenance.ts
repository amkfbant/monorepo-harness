import { z } from "zod";

/**
 * Generated-policy provenance (Phase 5-4).
 *
 * When a repo policy is compiled from a project profile, the provenance
 * is written to a sidecar `policies/repos/<repo-id>.generated.json` — NOT
 * embedded in the policy YAML, which stays a plain `RepoPolicySchema`
 * document. `project check` compares this sidecar against the profile to
 * detect drift.
 */

const CatalogRefSchema = z
  .object({ id: z.string(), version: z.number() })
  .strict();

/** A catalog entry referenced during compilation: its id and version. */
export type CatalogRef = z.infer<typeof CatalogRefSchema>;

export const PolicyProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string(),
    repoId: z.string(),
    /** profile path, relative to the harness root when possible */
    profilePath: z.string(),
    profileVersion: z.number(),
    policyTemplate: CatalogRefSchema.nullable(),
    commandPresets: z.array(CatalogRefSchema),
    contextPackPresets: z.array(CatalogRefSchema),
    domainRegistry: CatalogRefSchema.nullable(),
    /** ISO-8601 instant the policy was generated */
    generatedAt: z.string(),
  })
  .strict();
export type PolicyProvenance = z.infer<typeof PolicyProvenanceSchema>;

/** Serialize provenance to the sidecar JSON form (stable key order). */
export function serializeProvenance(p: PolicyProvenance): string {
  return `${JSON.stringify(p, null, 2)}\n`;
}

/**
 * Parse a sidecar provenance file. Returns null on any malformed input
 * (including malformed nested catalog refs) — `project check` treats an
 * unreadable sidecar as "drift / regenerate".
 */
export function parseProvenance(raw: string): PolicyProvenance | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = PolicyProvenanceSchema.safeParse(doc);
  return result.success ? result.data : null;
}
