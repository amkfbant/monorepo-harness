// dry-run-tools 公開 MCP tool factory（#125 A15 barrel 分割）。


import { PullRequestRepository } from "../../db/repositories/pull-requests.js";

import { prepareProjectRun } from "../../project/run-project.js";

import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { ensureProjectVisible, withReadonlyDb } from "./tool-helpers.js";
import type { RunArgs, RunDryRunArgs } from "./dry-run-types.js";
import { activeDomainLock, activeLocksForRun, activeMaterializations, cleanupActionsForRun, contextPackSummary, countRows, currentProfileRevisionPreview, domainPreview, getRunRow, latestEffectivePolicySnapshot, projectPreview, projectToolError, recentRunsForDomain, toRunPreview } from "./dry-run-helpers.js";

export async function runDryRunTool(
  args: RunDryRunArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  try {
    const prepared = await prepareProjectRun({
      harnessRoot: context.harnessRoot,
      projectId: args.projectId,
      domain: args.domain,
    });
    const dbPreview = withReadonlyDb(context, ({ db }) => ({
      project: projectPreview(db, args.projectId),
      domain: domainPreview(db, args.projectId, args.domain),
      profileRevision: currentProfileRevisionPreview(db, args.projectId),
      effectivePolicySnapshot: latestEffectivePolicySnapshot(
        db,
        args.projectId,
        args.domain,
      ),
      domainLock: activeDomainLock(db, args.projectId, args.domain),
      recentRuns: recentRunsForDomain(db, args.projectId, args.domain),
    })) as
      | HarnessMcpToolResult
      | {
          project: Record<string, unknown> | null;
          domain: Record<string, unknown> | null;
          profileRevision: Record<string, unknown> | null;
          effectivePolicySnapshot: Record<string, unknown> | null;
          domainLock: Record<string, unknown> | null;
          recentRuns: Array<Record<string, unknown>>;
        };
    if ("status" in dbPreview) return dbPreview;
    const selectedContextPack =
      args.contextPack !== undefined
        ? prepared.projectContextPacks?.packIds.includes(args.contextPack) === true
        : true;
    return {
      status: "dry_run",
      summary: `would run ${args.projectId}/${args.domain}`,
      data: {
        dryRun: true,
        wouldRun: {
          projectId: args.projectId,
          repoId: prepared.repoId,
          domain: args.domain,
          goal: args.goal,
          baseBranch: prepared.baseBranch,
          repoPath: prepared.repoPath,
          contextPack: args.contextPack ?? null,
          selectedContextPack,
        },
        profileRevision: dbPreview.profileRevision,
        project: dbPreview.project,
        domain: dbPreview.domain,
        effectivePolicySnapshot: dbPreview.effectivePolicySnapshot,
        domainLock: dbPreview.domainLock,
        recentRuns: dbPreview.recentRuns,
        policy: {
          read: prepared.resolvedPolicy.read,
          write: prepared.resolvedPolicy.write,
          denyWrite: prepared.resolvedPolicy.denyWrite,
          codex: prepared.resolvedPolicy.codex,
          commandDefaults: prepared.resolvedPolicy.commandDefaults,
        },
        candidateCommands: prepared.resolvedPolicy.allowedCommands,
        contextPacks:
          prepared.projectContextPacks === undefined
            ? {
                packIds: [],
                fileCount: 0,
                includedFileCount: 0,
                totalBytes: 0,
                capped: false,
                findings: [],
              }
            : contextPackSummary(prepared.projectContextPacks.manifestYaml),
      },
      warnings:
        args.contextPack !== undefined && !selectedContextPack
          ? [`contextPack '${args.contextPack}' is not referenced by the selected domain`]
          : [],
      nextActions: [
        {
          label: "Start run",
          tool: "harness.run.start",
          arguments: {
            projectId: args.projectId,
            domain: args.domain,
            goal: args.goal,
            idempotencyKey: "<uuid>",
          },
        },
      ],
    };
  } catch (e) {
    return projectToolError(`run dry-run failed for ${args.projectId}/${args.domain}`, e);
  }
}

export function cleanupDryRunTool(
  args: RunArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const run = getRunRow(db, args.runId);
    if (run === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, run.project_id);
    if (denied !== null) return denied;
    const materializations = activeMaterializations(db, args.runId);
    const locks = activeLocksForRun(db, args.runId);
    const cleanupHistory = cleanupActionsForRun(db, args.runId);
    const artifactCount = countRows(db, "artifacts", "run_id = ?", [args.runId]);
    const plannedActions: Array<Record<string, unknown>> = [
      ...materializations.map((m) => ({
        action: "mark_materialization_cleaned",
        materializationId: m.materializationId,
        path: m.path,
      })),
      ...locks.map((l) => ({
        action: "release_domain_lock",
        lockId: l.lockId,
        domainKey: l.domainKey,
      })),
    ];
    if (plannedActions.length === 0) {
      plannedActions.push({ action: "noop", reason: "no active cleanup targets" });
    }
    return {
      status: "dry_run",
      summary: `would cleanup run ${args.runId}`,
      data: {
        dryRun: true,
        run: toRunPreview(run),
        plannedActions,
        activeMaterializations: materializations,
        activeLocks: locks,
        cleanupHistory,
        artifactCount,
      },
      nextActions: [
        {
          label: "Apply cleanup",
          tool: "harness.cleanup.apply",
          arguments: { runId: args.runId, idempotencyKey: "<uuid>" },
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function prPreviewTool(
  args: RunArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const run = getRunRow(db, args.runId);
    if (run === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, run.project_id);
    if (denied !== null) return denied;
    const existing = new PullRequestRepository(db).findByRun(args.runId);
    const existingComplete =
      existing !== null &&
      existing.status === "created" &&
      existing.url !== null &&
      existing.externalPrId !== null;
    const branch = run.run_branch ?? `harness/${args.runId}`;
    const title = `Harness run ${args.runId}: ${run.domain}`;
    const plannedPullRequest = existingComplete
      ? null
      : {
          provider: "git",
          repo: run.repo_id,
          branch,
          baseBranch: run.base_branch,
          title,
          draft: true,
        };
    const createAction = {
      label: "Create PR",
      tool: "harness.pr.create",
      arguments: { runId: args.runId, idempotencyKey: "<uuid>" },
    };
    return {
      status: "dry_run",
      summary: existingComplete
        ? `PR already recorded for run ${args.runId}`
        : existing === null
          ? `would create PR for run ${args.runId}`
          : `would retry PR creation for run ${args.runId}`,
      data: {
        dryRun: true,
        run: toRunPreview(run),
        existingPullRequest: existing,
        plannedPullRequest,
      },
      warnings:
        existing === null
          ? []
          : [`pull_requests already has status '${existing.status}' for this run`],
      nextActions: existingComplete ? [] : [createAction],
    };
  }) as HarnessMcpToolResult;
}
