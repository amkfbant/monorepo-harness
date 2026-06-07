import {
  agentNameFromBranch,
  listWorktrees,
  normalizeWorktreePath as norm,
  type AgentWorkspace,
  type AgentWorkspaceContext,
} from "./agent-workspace.js";
import type { WorkspaceRecord } from "../db/repositories/workspaces.js";

/**
 * Reconcile the DB workspace index against the repo's actual git worktrees,
 * PATH-FIRST, so both conventionally-created (`agent/*`) and adopted
 * (any-branch) entries are surfaced from the LIVE worktree state:
 *
 *  - iterate the repo's real worktrees (excluding the main one); each is a live
 *    workspace if its branch is `agent/<name>` (convention) OR a DB row adopted
 *    that exact path. The branch/HEAD are hydrated from git (never the possibly
 *    stale DB branch), so a worktree that has since switched branches is diffed
 *    correctly; a detached worktree (no branch) is skipped.
 *  - stale = DB rows whose worktree path is no longer a real worktree.
 *
 * Keying by path (not agent name) means a name collision cannot hide a worktree
 * or mis-attach metadata. One-agent-per-path is enforced at `adopt` time.
 */

export interface ReconcileResult {
  /** agent/* worktrees plus adopted (path-present) workspaces, hydrated from git */
  live: AgentWorkspace[];
  recordByAgent: Map<string, WorkspaceRecord>;
  /** DB rows whose worktree no longer exists */
  stale: WorkspaceRecord[];
}

export async function reconcileWorkspaces(
  ctx: AgentWorkspaceContext,
  rows: readonly WorkspaceRecord[],
): Promise<ReconcileResult> {
  const worktrees = await listWorktrees(ctx);
  // git lists the MAIN worktree first; agent worktrees are the rest.
  const others = worktrees.slice(1);
  const recordByPath = new Map<string, WorkspaceRecord>();
  for (const r of rows) recordByPath.set(norm(r.worktreePath), r);
  const recordByAgent = new Map(rows.map((r) => [r.agent, r]));

  // EVERY current worktree path (incl. detached) → for stale detection, so a
  // present-but-detached worktree's row is NOT wrongly flagged as missing.
  const allPaths = new Set(others.map((wt) => norm(wt.path)));
  const live: AgentWorkspace[] = [];
  for (const wt of others) {
    if (wt.branch === null) continue; // detached → present but not a usable workspace
    const fromBranch = agentNameFromBranch(wt.branch); // agent/<name> → name
    const adopted = recordByPath.get(norm(wt.path)) ?? null;
    const agent = fromBranch ?? adopted?.agent ?? null;
    if (agent === null) continue; // neither convention nor adopted → not ours
    // hydrate branch/HEAD from the LIVE worktree, not the DB row.
    live.push({ agent, path: wt.path, branch: wt.branch, head: wt.head });
  }

  const stale = rows.filter((r) => !allPaths.has(norm(r.worktreePath)));
  return { live, recordByAgent, stale };
}
