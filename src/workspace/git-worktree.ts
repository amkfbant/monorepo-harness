import { dirname } from "node:path";
import { join } from "node:path";
import { gitCliOrThrow, gitCli } from "../git/git-cli.js";
import { assertSymlinkCapable } from "./fs-preflight.js";

export interface WorktreeCreateOpts {
  repoPath: string;
  worktreesDir: string;
  runId: string;
  branch: string;
  /** commit-ish (branch name or SHA) to base the new worktree on */
  base: string;
  timeoutMs?: number;
}

export interface Worktree {
  path: string;
  branch: string;
}

function withTimeout(repoPath: string, timeoutMs: number | undefined) {
  const o: { cwd: string; timeoutMs?: number } = { cwd: repoPath };
  if (timeoutMs !== undefined) o.timeoutMs = timeoutMs;
  return o;
}

export async function createWorktree(
  opts: WorktreeCreateOpts,
): Promise<Worktree> {
  // (#68) Fail fast with an actionable message if the worktree dir is on a
  // symlink-incapable FS (WSL 9p/drvfs) — git worktree / dep installs would
  // otherwise die with a cryptic EPERM deep inside.
  assertSymlinkCapable(opts.worktreesDir);
  const wtPath = join(opts.worktreesDir, opts.runId, "repo");
  await gitCliOrThrow(
    ["worktree", "add", "-b", opts.branch, wtPath, opts.base],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  return { path: wtPath, branch: opts.branch };
}

export interface DetachedWorktreeOpts {
  repoPath: string;
  /** absolute path where the detached worktree is created */
  worktreePath: string;
  /** commit-ish (SHA or ref) to check out detached */
  commitish: string;
  timeoutMs?: number;
}

/**
 * (#82) Create a **detached** worktree (no branch) for read-only verification —
 * e.g. checking out a PR head without occupying its branch, which a per-run
 * worktree (`createWorktree`, `-b <branch>`) would block via
 * `fatal: '<branch>' is already used by worktree`. Detached HEAD owns no branch,
 * so it never competes for one. "read-only" is a usage convention, not enforced.
 */
export async function createDetachedWorktree(
  opts: DetachedWorktreeOpts,
): Promise<{ path: string }> {
  // reuse the #68 preflight: the verify worktree dir must hold symlinks too
  assertSymlinkCapable(dirname(opts.worktreePath));
  await gitCliOrThrow(
    ["worktree", "add", "--detach", opts.worktreePath, opts.commitish],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  return { path: opts.worktreePath };
}

/** Remove a detached worktree (no branch to delete, unlike {@link removeWorktree}). */
export async function removeDetachedWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  timeoutMs?: number;
}): Promise<void> {
  const removed = await gitCli(
    ["worktree", "remove", "--force", opts.worktreePath],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  if (removed.exitCode !== 0) {
    throw new Error(`worktree remove failed: ${removed.stderr.trim()}`);
  }
}

export interface WorktreeRemoveOpts {
  repoPath: string;
  worktreePath: string;
  branch: string;
  timeoutMs?: number;
}

export async function removeWorktree(opts: WorktreeRemoveOpts): Promise<void> {
  const removed = await gitCli(
    ["worktree", "remove", "--force", opts.worktreePath],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  if (removed.exitCode !== 0) {
    throw new Error(`worktree remove failed: ${removed.stderr.trim()}`);
  }
  await gitCli(
    ["branch", "-D", opts.branch],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
}
