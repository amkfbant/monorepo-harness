import { z } from "zod";
import { minimatch } from "minimatch";
import { CommandEntrySchema, CommandDefaultsSchema } from "../policy/schema.js";

/**
 * Project profile schema (Phase 5).
 *
 * A profile (`projects/<project-id>.yaml`) is the operator-facing source
 * of truth for one target repo. It is compiled down to the existing
 * `RepoPolicy` / `GlobalPolicy` for execution — see policy-compiler.ts.
 */

/** raw string can never be a safe repo-internal path token. */
function isUnsafePathString(s: string): boolean {
  return (
    s.length === 0 ||
    s.includes("\0") ||
    s.includes("\\") ||
    s.startsWith("/") ||
    /^[A-Za-z]:/.test(s)
  );
}

/** `..` escapes the repo; `.` creates a canonical alias of another path. */
function hasUnsafeSegment(s: string): boolean {
  return s.split("/").some((seg) => seg === ".." || seg === ".");
}

// project_id / repo.id are interpolated into filesystem paths, so they obey
// the same constraint as `assertValidRepoId` (no separators, no `..`).
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ProjectId = z
  .string()
  .refine((s) => PROJECT_ID_RE.test(s) && !s.includes(".."), {
    message:
      "must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} and contain no '..'",
  });

// domain id keeps `/` for backward compat (`apps/catalog`), but must stay a
// safe relative-path-like token: no empty, NUL, backslash, absolute, `..`,
// `.` segment, leading/trailing slash, or doubled slash.
const DOMAIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** True when `s` is a safe domain id (also used by the inspector). */
export function isValidDomainId(s: string): boolean {
  return (
    DOMAIN_ID_RE.test(s) &&
    !s.includes("\0") &&
    !s.includes("\\") &&
    !s.endsWith("/") &&
    !s.includes("//") &&
    !hasUnsafeSegment(s)
  );
}

const DomainId = z.string().refine(isValidDomainId, {
  message:
    "invalid domain id (allowed: [A-Za-z0-9][A-Za-z0-9._/-], no '.'/'..' segment, no leading/trailing/doubled '/')",
});

/** repo-relative path used for `domain.root`. `.` (repo root) is allowed. */
const RepoRelPath = z.string().refine(
  (s) => s === "." || (!isUnsafePathString(s) && !hasUnsafeSegment(s)),
  { message: "must be a safe repo-relative path (no '..'/'.' segment, no absolute path)" },
);

/**
 * A minimatch glob used in read/write/deny/context scopes. Evaluated
 * repo-root-anchored. Beyond the raw-string check, the glob is brace-
 * expanded and EVERY branch is validated — otherwise `{..,docs}/**`
 * would slip a `../**` branch past a naive `..` check and, once context
 * pack collection lands, enumerate files outside the repo.
 */
export const SafeGlob = z.string().refine((s) => isSafeGlob(s), {
  message:
    "unsafe glob (no '..'/'.' segment, no absolute path, no backslash; brace expansions are checked too)",
});

function isSafeGlob(s: string): boolean {
  if (isUnsafePathString(s)) return false;
  let branches: string[];
  try {
    branches = minimatch.braceExpand(s);
  } catch {
    return false;
  }
  // a glob with no braces expands to [s]; with braces, every branch counts.
  return branches.every(
    (b) => !isUnsafePathString(b) && !hasUnsafeSegment(b),
  );
}

export const PackageManagerSchema = z.enum([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "none",
  "unknown",
]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const DomainKindSchema = z.enum([
  "app",
  "package",
  "service",
  "docs",
  "other",
]);
export type DomainKind = z.infer<typeof DomainKindSchema>;

/** An inline context pack defined within a profile (vs. a catalog preset). */
export const ContextPackSpecSchema = z
  .object({
    description: z.string().optional(),
    globs: z.array(SafeGlob).min(1),
    max_bytes: z.number().int().positive().optional(),
    deny_secret_like: z.boolean().optional(),
  })
  .strict();
export type ContextPackSpec = z.infer<typeof ContextPackSpecSchema>;

export const ProjectDomainSchema = z
  .object({
    id: DomainId,
    root: RepoRelPath,
    kind: DomainKindSchema.optional(),
    title: z.string().optional(),
    read: z.array(SafeGlob).optional(),
    write: z.array(SafeGlob).optional(),
    deny_write: z.array(SafeGlob).optional(),
    command_presets: z.array(z.string().min(1)).optional(),
    commands: z
      .object({
        allow: z.array(CommandEntrySchema).default([]),
        defaults: CommandDefaultsSchema.optional(),
      })
      .strict()
      .optional(),
    context_packs: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ProjectDomain = z.infer<typeof ProjectDomainSchema>;

export const ProjectProfileSchema = z
  .object({
    version: z.literal(1),
    project_id: ProjectId,
    description: z.string().optional(),
    repo: z
      .object({
        id: ProjectId,
        // a filesystem path (relative to the profile file, or absolute) —
        // legitimately contains `..` (e.g. `../mini-commerce`), so it is
        // NOT run through the repo-internal safe-path check. A NUL byte is
        // never legitimate and would corrupt path resolution, so reject it.
        path: z
          .string()
          .min(1)
          .refine((s) => !s.includes("\0"), {
            message: "repo.path must not contain a NUL byte",
          })
          .optional(),
        base_branch: z.string().min(1).optional(),
        package_manager: PackageManagerSchema.optional(),
      })
      .strict(),
    policy: z
      .object({
        template: z.string().min(1).optional(),
        global_deny: z.array(SafeGlob).optional(),
      })
      .strict()
      .optional(),
    context_packs: z.record(z.string().min(1), ContextPackSpecSchema).optional(),
    commands: z
      .object({ presets: z.array(z.string().min(1)).optional() })
      .strict()
      .optional(),
    mcp: z.record(z.string(), z.unknown()).optional(),
    domains: z.array(ProjectDomainSchema).min(1),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const seenIds = new Set<string>();
    const seenRoots = new Set<string>();
    profile.domains.forEach((d, i) => {
      if (seenIds.has(d.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate domain id: ${d.id}`,
          path: ["domains", i, "id"],
        });
      }
      seenIds.add(d.id);
      if (seenRoots.has(d.root)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate domain root: ${d.root}`,
          path: ["domains", i, "root"],
        });
      }
      seenRoots.add(d.root);
    });
  });
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
