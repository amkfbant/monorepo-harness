import { existsSync } from "node:fs";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { ConvergenceService } from "../../hitch/convergence.js";
import { HitchRepository } from "../../hitch/repository.js";
import {
  WorkspaceRepository,
  type WorkspaceRecord,
} from "../../db/repositories/workspaces.js";
import {
  changedFilesForWorkspace,
  inspectAgentWorkspace,
  normalizeWorktreePath,
  worktreeBelongsToRepo,
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
  type RecoveryHitch,
} from "../../workspace/workspace-recover.js";
import { errorResult, ok, type HarnessMcpToolResult } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import {
  pickVerifiedGitCwd,
  resolveTrackedWorkspaceRepo,
  type TrackedRepoResolution,
} from "./workspace-tracked-repo.js";

/**
 * Resolve the shared DB-first guard for a git-inclusive workspace READ:
 * `repoPath` → a tracked repo + a safe git cwd, scoped to allowedProjects. The
 * DB handle is opened readonly, read once, and CLOSED before any git work; the
 * git cwd is then VERIFIED to still belong to the tracked repo (a deleted path
 * could be a different repo now). Returns the resolution or the error result.
 */
async function resolveForRead(
  context: McpToolContext,
  repoPath: string,
): Promise<
  | { ctx: AgentWorkspaceContext; resolution: TrackedRepoResolution }
  | { error: HarnessMcpToolResult }
> {
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    return {
      error: errorResult("harness DB is not initialized", { dbPath: paths.dbPath }),
    };
  }
  let resolution: TrackedRepoResolution;
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  try {
    const resolved = resolveTrackedWorkspaceRepo(
      handle.db,
      repoPath,
      context.config.allowedProjects,
    );
    if ("error" in resolved) return { error: resolved.error };
    resolution = resolved.ok;
  } finally {
    handle.close();
  }
  const gitCwd = await pickVerifiedGitCwd(resolution);
  if (gitCwd === undefined) {
    return {
      error: errorResult(`no live worktree on disk for ${repoPath}`, { repoPath }),
    };
  }
  return {
    resolution,
    ctx: { repoPath: gitCwd, workspacesDir: gitCwd },
  };
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
  const resolved = await resolveForRead(context, args.repoPath);
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
  // Also confirm the agent's OWN worktree still belongs to this repo before
  // running git in it (git's stale metadata could list a dir reused by another
  // repo) — a foreign / replaced worktree is reported as not found.
  if (
    ws === undefined ||
    !isVisible(ws, resolution, recordByPath) ||
    !(await worktreeBelongsToRepo(ws.path, resolution.repoKey))
  ) {
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
  const resolved = await resolveForRead(context, args.repoPath);
  if ("error" in resolved) return resolved.error;
  const { ctx, resolution } = resolved;

  const { live, recordByPath } = await reconcileWorkspaces(ctx, resolution.data.rows);
  const base = args.base ?? "main";
  const entries: WorkspaceChangedFiles[] = [];
  for (const w of live) {
    if (!isVisible(w, resolution, recordByPath)) continue; // scope BEFORE git
    // skip a worktree whose dir was reused for a foreign repo (git's stale
    // metadata may still list it) — never diff a foreign repo's files.
    if (!(await worktreeBelongsToRepo(w.path, resolution.repoKey))) continue;
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
  const resolved = await resolveForRead(context, args.repoPath);
  if ("error" in resolved) return resolved.error;
  const { ctx, resolution } = resolved;

  const notFound = (): HarnessMcpToolResult =>
    errorResult(`no workspace for agent "${args.agent}" in ${args.repoPath}`, {
      repoPath: args.repoPath,
      agent: args.agent,
    });

  const { live, recordByPath } = await reconcileWorkspaces(ctx, resolution.data.rows);
  const ws = live.find((w) => w.agent === args.agent);
  if (
    ws === undefined ||
    !isVisible(ws, resolution, recordByPath) ||
    !(await worktreeBelongsToRepo(ws.path, resolution.repoKey))
  ) {
    return notFound();
  }
  const inspection = await inspectAgentWorkspace(ctx, {
    agent: args.agent,
    base: args.base ?? "main",
    workspace: ws,
  });

  // a SECOND, short DB window (after git) for the advisory DB facts (objective /
  // goal convergence / latest checkpoint). The DB was closed during git, so the
  // workspace could have been relinked / deleted / moved out of scope meanwhile:
  // RE-FETCH by (repoKey, agent) and RE-AUTHORIZE before reading anything — a now
  // absent / out-of-scope workspace must NOT leak its checkpoint.
  const allowed = context.config.allowedProjects;
  const paths = harnessPaths(context.harnessRoot);
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  let hitch: RecoveryHitch | null = null;
  let objective: string | null = null;
  let latestCheckpoint: { note: string | null; createdAt: string; createdBy: string } | null =
    null;
  let authorized = true;
  try {
    const wsRepo = new WorkspaceRepository(handle.db);
    const goalRepo = new HitchRepository(handle.db);
    const row = wsRepo.get(resolution.repoKey, args.agent);
    const projectId =
      row !== null && row.hitchId !== null
        ? (goalRepo.getSession(row.hitchId)?.projectId ?? null)
        : null;
    // re-authorize: absent row, or (restricted client) a project not allowed.
    if (
      row === null ||
      (allowed.length > 0 && !(projectId !== null && allowed.includes(projectId)))
    ) {
      authorized = false;
    } else {
      objective = row.objective;
      const latest = wsRepo.latestCheckpoint(row.workspaceId);
      latestCheckpoint =
        latest === null
          ? null
          : { note: latest.note, createdAt: latest.createdAt, createdBy: latest.createdBy };
      if (row.hitchId !== null) {
        const exists = goalRepo.getSession(row.hitchId) !== null;
        hitch = {
          hitchId: row.hitchId,
          convergence: exists
            ? (() => {
                const c = new ConvergenceService(goalRepo).evaluate(row.hitchId as string);
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
  if (!authorized) return notFound();

  const briefing = buildRecoveryBriefing({ inspection, objective, hitch, latestCheckpoint });
  return ok(`recovery briefing for "${args.agent}"`, briefing);
}
