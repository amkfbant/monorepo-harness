import type Database from "better-sqlite3";
import { pruneWorktrees } from "../workspace/git-worktree.js";
import { reclaimTerminalRunWorktrees } from "./cleanup.js";

export interface RunWorktreeGcOpts {
  db: Database.Database;
  repoPath: string;
  workspacesDir: string;
  runsDir: string;
  gitTimeoutMs?: number;
}

/**
 * (#404) Reclaim leaked run worktrees on `repoPath` before a new run cuts its
 * own. run worktrees are rooted in the project repo's real `.git`; left
 * un-reclaimed they accumulate and degrade it (`core.bare` flip の遠因). Two
 * best-effort passes, run-start only — NEITHER blocks the run (each is caught
 * and warned), so a degraded repo never stops work:
 *
 *  1. `pruneWorktrees` — clears admin entries whose working dir is already GONE
 *     (crashed run / interrupted cleanup). Never touches a live worktree.
 *  2. `reclaimTerminalRunWorktrees` — removes worktrees of TERMINAL runs
 *     (`approved` / `rejected`) whose dir still EXISTS. `changes_requested`
 *     (retry base / continuation source) and non-terminal runs are left alone.
 *
 * See docs/specs/workspace.md for the lifecycle and safety rationale.
 */
export async function gcWorktreesBeforeRun(
  opts: RunWorktreeGcOpts,
): Promise<void> {
  try {
    await pruneWorktrees({
      repoPath: opts.repoPath,
      ...(opts.gitTimeoutMs !== undefined ? { timeoutMs: opts.gitTimeoutMs } : {}),
    });
  } catch (e) {
    process.stderr.write(
      `warning: stale-worktree prune failed for ${opts.repoPath}: ${(e as Error).message}\n`,
    );
  }
  try {
    await reclaimTerminalRunWorktrees({
      db: opts.db,
      repoPath: opts.repoPath,
      workspacesDir: opts.workspacesDir,
      runsDir: opts.runsDir,
      ...(opts.gitTimeoutMs !== undefined ? { gitTimeoutMs: opts.gitTimeoutMs } : {}),
    });
  } catch (e) {
    process.stderr.write(
      `warning: terminal-worktree reclaim failed for ${opts.repoPath}: ${(e as Error).message}\n`,
    );
  }
}
