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
