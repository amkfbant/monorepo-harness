import { existsSync } from "node:fs";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { ConvergenceService } from "../../goal/convergence.js";
import { GoalRepository } from "../../goal/repository.js";
import {
  WorkspaceRepository,
  type WorkspaceRecord,
} from "../../db/repositories/workspaces.js";
import {
  changedFilesForWorkspace,
  inspectAgentWorkspace,
  normalizeWorktreePath,
  type AgentWorkspace,
  type AgentWorkspaceContext,
} from "../../workspace/agent-workspace.js";
import { reconcileWorkspaces } from "../../workspace/workspace-reconcile.js";
import {
  findWorkspaceConflicts,
  type WorkspaceChangedFiles,
} from "../../workspace/workspace-conflicts.js";
import {
  buildRecoveryBriefing,
  type RecoveryGoal,
} from "../../workspace/workspace-recover.js";
import { errorResult, ok, type HarnessMcpToolResult } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import {
  resolveTrackedWorkspaceRepo,
  type TrackedRepoResolution,
} from "./workspace-tracked-repo.js";

/**
 * Resolve the shared DB-first guard for a git-inclusive workspace READ:
 * `repoPath` → a tracked repo + a safe git cwd, scoped to allowedProjects. The
 * DB handle is opened readonly, read once, and CLOSED before any git work.
 * Returns the resolution or the error result to return as-is.
 */
function resolveForRead(
  context: McpToolContext,
  repoPath: string,
):
  | { ctx: AgentWorkspaceContext; resolution: TrackedRepoResolution }
  | { error: HarnessMcpToolResult } {
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    return {
      error: errorResult("harness DB is not initialized", { dbPath: paths.dbPath }),
    };
  }
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  try {
    const resolved = resolveTrackedWorkspaceRepo(
      handle.db,
      repoPath,
      context.config.allowedProjects,
    );
    if ("error" in resolved) return { error: resolved.error };
    return {
      resolution: resolved.ok,
      ctx: { repoPath: resolved.ok.gitCwd, workspacesDir: resolved.ok.gitCwd },
    };
  } finally {
    handle.close();
  }
}

/** Is this live worktree one the client is allowed to observe? (path-first.) */
function isVisible(
  w: AgentWorkspace,
  resolution: TrackedRepoResolution,
  recordByPath: Map<string, WorkspaceRecord>,
): boolean {
  if (resolution.include === undefined) return true;
  const row = recordByPath.get(normalizeWorktreePath(w.path)) ?? null;
  return resolution.include(row, row !== null ? resolution.projectOf(row) : null);
}

export interface WorkspaceInspectArgs {
  repoPath: string;
  agent: string;
  base?: string;
}

/**
 * Deterministic git briefing of ONE agent's workspace over MCP (branch / HEAD /
 * dirty / ahead-behind / last commit) — the read-only counterpart of the CLI
 * `workspace inspect`. `repoPath` is a tracked worktree path (or a subpath); the
 * agent's workspace must be IN SCOPE or it is reported as not found (no leak).
 */
export async function workspaceInspectTool(
  args: WorkspaceInspectArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const resolved = resolveForRead(context, args.repoPath);
  if ("error" in resolved) return resolved.error;
  const { ctx, resolution } = resolved;

  const notFound = (): HarnessMcpToolResult =>
    errorResult(`no workspace for agent "${args.agent}" in ${args.repoPath}`, {
      repoPath: args.repoPath,
      agent: args.agent,
    });

  const { live, recordByPath } = await reconcileWorkspaces(ctx, resolution.data.rows);
  const ws = live.find((w) => w.agent === args.agent);
  // out-of-scope (or absent) agents are indistinguishable → same not-found error.
  if (ws === undefined || !isVisible(ws, resolution, recordByPath)) {
    return notFound();
  }
  const inspection = await inspectAgentWorkspace(ctx, {
    agent: args.agent,
    base: args.base ?? "main",
    workspace: ws,
  });
  return ok(`inspected workspace "${args.agent}"`, inspection);
}

export interface WorkspaceConflictsArgs {
  repoPath: string;
  base?: string;
}

/**
 * Cross-agent changed-file overlap pre-check of ONE repo's workspaces over MCP —
 * the read-only counterpart of the CLI `workspace conflicts`. Only IN-SCOPE
 * workspaces are inspected (git) and reported.
 */
export async function workspaceConflictsTool(
  args: WorkspaceConflictsArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const resolved = resolveForRead(context, args.repoPath);
  if ("error" in resolved) return resolved.error;
  const { ctx, resolution } = resolved;

  const { live, recordByPath } = await reconcileWorkspaces(ctx, resolution.data.rows);
  const base = args.base ?? "main";
  const entries: WorkspaceChangedFiles[] = [];
  for (const w of live) {
    if (!isVisible(w, resolution, recordByPath)) continue; // scope BEFORE git
    entries.push({
      agent: w.agent,
      files: await changedFilesForWorkspace(ctx, { agent: w.agent, base, workspace: w }),
    });
  }
  const conflicts = findWorkspaceConflicts(entries);
  return ok(
    conflicts.length === 0
      ? `no overlapping changes across ${entries.length} workspace(s)`
      : `${conflicts.length} overlapping pair(s) across ${entries.length} workspace(s)`,
    { conflicts, workspaces: entries.length },
  );
}

export interface WorkspaceRecoverArgs {
  repoPath: string;
  agent: string;
  base?: string;
}

/**
 * Reconstruct ONE agent's workspace state (git + linked goal) and recommend
 * deterministic next-steps over MCP — the read-only counterpart of the CLI
 * `workspace recover`. The next-steps are projected from git + goal convergence
 * ONLY (the checkpoint narrative is advisory context, never a driver — §0).
 * The agent's workspace must be IN SCOPE or it is reported as not found.
 */
export async function workspaceRecoverTool(
  args: WorkspaceRecoverArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const resolved = resolveForRead(context, args.repoPath);
  if ("error" in resolved) return resolved.error;
  const { ctx, resolution } = resolved;

  const notFound = (): HarnessMcpToolResult =>
    errorResult(`no workspace for agent "${args.agent}" in ${args.repoPath}`, {
      repoPath: args.repoPath,
      agent: args.agent,
    });

  const { live, recordByPath } = await reconcileWorkspaces(ctx, resolution.data.rows);
  const ws = live.find((w) => w.agent === args.agent);
  if (ws === undefined || !isVisible(ws, resolution, recordByPath)) {
    return notFound();
  }
  const inspection = await inspectAgentWorkspace(ctx, {
    agent: args.agent,
    base: args.base ?? "main",
    workspace: ws,
  });

  // a SECOND, short DB window (after git) for the goal convergence + latest
  // checkpoint — no DB lock is held across git.
  const row = recordByPath.get(normalizeWorktreePath(ws.path)) ?? null;
  const paths = harnessPaths(context.harnessRoot);
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  let goal: RecoveryGoal | null = null;
  let objective: string | null = null;
  let latestCheckpoint: { note: string | null; createdAt: string; createdBy: string } | null =
    null;
  try {
    if (row !== null) {
      objective = row.objective;
      const wsRepo = new WorkspaceRepository(handle.db);
      const latest = wsRepo.latestCheckpoint(row.workspaceId);
      latestCheckpoint =
        latest === null
          ? null
          : { note: latest.note, createdAt: latest.createdAt, createdBy: latest.createdBy };
      if (row.goalId !== null) {
        const goalRepo = new GoalRepository(handle.db);
        const exists = goalRepo.getSession(row.goalId) !== null;
        goal = {
          goalId: row.goalId,
          convergence: exists
            ? (() => {
                const c = new ConvergenceService(goalRepo).evaluate(row.goalId as string);
                return {
                  decision: c.decision,
                  reason: c.reason,
                  nextActionKind: c.recommendedNextAction.kind,
                };
              })()
            : null,
        };
      }
    }
  } finally {
    handle.close();
  }

  const briefing = buildRecoveryBriefing({ inspection, objective, goal, latestCheckpoint });
  return ok(`recovery briefing for "${args.agent}"`, briefing);
}
