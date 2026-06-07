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

export interface WorkspaceCheckpointRecord {
  checkpointId: string;
  workspaceId: string;
  note: string | null;
  headSha: string | null;
  dirtyCount: number;
  goalId: string | null;
  createdAt: string;
  createdBy: string;
}

export interface RecordCheckpointInput {
  workspaceId: string;
  note?: string | null;
  headSha?: string | null;
  dirtyCount?: number;
  goalId?: string | null;
  createdBy: string;
  now?: string;
}

function rowToCheckpoint(r: Record<string, unknown>): WorkspaceCheckpointRecord {
  return {
    checkpointId: r.checkpoint_id as string,
    workspaceId: r.workspace_id as string,
    note: (r.note as string | null) ?? null,
    headSha: (r.head_sha as string | null) ?? null,
    dirtyCount: r.dirty_count as number,
    goalId: (r.goal_id as string | null) ?? null,
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
  };
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

  /**
   * Workspace rows across repos (for the MCP coordination view), optionally
   * filtered by agent. The agent predicate is applied IN the query so `LIMIT`
   * cannot drop matching rows that sort beyond the cap.
   */
  listAll(filter: { agent?: string; limit?: number } = {}): WorkspaceRecord[] {
    const where = filter.agent !== undefined ? " WHERE agent = ?" : "";
    const params: unknown[] = filter.agent !== undefined ? [filter.agent] : [];
    const rows = this.db
      .prepare(
        `SELECT * FROM workspaces${where} ` +
          `ORDER BY repo_path ASC, agent ASC LIMIT ?`,
      )
      .all(...params, filter.limit ?? 200) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  /**
   * Every workspace's (worktreePath, repoPath) with NO row cap — for DB-first
   * path authorization, where a capped `listAll` scan could miss a tracked
   * worktree that sorts beyond the limit and wrongly treat it as unknown.
   */
  listWorktreePaths(): { worktreePath: string; repoPath: string }[] {
    const rows = this.db
      .prepare(`SELECT worktree_path, repo_path FROM workspaces`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      worktreePath: String(r.worktree_path),
      repoPath: String(r.repo_path),
    }));
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

  /** Append an advisory checkpoint (save) for a workspace. */
  recordCheckpoint(input: RecordCheckpointInput): WorkspaceCheckpointRecord {
    const now = input.now ?? new Date().toISOString();
    const checkpointId = `wcp-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO workspace_checkpoints (
           checkpoint_id, workspace_id, note, head_sha, dirty_count,
           goal_id, created_at, created_by
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpointId,
        input.workspaceId,
        input.note ?? null,
        input.headSha ?? null,
        input.dirtyCount ?? 0,
        input.goalId ?? null,
        now,
        input.createdBy,
      );
    const r = this.db
      .prepare(`SELECT * FROM workspace_checkpoints WHERE checkpoint_id = ?`)
      .get(checkpointId) as Record<string, unknown>;
    return rowToCheckpoint(r);
  }

  /**
   * Checkpoints for a workspace, newest first. Ties on `created_at` (e.g. two
   * saves in the same millisecond) break by insertion order via `rowid`, so the
   * "latest" is deterministically the most recently inserted — never a random
   * UUID ordering.
   */
  listCheckpoints(workspaceId: string, limit = 50): WorkspaceCheckpointRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_checkpoints
           WHERE workspace_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`,
      )
      .all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map(rowToCheckpoint);
  }

  /** The most recent checkpoint for a workspace, or null. */
  latestCheckpoint(workspaceId: string): WorkspaceCheckpointRecord | null {
    const list = this.listCheckpoints(workspaceId, 1);
    return list[0] ?? null;
  }

  /**
   * The latest checkpoint timestamp for each given workspace, in ONE query.
   * Avoids the N+1 of calling `latestCheckpoint` per workspace (e.g. in
   * `workspace status`). Workspaces with no checkpoint are absent from the map.
   */
  latestCheckpointAtForWorkspaces(
    workspaceIds: readonly string[],
  ): Map<string, string> {
    const map = new Map<string, string>();
    if (workspaceIds.length === 0) return map;
    const placeholders = workspaceIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT workspace_id, MAX(created_at) AS latest
           FROM workspace_checkpoints
           WHERE workspace_id IN (${placeholders})
           GROUP BY workspace_id`,
      )
      .all(...workspaceIds) as { workspace_id: string; latest: string }[];
    for (const r of rows) map.set(r.workspace_id, r.latest);
    return map;
  }
}
