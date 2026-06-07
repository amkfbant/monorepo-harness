import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { WorkspaceRepository } from "../db/repositories/workspaces.js";
import {
  agentNameFromBranch,
  canonicalRepoKey,
  defaultGitRunner,
  listWorktrees,
  normalizeWorktreePath,
  type GitRunner,
} from "./agent-workspace.js";

/**
 * Best-effort: if `repoPath` is an agent worktree — its branch is `agent/<name>`
 * (the convention) OR a DB row already adopted that exact path — record/refresh
 * the workspace row and link it to `goalId`, refreshing the heartbeat. So
 * `workspace status` shows which agent is driving which goal, populated
 * automatically by `goal orchestrate`. NEVER throws: a failure just means no
 * link (orchestration must not depend on this).
 */
export async function linkAgentWorkspaceToGoal(opts: {
  repoPath: string;
  goalId: string;
  harnessRoot: string;
  git?: GitRunner;
}): Promise<{ linked: boolean; agent?: string }> {
  try {
    const ctx = {
      repoPath: opts.repoPath,
      workspacesDir: opts.repoPath,
      ...(opts.git !== undefined ? { git: opts.git } : {}),
    };
    const run = opts.git ?? defaultGitRunner();
    // resolve the worktree ROOT so a subdirectory of an agent worktree still
    // matches the path `git worktree list` reports.
    const top = await run(["rev-parse", "--show-toplevel"], opts.repoPath);
    if (top.exitCode !== 0 || top.timedOut) return { linked: false };
    const target = normalizeWorktreePath(top.stdout.trim());
    // exclude the MAIN worktree (git lists it first): the primary checkout is the
    // shared tree, never an agent workspace — consistent with reconcile/adopt.
    const wt = (await listWorktrees(ctx))
      .slice(1)
      .find((w) => normalizeWorktreePath(w.path) === target);
    if (wt === undefined || wt.branch === null) return { linked: false };

    const repoKey = await canonicalRepoKey({
      repoPath: opts.repoPath,
      ...(opts.git !== undefined ? { git: opts.git } : {}),
    });
    const handle = openManagedDb({
      dbPath: harnessPaths(opts.harnessRoot).dbPath,
    });
    try {
      runMigrations(handle.db);
      const repo = new WorkspaceRepository(handle.db);
      // agent from the branch convention, else an adopted row matched by path.
      let agent = agentNameFromBranch(wt.branch);
      if (agent === null) {
        const row = repo
          .listByRepo(repoKey)
          .find((r) => normalizeWorktreePath(r.worktreePath) === target);
        if (row === undefined) return { linked: false };
        agent = row.agent;
      }
      repo.upsert({
        agent,
        repoPath: repoKey,
        branch: wt.branch,
        worktreePath: wt.path,
      });
      repo.linkGoal(repoKey, agent, opts.goalId);
      return { linked: true, agent };
    } finally {
      handle.close();
    }
  } catch {
    return { linked: false };
  }
}
