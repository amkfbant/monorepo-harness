import { join } from "node:path";
import { gitCliOrThrow, gitCli } from "../git/git-cli.js";

export interface WorktreeCreateOpts {
  repoPath: string;
  worktreesDir: string;
  runId: string;
  branch: string;
  baseBranch: string;
}

export interface Worktree {
  path: string;
  branch: string;
}

export async function createWorktree(
  opts: WorktreeCreateOpts,
): Promise<Worktree> {
  const wtPath = join(opts.worktreesDir, opts.runId, "repo");
  await gitCliOrThrow(
    ["worktree", "add", "-b", opts.branch, wtPath, opts.baseBranch],
    { cwd: opts.repoPath },
  );
  return { path: wtPath, branch: opts.branch };
}

export interface WorktreeRemoveOpts {
  repoPath: string;
  worktreePath: string;
  branch: string;
}

export async function removeWorktree(opts: WorktreeRemoveOpts): Promise<void> {
  const removed = await gitCli(
    ["worktree", "remove", "--force", opts.worktreePath],
    { cwd: opts.repoPath },
  );
  if (removed.exitCode !== 0) {
    throw new Error(`worktree remove failed: ${removed.stderr.trim()}`);
  }
  await gitCli(["branch", "-D", opts.branch], { cwd: opts.repoPath });
}
