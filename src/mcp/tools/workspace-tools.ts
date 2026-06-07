import { ConvergenceService } from "../../goal/convergence.js";
import { GoalRepository } from "../../goal/repository.js";
import { WorkspaceRepository } from "../../db/repositories/workspaces.js";
import { ok, type HarnessMcpToolResult } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { normalizeLimit, withReadonlyDb } from "./tool-helpers.js";

export interface WorkspaceListArgs {
  agent?: string;
  limit?: number;
}

/**
 * Read-only MCP coordination view of the per-agent workspaces (the DB index):
 * which agents exist, on what branch, their linked goal + its convergence
 * decision, objective, heartbeat, and last checkpoint. Pure DB read — git
 * state (dirty / ahead-behind) and the mutating create/remove/checkpoint and
 * git-inclusive inspect/recover surfaces are deliberately CLI-only for now
 * (they need filesystem/git access and, for mutations, a confirmation gate).
 */
export function workspaceListTool(
  args: WorkspaceListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new WorkspaceRepository(db);
    const goalRepo = new GoalRepository(db);
    const limit = normalizeLimit(args.limit, 200);
    // filter by agent IN the query so the limit cannot drop a match.
    const rows = repo.listAll({
      limit,
      ...(args.agent !== undefined ? { agent: args.agent } : {}),
    });

    // Memoize per goalId: a workspace's project (for scoping) and the goal's
    // convergence decision both come from the same session lookup.
    const goalCache = new Map<
      string,
      { decision: string | null; projectId: string | null }
    >();
    const goalInfo = (
      goalId: string | null,
    ): { decision: string | null; projectId: string | null } => {
      if (goalId === null) return { decision: null, projectId: null };
      const cached = goalCache.get(goalId);
      if (cached !== undefined) return cached;
      const session = goalRepo.getSession(goalId);
      const info =
        session === null
          ? { decision: null, projectId: null }
          : {
              decision: new ConvergenceService(goalRepo).evaluate(goalId)
                .decision,
              projectId: session.projectId,
            };
      goalCache.set(goalId, info);
      return info;
    };

    // Project scoping: a client restricted to `allowedProjects` must not see
    // workspaces outside it. A workspace's project is its linked goal's
    // project_id; an unlinked or dangling workspace has no project, so it is
    // omitted for a restricted client (fail-closed).
    const allowed = context.config.allowedProjects;
    const restricted = allowed.length > 0;
    const kept = rows
      .map((r) => ({ r, info: goalInfo(r.goalId) }))
      .filter(
        ({ info }) =>
          !restricted ||
          (info.projectId !== null && allowed.includes(info.projectId)),
      );

    const checkpointAt = repo.latestCheckpointAtForWorkspaces(
      kept.map(({ r }) => r.workspaceId),
    );
    const workspaces = kept.map(({ r, info }) => ({
      agent: r.agent,
      repoPath: r.repoPath,
      branch: r.branch,
      worktreePath: r.worktreePath,
      status: r.status,
      goalId: r.goalId,
      goalDecision: info.decision,
      objective: r.objective,
      lastActiveAt: r.lastActiveAt,
      lastCheckpointAt: checkpointAt.get(r.workspaceId) ?? null,
    }));
    return ok(`listed ${workspaces.length} workspace(s)`, { workspaces });
  }) as HarnessMcpToolResult;
}
