import type Database from "better-sqlite3";
import { gitCli } from "../git/git-cli.js";
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
 * (#410) Defensive repair of a `core.bare=true` flip on the target repo's shared
 * `.git/config`. A run worktree shares the target's real `.git` common-dir, so an
 * un-isolated git write inside the worktree (e.g. the self allowed-command
 * `npx vitest run` exercising the harness's own git tests) can land on the shared
 * config and set `core.bare=true`. Once bare, EVERY git op on the target fails
 * with "this operation must be run in a work tree" — which also breaks the GC
 * passes below and the run itself, and silently bricks the operator's checkout.
 *
 * This detect-and-repair runs at run start (best-effort, non-blocking): if the
 * target reports bare, set `core.bare=false` and warn loudly. It does NOT prevent
 * the corruption (prevention needs real workspace isolation — see
 * docs/design/proposals/design-410-run-workspace-git-isolation.md Phase 2); it
 * converts a catastrophic silent-fatal target back into a usable one so the next
 * run can proceed and the operator is told.
 */
export async function repairCoreBareFlip(opts: {
  repoPath: string;
  timeoutMs?: number;
}): Promise<{ repaired: boolean }> {
  const gitOpts = {
    cwd: opts.repoPath,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  // --is-bare-repository reflects the effective core.bare; it succeeds even when
  // the repo IS bare (unlike work-tree ops), so it is a safe probe.
  const probe = await gitCli(["rev-parse", "--is-bare-repository"], gitOpts);
  if (probe.exitCode !== 0) {
    // "not a git repository" is a legitimate no-op (e.g. a non-repo path); any
    // OTHER probe failure on what should be the run's target repo (timeout / git
    // error) is worth surfacing — fail-closed best-effort: warn, never throw.
    const stderr = probe.stderr.trim();
    if (!/not a git repository/i.test(stderr)) {
      process.stderr.write(
        `warning: core.bare probe failed for ${opts.repoPath}: ${stderr}\n`,
      );
    }
    return { repaired: false };
  }
  if (probe.stdout.trim() !== "true") return { repaired: false }; // healthy
  const fix = await gitCli(["config", "core.bare", "false"], gitOpts);
  if (fix.exitCode === 0) {
    process.stderr.write(
      `warning: ${opts.repoPath}/.git had core.bare=true (run-workspace .git ` +
        `corruption, #410) — repaired to false\n`,
    );
    return { repaired: true };
  }
  process.stderr.write(
    `warning: ${opts.repoPath}/.git has core.bare=true (#410) and repair failed: ` +
      `${fix.stderr.trim()}\n`,
  );
  return { repaired: false };
}

/**
 * (#404/#410) Reclaim leaked run worktrees on `repoPath` before a new run cuts
 * its own. run worktrees are rooted in the project repo's real `.git`; left
 * un-reclaimed they accumulate and degrade it (`core.bare` flip の遠因). Three
 * best-effort passes, run-start only — NONE blocks the run (each is caught and
 * warned), so a degraded repo never stops work:
 *
 *  0. `repairCoreBareFlip` (#410) — if the target's shared .git was flipped to
 *     `core.bare=true` by a prior run-workspace corruption, repair it FIRST
 *     (else the prune/reclaim git ops below fail "must be run in a work tree").
 *  1. `pruneWorktrees` — clears admin entries whose working dir is already GONE
 *     (crashed run / interrupted cleanup). Never touches a live worktree.
 *  2. `reclaimTerminalRunWorktrees` — removes worktrees of `rejected` runs whose
 *     dir still EXISTS. `approved` is deliberately NOT reclaimed (its worktree
 *     feeds `pr create` and is a valid continuation parent); `changes_requested`
 *     (retry base) and non-terminal runs are left alone too.
 *
 * See docs/specs/workspace.md for the lifecycle and safety rationale.
 */
export async function gcWorktreesBeforeRun(
  opts: RunWorktreeGcOpts,
): Promise<void> {
  // (#410) Repair a bare-flipped target FIRST: if core.bare=true, the prune /
  // reclaim git ops below would themselves fail "must be run in a work tree".
  try {
    await repairCoreBareFlip({
      repoPath: opts.repoPath,
      ...(opts.gitTimeoutMs !== undefined ? { timeoutMs: opts.gitTimeoutMs } : {}),
    });
  } catch (e) {
    process.stderr.write(
      `warning: core.bare repair check failed for ${opts.repoPath}: ${(e as Error).message}\n`,
    );
  }
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
