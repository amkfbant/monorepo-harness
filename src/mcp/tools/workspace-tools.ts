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

    // Memoize convergence per goalId (many workspaces can share a goal).
    const decisionCache = new Map<string, string | null>();
    const goalDecisionFor = (goalId: string | null): string | null => {
      if (goalId === null) return null;
      const cached = decisionCache.get(goalId);
      if (cached !== undefined) return cached;
      const decision =
        goalRepo.getSession(goalId) === null
          ? null
          : new ConvergenceService(goalRepo).evaluate(goalId).decision;
      decisionCache.set(goalId, decision);
      return decision;
    };
    const checkpointAt = repo.latestCheckpointAtForWorkspaces(
      rows.map((r) => r.workspaceId),
    );

    const workspaces = rows.map((r) => ({
      agent: r.agent,
      repoPath: r.repoPath,
      branch: r.branch,
      worktreePath: r.worktreePath,
      status: r.status,
      goalId: r.goalId,
      goalDecision: goalDecisionFor(r.goalId),
      objective: r.objective,
      lastActiveAt: r.lastActiveAt,
      lastCheckpointAt: checkpointAt.get(r.workspaceId) ?? null,
    }));
    return ok(`listed ${workspaces.length} workspace(s)`, { workspaces });
  }) as HarnessMcpToolResult;
}
