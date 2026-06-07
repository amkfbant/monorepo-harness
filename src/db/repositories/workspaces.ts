import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * Agent-workspace write repository (W2). An additive index over the per-agent
 * git worktrees: git owns a worktree's existence/branch, this row carries the
 * harness-side metadata git does not track (objective, advisory goal link,
 * heartbeat). Keyed by (repo_path, agent); `upsert` keeps one row per agent.
 */

export interface WorkspaceRecord {
  workspaceId: string;
  agent: string;
  repoPath: string;
  branch: string;
  worktreePath: string;
  goalId: string | null;
  objective: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

function rowToRecord(r: Record<string, unknown>): WorkspaceRecord {
  return {
    workspaceId: r.workspace_id as string,
    agent: r.agent as string,
    repoPath: r.repo_path as string,
    branch: r.branch as string,
    worktreePath: r.worktree_path as string,
    goalId: (r.goal_id as string | null) ?? null,
    objective: (r.objective as string | null) ?? null,
    status: r.status as "active" | "archived",
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    lastActiveAt: r.last_active_at as string,
  };
}

export interface UpsertWorkspaceInput {
  agent: string;
  repoPath: string;
  branch: string;
  worktreePath: string;
  now?: string;
}

export class WorkspaceRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create or update the row for (repoPath, agent). Idempotent: a second call
   * keeps the original workspace_id / created_at and refreshes branch,
   * worktree, status=active, and the heartbeat.
   */
  upsert(input: UpsertWorkspaceInput): WorkspaceRecord {
    const now = input.now ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspaces (
           workspace_id, agent, repo_path, branch, worktree_path,
           status, created_at, updated_at, last_active_at
         )
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT (repo_path, agent) DO UPDATE SET
           branch = excluded.branch,
           worktree_path = excluded.worktree_path,
           status = 'active',
           updated_at = excluded.updated_at,
           last_active_at = excluded.last_active_at`,
      )
      .run(
        `ws-${randomUUID()}`,
        input.agent,
        input.repoPath,
        input.branch,
        input.worktreePath,
        now,
        now,
        now,
      );
    const record = this.get(input.repoPath, input.agent);
    if (record === null) {
      throw new Error(
        `workspace upsert did not persist for agent ${JSON.stringify(input.agent)}`,
      );
    }
    return record;
  }

  get(repoPath: string, agent: string): WorkspaceRecord | null {
    const r = this.db
      .prepare(`SELECT * FROM workspaces WHERE repo_path = ? AND agent = ?`)
      .get(repoPath, agent) as Record<string, unknown> | undefined;
    return r === undefined ? null : rowToRecord(r);
  }

  listByRepo(repoPath: string): WorkspaceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workspaces WHERE repo_path = ? ORDER BY agent ASC`,
      )
      .all(repoPath) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  remove(repoPath: string, agent: string): boolean {
    const r = this.db
      .prepare(`DELETE FROM workspaces WHERE repo_path = ? AND agent = ?`)
      .run(repoPath, agent);
    return r.changes > 0;
  }

  /** Refresh the heartbeat (last_active_at) for an existing workspace. */
  touch(repoPath: string, agent: string, now?: string): void {
    const ts = now ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE workspaces SET last_active_at = ?, updated_at = ?
           WHERE repo_path = ? AND agent = ?`,
      )
      .run(ts, ts, repoPath, agent);
  }

  /** Link (or unlink with null) an advisory goal for the workspace. */
  linkGoal(
    repoPath: string,
    agent: string,
    goalId: string | null,
    now?: string,
  ): void {
    const ts = now ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE workspaces SET goal_id = ?, updated_at = ?, last_active_at = ?
           WHERE repo_path = ? AND agent = ?`,
      )
      .run(goalId, ts, ts, repoPath, agent);
  }

  /** Set the workspace's free-text objective. */
  setObjective(
    repoPath: string,
    agent: string,
    objective: string | null,
    now?: string,
  ): void {
    const ts = now ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE workspaces SET objective = ?, updated_at = ?, last_active_at = ?
           WHERE repo_path = ? AND agent = ?`,
      )
      .run(objective, ts, ts, repoPath, agent);
  }
}
