import type Database from "better-sqlite3";
import { ConvergenceService } from "../goal/convergence.js";
import { GoalRepository } from "../goal/repository.js";
import {
  WorkspaceRepository,
  type WorkspaceRecord,
} from "../db/repositories/workspaces.js";
import {
  inspectAgentWorkspace,
  type AgentWorkspaceContext,
} from "./agent-workspace.js";
import { reconcileWorkspaces } from "./workspace-reconcile.js";
import {
  isHeartbeatStale,
  summarizeWorkspace,
  type WorkspaceStatus,
} from "./workspace-status.js";

export interface WorkspaceStatusFull extends WorkspaceStatus {
  staleHeartbeat: boolean;
}

interface GoalInfo {
  decision: string | null;
  projectId: string | null;
}

/**
 * All the DB facts needed to build a repo's workspace statuses, read in ONE
 * synchronous window so the DB handle can be CLOSED before the (slow) per-
 * worktree git inspections — the read and the git work are deliberately split.
 */
export interface WorkspaceStatusData {
  rows: WorkspaceRecord[];
  /** decision + project per linked goalId (for labels and scoping) */
  goalInfo: Map<string, GoalInfo>;
  /** latest checkpoint timestamp per workspaceId */
  checkpointAt: Map<string, string>;
}

export function readWorkspaceStatusData(
  db: Database.Database,
  repoKey: string,
): WorkspaceStatusData {
  const wsRepo = new WorkspaceRepository(db);
  const goalRepo = new GoalRepository(db);
  const rows = wsRepo.listByRepo(repoKey);
  const goalInfo = new Map<string, GoalInfo>();
  for (const r of rows) {
    if (r.goalId === null || goalInfo.has(r.goalId)) continue;
    const session = goalRepo.getSession(r.goalId);
    goalInfo.set(r.goalId, {
      decision:
        session === null
          ? null
          : new ConvergenceService(goalRepo).evaluate(r.goalId).decision,
      projectId: session?.projectId ?? null,
    });
  }
  const checkpointAt = wsRepo.latestCheckpointAtForWorkspaces(
    rows.map((r) => r.workspaceId),
  );
  return { rows, goalInfo, checkpointAt };
}

export interface AssembleStatusOpts {
  base: string;
  nowMs: number;
  staleThresholdMs: number;
  /**
   * Optional visibility predicate, evaluated BEFORE the git inspection so an
   * out-of-scope workspace is never inspected. Receives the DB row (null for a
   * convention-only worktree with no row) and its linked-goal project.
   */
  include?: (record: WorkspaceRecord | null, goalProjectId: string | null) => boolean;
}

/**
 * Assemble workspace statuses from pre-read DB data: reconcile against live
 * worktrees, inspect each VISIBLE live one (git), and label it. No DB access —
 * the caller has already closed the handle, so git work holds no DB lock.
 */
export async function assembleWorkspaceStatuses(
  ctx: AgentWorkspaceContext,
  data: WorkspaceStatusData,
  opts: AssembleStatusOpts,
): Promise<WorkspaceStatusFull[]> {
  const { live, recordByAgent, stale } = await reconcileWorkspaces(
    ctx,
    data.rows,
  );
  const projectOf = (r: WorkspaceRecord | null): string | null =>
    r?.goalId != null ? (data.goalInfo.get(r.goalId)?.projectId ?? null) : null;
  const visible = (r: WorkspaceRecord | null): boolean =>
    opts.include === undefined || opts.include(r, projectOf(r));
  const decisionOf = (goalId: string | null): string | null =>
    goalId === null ? null : (data.goalInfo.get(goalId)?.decision ?? null);

  const out: WorkspaceStatusFull[] = [];
  for (const w of live) {
    const r = recordByAgent.get(w.agent) ?? null;
    if (!visible(r)) continue; // skip out-of-scope BEFORE any git inspection
    const insp = await inspectAgentWorkspace(ctx, {
      agent: w.agent,
      base: opts.base,
      workspace: w,
    });
    out.push({
      ...summarizeWorkspace({
        agent: w.agent,
        branch: w.branch,
        git: {
          ahead: insp.ahead,
          behind: insp.behind,
          baseResolved: insp.baseResolved,
          dirtyCount: insp.dirtyFiles.length,
        },
        goalId: r?.goalId ?? null,
        goalDecision: decisionOf(r?.goalId ?? null),
        objective: r?.objective ?? null,
        lastActiveAt: r?.lastActiveAt ?? null,
        lastCheckpointAt:
          r === null ? null : (data.checkpointAt.get(r.workspaceId) ?? null),
        stale: false,
      }),
      staleHeartbeat: isHeartbeatStale(
        r?.lastActiveAt ?? null,
        opts.nowMs,
        opts.staleThresholdMs,
      ),
    });
  }
  for (const r of stale) {
    if (!visible(r)) continue;
    out.push({
      ...summarizeWorkspace({
        agent: r.agent,
        branch: r.branch,
        git: null,
        goalId: r.goalId,
        goalDecision: decisionOf(r.goalId),
        objective: r.objective,
        lastActiveAt: r.lastActiveAt,
        lastCheckpointAt: data.checkpointAt.get(r.workspaceId) ?? null,
        stale: true,
      }),
      staleHeartbeat: isHeartbeatStale(
        r.lastActiveAt,
        opts.nowMs,
        opts.staleThresholdMs,
      ),
    });
  }
  return out;
}
