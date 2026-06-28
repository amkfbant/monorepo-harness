import { dirname } from "node:path";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
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

export interface CloneWorkspaceCreateOpts {
  /** local target (the repo being cloned) */
  repoPath: string;
  worktreesDir: string;
  runId: string;
  branch: string;
  /** commit-ish (SHA recommended) to base the new branch on */
  base: string;
  timeoutMs?: number;
}

/**
 * (#410) Create a run workspace as an INDEPENDENT clone instead of a
 * `git worktree`. A worktree shares the target's `.git` (config lives in the
 * common dir), so an allowed-command running `git config core.bare true` inside
 * the worktree corrupts the SHARED config and flips the *target* to bare. A
 * clone owns a separate `.git` directory, physically severing that shared
 * config. Object storage is still shared cheaply via git's local-clone hardlinks
 * (which survive a target `gc` — the inode lives), but config is NOT shared.
 *
 * The clone's origin is re-pointed from the local target to the target's own
 * GitHub remote so `git push` / `gh pr create` reach GitHub unchanged. If the
 * target has no `origin`, this fails closed: warn and leave origin at the local
 * target (NO implicit worktree fallback) so a later push loud-fails instead of
 * silently pushing into a local clone.
 *
 * Returns the shared {@link Worktree} shape so downstream callers are unchanged.
 */
export async function createCloneWorkspace(
  opts: CloneWorkspaceCreateOpts,
): Promise<Worktree> {
  assertSymlinkCapable(opts.worktreesDir);
  const wtPath = join(opts.worktreesDir, opts.runId, "repo");
  // `git clone` creates the leading directories itself; `--no-checkout` avoids a
  // throwaway checkout we immediately replace with `checkout -b base`.
  await gitCliOrThrow(
    ["clone", "--no-checkout", opts.repoPath, wtPath],
    withTimeout(opts.worktreesDir, opts.timeoutMs),
  );
  const originUrl = await gitCli(
    ["-C", opts.repoPath, "remote", "get-url", "origin"],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  if (originUrl.exitCode === 0) {
    await gitCliOrThrow(
      ["-C", wtPath, "remote", "set-url", "origin", originUrl.stdout.trim()],
      withTimeout(wtPath, opts.timeoutMs),
    );
  } else {
    // fail-closed: do not fall back to a worktree; leave the loud-fail to push.
    process.stderr.write(
      `warning: target ${opts.repoPath} has no 'origin' remote (#410 clone ` +
        `workspace) — leaving clone origin at the local target; a later push ` +
        `will loud-fail rather than push into a local clone\n`,
    );
  }
  await gitCliOrThrow(
    ["-C", wtPath, "checkout", "-b", opts.branch, opts.base],
    withTimeout(wtPath, opts.timeoutMs),
  );
  return { path: wtPath, branch: opts.branch };
}

/**
 * (#410) Discriminate how the run workspace at `worktreePath` was created, with
 * NO schema/DB dependency — the only state cleanup / #404 reclaim have at hand is
 * the path itself, so the filesystem is the single source of truth.
 *
 * - `.git` is a real DIRECTORY → `"clone"` (an independent {@link createCloneWorkspace}).
 *   Must be removed with `rm -rf`; `git worktree remove` fails "not a working tree".
 * - `.git` is a FILE ("gitdir: ..." pointer) → `"worktree"` (a {@link createWorktree}).
 *   Removed via `git worktree remove` so the target's `.git/worktrees/` admin entry
 *   is also cleared.
 * - `.git` is absent (path unmade or already removed) → `"absent"`.
 */
export function workspaceGitKind(
  worktreePath: string,
): "worktree" | "clone" | "absent" {
  const gitPath = join(worktreePath, ".git");
  if (!existsSync(gitPath)) return "absent";
  return statSync(gitPath).isDirectory() ? "clone" : "worktree";
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

/**
 * Remove a run worktree, then delete its branch. Returns whether the branch was
 * actually deleted: worktree removal is fatal (throws on failure), but branch
 * deletion is reported (not thrown) so callers recording an audit (#404
 * `reclaimTerminalRunWorktrees`) never claim `branchRemoved` for a `-D` that
 * silently failed (e.g. the branch is checked out elsewhere).
 */
export async function removeWorktree(
  opts: WorktreeRemoveOpts,
): Promise<{ branchRemoved: boolean }> {
  const removed = await gitCli(
    ["worktree", "remove", "--force", opts.worktreePath],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  if (removed.exitCode !== 0) {
    throw new Error(`worktree remove failed: ${removed.stderr.trim()}`);
  }
  const del = await gitCli(
    ["branch", "-D", opts.branch],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  return { branchRemoved: del.exitCode === 0 };
}

/**
 * (#404) Reclaim stale worktree admin entries — entries under the repo's
 * `.git/worktrees/` whose working directory no longer exists. A run whose
 * worktree dir vanished WITHOUT `git worktree remove` (crashed run / interrupted
 * cleanup) leaves such an entry; left unpruned they accumulate on the project's
 * real `.git` and eventually degrade it. `git worktree prune` only removes
 * entries whose working dir is GONE, so it never touches a live worktree — it is
 * safe to run before every `createWorktree`.
 */
export async function pruneWorktrees(opts: {
  repoPath: string;
  timeoutMs?: number;
}): Promise<void> {
  const pruned = await gitCli(
    ["worktree", "prune"],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  if (pruned.exitCode !== 0) {
    throw new Error(`worktree prune failed: ${pruned.stderr.trim()}`);
  }
}
