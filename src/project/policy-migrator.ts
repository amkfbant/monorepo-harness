import type { ZodError } from "zod";
import type { RepoPolicy } from "../policy/schema.js";
import { ProjectProfileSchema, type ProjectProfile } from "./schema.js";
import { ProjectProfileError } from "./errors.js";

/**
 * Policy migrator (Phase 5-5).
 *
 * Converts an existing hand-written `policies/repos/<id>.yaml` into a
 * project profile. Domain scopes are carried over verbatim as explicit
 * `read`/`write`/`deny_write`, so the compiled policy stays equivalent to
 * the original — the policy template only supplies repo-wide globals.
 */

export interface MigrateOpts {
  projectId: string;
  /** policy template the migrated profile references (for globals) */
  policyTemplate: string;
  /** optional repo path to embed in the profile */
  repoPath?: string;
}

export function migratePolicyToProfile(
  repoPolicy: RepoPolicy,
  opts: MigrateOpts,
): ProjectProfile {
  const domains = Object.entries(repoPolicy.domains).map(([id, d]) => {
    // resolvePolicy unions repo-level read into every domain; fold it in so
    // the migrated profile keeps the same effective read scope.
    const read = uniq([...repoPolicy.read, ...d.read]);
    // ALWAYS set read/write/deny_write — even when empty — so the compiler
    // uses these explicit scopes instead of falling back to template
    // defaults. An original `write: []` domain must stay non-writable.
    const domain: Record<string, unknown> = {
      id,
      // legacy repo policies key domains by their path, so id doubles as root.
      root: id,
      read,
      write: d.write,
      deny_write: d.deny_write,
    };
    if (d.commands !== undefined && d.commands.allow.length > 0) {
      domain.commands = {
        allow: d.commands.allow,
        ...(d.commands.defaults !== undefined
          ? { defaults: d.commands.defaults }
          : {}),
      };
    }
    return domain;
  });

  const raw: Record<string, unknown> = {
    version: 1,
    project_id: opts.projectId,
    description: `Migrated from policies/repos/${repoPolicy.repo_id}.yaml`,
    repo: {
      id: repoPolicy.repo_id,
      ...(opts.repoPath !== undefined ? { path: opts.repoPath } : {}),
    },
    policy: { template: opts.policyTemplate },
    domains,
  };

  const result = ProjectProfileSchema.safeParse(raw);
  if (!result.success) {
    throw new ProjectProfileError(
      `cannot migrate policy "${repoPolicy.repo_id}" to a profile:\n${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}
