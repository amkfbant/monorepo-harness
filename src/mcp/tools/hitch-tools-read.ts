// hitch read MCP tool factory（list/get/status/findings/decisions）。

import { ConvergenceService } from "../../hitch/convergence.js";

import { HitchRepository } from "../../hitch/repository.js";

import { errorResult, ok, type HarnessMcpToolResult } from "../schemas/outputs.js";

import type { McpToolContext } from "../registry/tool-registry.js";

import { ensureProjectVisible, withReadonlyDb } from "./tool-helpers.js";
import type { HitchIdArgs, HitchListArgs } from "./hitch-tools-types.js";
import { MAX_MCP_FINDINGS } from "./hitch-tools-types.js";
import { compareHitchSessions, mcpFindingPage } from "./hitch-tools-helpers.js";

export function hitchListTool(
  args: HitchListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const limit = args.limit ?? 50;
    const baseFilter = {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      ...(args.domain !== undefined ? { domain: args.domain } : {}),
      limit,
    };
    const hitches =
      args.projectId !== undefined || context.config.allowedProjects.length === 0
        ? repo.listSessions({
            ...baseFilter,
            ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
          })
        : context.config.allowedProjects
            .flatMap((projectId) => repo.listSessions({ ...baseFilter, projectId }))
            .sort(compareHitchSessions)
            .slice(0, limit);
    return ok("hitch sessions", { hitches });
  }) as HarnessMcpToolResult;
}

export function hitchGetTool(
  args: HitchIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const hitch = repo.getSession(args.hitchId);
    if (hitch === null) return errorResult(`hitch not found: ${args.hitchId}`);
    const denied = ensureProjectVisible(context.config, hitch.projectId);
    if (denied !== null) return denied;
    return ok("hitch session", { hitch });
  }) as HarnessMcpToolResult;
}

export function hitchStatusTool(
  args: HitchIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const hitch = repo.getSession(args.hitchId);
    if (hitch === null) return errorResult(`hitch not found: ${args.hitchId}`);
    const denied = ensureProjectVisible(context.config, hitch.projectId);
    if (denied !== null) return denied;
    const findings = mcpFindingPage(repo, args.hitchId);
    const decisions = repo.listDecisions(args.hitchId);
    const convergence = new ConvergenceService(repo).evaluate(args.hitchId);
    return ok("hitch status", {
      hitch,
      findings: findings.findings,
      findingsTruncated: findings.truncated,
      decisions,
      convergence,
    });
  }) as HarnessMcpToolResult;
}

export function hitchFindingsTool(
  args: HitchIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const hitch = repo.getSession(args.hitchId);
    if (hitch === null) return errorResult(`hitch not found: ${args.hitchId}`);
    const denied = ensureProjectVisible(context.config, hitch.projectId);
    if (denied !== null) return denied;
    const findings = mcpFindingPage(repo, args.hitchId);
    return ok("hitch findings", {
      findings: findings.findings,
      findingsTruncated: findings.truncated,
      limit: MAX_MCP_FINDINGS,
    });
  }) as HarnessMcpToolResult;
}

export function hitchDecisionsTool(
  args: HitchIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const hitch = repo.getSession(args.hitchId);
    if (hitch === null) return errorResult(`hitch not found: ${args.hitchId}`);
    const denied = ensureProjectVisible(context.config, hitch.projectId);
    if (denied !== null) return denied;
    return ok("hitch decisions", {
      decisions: repo.listDecisions(args.hitchId),
    });
  }) as HarnessMcpToolResult;
}
