import { z } from "zod";
import { SafeGlob } from "./schema.js";
import type { ContextPackSpec } from "./schema.js";
import { TemplateId } from "./template-schema.js";

/**
 * Context pack catalog preset (Phase 5-2).
 *
 * A context pack is explicit reference material attached to the Codex
 * prompt. It is distinct from `knowledgeContext`. Both the inline form
 * (`ContextPackSpec` in schema.ts) and this catalog preset normalize to
 * `NormalizedContextPack`, which the runtime builder (Phase 5-7) consumes.
 */

/** default per-pack byte cap, mirroring MAX_KNOWLEDGE_CONTEXT_BYTES. */
export const DEFAULT_CONTEXT_PACK_MAX_BYTES = 32 * 1024;

export const ContextPackPresetSchema = z
  .object({
    version: z.literal(1),
    pack_id: TemplateId,
    description: z.string().optional(),
    globs: z.array(SafeGlob).min(1),
    max_bytes: z.number().int().positive().optional(),
    deny_secret_like: z.boolean().optional(),
    binary: z.enum(["skip", "error"]).optional(),
    missing: z.enum(["warn", "error", "ignore"]).optional(),
  })
  .strict();
export type ContextPackPreset = z.infer<typeof ContextPackPresetSchema>;

/** A context pack after defaults are applied — the form the builder uses. */
export interface NormalizedContextPack {
  id: string;
  description?: string;
  globs: string[];
  maxBytes: number;
  /** reject (or redact) files whose name/content looks secret-shaped */
  denySecretLike: boolean;
  /** what to do with a binary file matched by a glob */
  binary: "skip" | "error";
  /** what to do when a glob matches no file */
  missing: "warn" | "error" | "ignore";
}

export function normalizeContextPackPreset(
  preset: ContextPackPreset,
): NormalizedContextPack {
  return {
    id: preset.pack_id,
    ...(preset.description !== undefined
      ? { description: preset.description }
      : {}),
    globs: [...preset.globs],
    maxBytes: preset.max_bytes ?? DEFAULT_CONTEXT_PACK_MAX_BYTES,
    denySecretLike: preset.deny_secret_like ?? true,
    binary: preset.binary ?? "skip",
    missing: preset.missing ?? "warn",
  };
}

/** Normalize an inline profile context pack (`profile.context_packs[id]`). */
export function normalizeInlineContextPack(
  id: string,
  spec: ContextPackSpec,
): NormalizedContextPack {
  return {
    id,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    globs: [...spec.globs],
    maxBytes: spec.max_bytes ?? DEFAULT_CONTEXT_PACK_MAX_BYTES,
    denySecretLike: spec.deny_secret_like ?? true,
    binary: "skip",
    missing: "warn",
  };
}
