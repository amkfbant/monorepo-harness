// read-tools 公開 MCP tool factory（#125 A15 barrel 分割）。

import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, ok } from "../schemas/outputs.js";

import type { McpToolContext } from "../registry/tool-registry.js";

import { ensureProjectVisible, withReadonlyDb } from "./tool-helpers.js";
import type { DomainListArgs, PolicyEffectiveArgs, PolicySnapshotArgs, ProjectGetArgs } from "./read-types.js";
import { allVisibleDomains, domainsForProject, latestEffectivePolicySnapshot, toPolicySnapshot } from "./read-helpers.js";

export function projectListTool(
  args: { includeArchived?: boolean },
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const allowed = context.config.allowedProjects;
    const rows = db
      .prepare(
        `SELECT project_id, repo_id, profile_path, profile_version,
                description, repo_path, base_branch, package_manager,
                created_at, updated_at, current_profile_revision_id
           FROM projects
          ORDER BY project_id`,
      )
      .all() as Record<string, unknown>[];
    const projects = rows
      .filter((r) =>
        allowed.length === 0
          ? true
          : allowed.includes(r.project_id as string),
      )
      .map((r) => ({
        projectId: r.project_id as string,
        repoId: r.repo_id as string,
        currentProfileRevisionId:
          (r.current_profile_revision_id as number | null) ?? null,
        description: (r.description as string | null) ?? null,
        repoPath: (r.repo_path as string | null) ?? null,
        baseBranch: (r.base_branch as string | null) ?? null,
        packageManager: (r.package_manager as string | null) ?? null,
        domains: domainsForProject(db, r.project_id as string).map((d) => d.domainId),
        health: "unknown",
      }));
    return ok(`listed ${projects.length} project(s)`, {
      projects,
      includeArchived: args.includeArchived === true,
    });
  }) as HarnessMcpToolResult;
}

export function projectGetTool(
  args: ProjectGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare(
        `SELECT project_id, repo_id, profile_path, profile_version,
                description, repo_path, base_branch, package_manager,
                created_at, updated_at, current_profile_revision_id
           FROM projects WHERE project_id = ?`,
      )
      .get(args.projectId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return errorResult(`project not found: ${args.projectId}`);
    }
    const domains = domainsForProject(db, args.projectId);
    return {
      status: "ok",
      summary: `project ${args.projectId}`,
      data: {
        project: {
          projectId: row.project_id,
          repoId: row.repo_id,
          currentProfileRevisionId:
            (row.current_profile_revision_id as number | null) ?? null,
          profilePath: (row.profile_path as string | null) ?? null,
          profileVersion: (row.profile_version as number | null) ?? null,
          description: (row.description as string | null) ?? null,
          repoPath: (row.repo_path as string | null) ?? null,
          baseBranch: (row.base_branch as string | null) ?? null,
          packageManager: (row.package_manager as string | null) ?? null,
          createdAt: (row.created_at as string | null) ?? null,
          updatedAt: (row.updated_at as string | null) ?? null,
        },
        domains,
      },
      resourceLinks: [
        {
          uri: `harness://project/${encodeURIComponent(args.projectId)}`,
          name: "Project",
          mimeType: "application/json",
        },
        {
          uri: `harness://project/${encodeURIComponent(args.projectId)}/profile`,
          name: "Project profile",
          mimeType: "application/json",
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function domainListTool(
  args: DomainListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const domains =
      args.projectId === undefined
        ? allVisibleDomains(db, context)
        : domainsForProject(db, args.projectId);
    return ok(`listed ${domains.length} domain(s)`, { domains });
  }) as HarnessMcpToolResult;
}

export async function policyGetEffectiveTool(
  args: PolicyEffectiveArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  return withReadonlyDb(context, ({ db }) => {
    const snapshot = latestEffectivePolicySnapshot(
      db,
      args.projectId,
      args.domain,
      true,
    );
    if (snapshot === null) {
      return errorResult(
        `no effective policy snapshot for ${args.projectId}/${args.domain}`,
        { projectId: args.projectId, domain: args.domain },
      );
    }
    return {
      status: "ok",
      summary: `effective policy for ${args.projectId}/${args.domain}`,
      data: {
        projectId: snapshot.projectId,
        repoId: snapshot.repoId,
        domain: args.domain,
        snapshot,
      },
      resourceLinks: [
        {
          uri: `harness://project/${encodeURIComponent(args.projectId)}/policy/effective`,
          name: "Effective policy",
          mimeType: "application/json",
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function policySnapshotGetTool(
  args: PolicySnapshotArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare(
        `SELECT snapshot_id, run_id, project_id, repo_id, domain,
                template_revision_id, generated_policy_yaml,
                generated_policy_sha256, provenance_json, created_at
           FROM effective_policy_snapshots
          WHERE snapshot_id = ?`,
      )
      .get(args.snapshotId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return errorResult(`policy snapshot not found: ${args.snapshotId}`);
    }
    const denied = ensureProjectVisible(
      context.config,
      (row.project_id as string | null) ?? null,
    );
    if (denied !== null) return denied;
    return ok(`policy snapshot ${args.snapshotId}`, {
      snapshot: toPolicySnapshot(row),
    });
  }) as HarnessMcpToolResult;
}
