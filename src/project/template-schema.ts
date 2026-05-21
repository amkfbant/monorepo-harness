import { z } from "zod";
import { CodexDefaultsSchema, LimitsSchema } from "../policy/schema.js";
import { DomainKindSchema, SafeGlob } from "./schema.js";

/**
 * Policy template schema (Phase 5-2).
 *
 * A policy template supplies the default read / write / deny scopes per
 * domain kind, plus repo-wide defaults. The read/write/deny strings may
 * contain the placeholder tokens `{root}`, `{other_domain_roots}` and
 * `{root_deny}`, which the policy compiler (Phase 5-4) expands per domain
 * — so they are kept as raw strings here, NOT validated as concrete globs.
 */

// catalog ids are interpolated into filesystem paths (templates/<kind>/<id>.yaml)
// so they obey the same no-separator / no-`..` constraint as repo ids.
export const TEMPLATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const TemplateId = z
  .string()
  .refine((s) => TEMPLATE_ID_RE.test(s) && !s.includes(".."), {
    message: "must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} and contain no '..'",
  });

const TemplateString = z.string().min(1);

const DomainDefaultSchema = z
  .object({
    read: z.array(TemplateString).optional(),
    write: z.array(TemplateString).optional(),
    deny_write: z.array(TemplateString).optional(),
  })
  .strict();
export type DomainDefault = z.infer<typeof DomainDefaultSchema>;

export const PolicyTemplateSchema = z
  .object({
    version: z.literal(1),
    template_id: TemplateId,
    description: z.string().optional(),
    defaults: z
      .object({
        codex: CodexDefaultsSchema.optional(),
        limits: LimitsSchema.optional(),
      })
      .strict()
      .optional(),
    // ignore_untracked / root_deny are concrete globs (no {placeholders}),
    // so validate them as real globs up front rather than deferring to the
    // compiler.
    ignore_untracked: z.array(SafeGlob).optional(),
    root_deny: z.array(SafeGlob).optional(),
    domain_defaults: z.record(DomainKindSchema, DomainDefaultSchema).optional(),
  })
  .strict();
export type PolicyTemplate = z.infer<typeof PolicyTemplateSchema>;

export { TemplateId };
