// dry-run-tools 公開 MCP tool factory（#125 A15 barrel 分割）。

import { harnessPaths } from "../../config/paths.js";

import { checkProject } from "../../project/checker.js";

import { loadDomainRegistry, selectDefaultRegistryId } from "../../project/domain-registry.js";
import { inspectProject } from "../../project/inspector.js";
import { loadProjectById } from "../../project/profile-resolver.js";

import { scanRepoSignals } from "../../project/repo-signals.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { ensureProjectVisible } from "./tool-helpers.js";
import type { ProjectArgs } from "./dry-run-types.js";
import { projectToolError, validateRepoPath } from "./dry-run-helpers.js";

export async function projectInspectTool(
  args: ProjectArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  try {
    const resolved = await loadProjectById(context.harnessRoot, args.projectId);
    if (resolved.repoPath === null) {
      return errorResult(`project ${args.projectId} has no repo path`, {
        projectId: args.projectId,
        profileSource: resolved.profileSource,
        profileRevisionId: resolved.profileRevisionId ?? null,
      });
    }
    const repoError = validateRepoPath(resolved.repoPath);
    if (repoError !== null) return repoError;
    const signals = await scanRepoSignals(resolved.repoPath);
    const registryId = selectDefaultRegistryId(signals);
    const registry = await loadDomainRegistry(
      harnessPaths(context.harnessRoot).templatesDir,
      registryId,
    );
    const inspection = inspectProject(signals, registry);
    return {
      status: "ok",
      summary: `project ${args.projectId} inspection`,
      data: {
        projectId: args.projectId,
        profileSource: resolved.profileSource,
        profileRevisionId: resolved.profileRevisionId ?? null,
        repoPath: resolved.repoPath,
        inspection,
      },
    };
  } catch (e) {
    return projectToolError(`project ${args.projectId} inspection failed`, e);
  }
}

export async function projectCheckTool(
  args: ProjectArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  try {
    const report = await checkProject({
      harnessRoot: context.harnessRoot,
      projectId: args.projectId,
      generatedAt: new Date().toISOString(),
    });
    return {
      status: "dry_run",
      summary: `project ${args.projectId} check ${report.status}`,
      data: {
        dryRun: true,
        report,
      },
      warnings: report.items
        .filter((i) => i.level === "warn")
        .map((i) => `${i.label}: ${i.detail ?? "warning"}`),
    };
  } catch (e) {
    return projectToolError(`project ${args.projectId} check failed`, e);
  }
}
