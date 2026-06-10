import { spawnSync } from "node:child_process";
import { minimatch } from "minimatch";
import type { ProjectProfile } from "../project/schema.js";

const MATCH_OPTS = { dot: true, nocomment: true } as const;

/**
 * `verify-guarded` (#69) — a read-only check that no out-of-band (non-harness)
 * change has landed in a guarded domain of the target repo.
 *
 * The harness verifies its OWN mutations via post-hoc `git diff` against the
 * policy scope, but nothing stops an operator from editing a guarded path
 * directly (e.g. with a plain editor). This module detects the most common and
 * the most clearly fail-closed case: **uncommitted working-tree changes** to a
 * guarded path. The harness only lands changes through reviewed, committed runs,
 * so any uncommitted change to a guarded path is, by construction, unverified.
 *
 * NOTE (scope): committed-history attribution (which past commits were authored
 * by a reviewed harness run) needs a recorded reviewed-head-sha to be sound and
 * is intentionally out of scope here — it is deferred to a follow-up rather than
 * guessed at by commit author/message (which would be spoofable / not
 * fail-closed). This command does not mandate "always use the harness"; it only
 * surfaces unverified guarded edits so an operator / CI / pre-push hook can act.
 */

/** Guarded write scope = every domain's `write` + `deny_write` globs. */
export function guardedWriteGlobs(profile: ProjectProfile): string[] {
  const globs: string[] = [];
  for (const d of profile.domains) {
    if (d.write) globs.push(...d.write);
    if (d.deny_write) globs.push(...d.deny_write);
  }
  return globs;
}

/**
 * The subset of `changedPaths` (repo-relative) that lands in a guarded scope.
 * Pure over already-resolved inputs so it can be unit tested without a repo.
 */
export function findGuardedChanges(
  changedPaths: readonly string[],
  guardedGlobs: readonly string[],
): string[] {
  return changedPaths.filter((p) =>
    guardedGlobs.some((g) => minimatch(p, g, MATCH_OPTS)),
  );
}

/**
 * Parse NUL-delimited git output (`-z`) into a path list. NUL-delimited so a
 * path containing whitespace or a newline is preserved exactly (cf. #103: never
 * trim line-oriented git output).
 */
export function parseNulPaths(stdout: string): string[] {
  return stdout.split("\0").filter((p) => p !== "");
}

/**
 * All uncommitted working-tree changes in `repo`: tracked modifications/staged
 * (`git diff --name-only -z HEAD`) plus untracked, non-ignored files
 * (`git ls-files --others --exclude-standard -z`). Gitignored paths (e.g.
 * `.harness/**`, `node_modules/**`) are excluded by git itself. NUL-delimited so
 * paths are preserved exactly.
 */
export function gitWorkingTreeChangedPaths(repo: string): string[] {
  const run = (args: string[]): string => {
    const r = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed in ${repo}: ${(r.stderr || "").trim()}`,
      );
    }
    return r.stdout;
  };
  return [
    ...parseNulPaths(run(["diff", "--name-only", "-z", "HEAD"])),
    ...parseNulPaths(run(["ls-files", "--others", "--exclude-standard", "-z"])),
  ];
}

export interface VerifyGuardedResult {
  ok: boolean;
  guardedGlobs: string[];
  violations: string[];
}

/**
 * Detect uncommitted out-of-band changes to guarded domains in `repo`. ok=false
 * (fail-closed) when any uncommitted change lands in a guarded write/deny_write
 * scope — such a change did not go through a reviewed harness run.
 */
export function verifyGuarded(opts: {
  profile: ProjectProfile;
  repo: string;
}): VerifyGuardedResult {
  const guardedGlobs = guardedWriteGlobs(opts.profile);
  const changed = gitWorkingTreeChangedPaths(opts.repo);
  const violations = findGuardedChanges(changed, guardedGlobs).sort();
  return { ok: violations.length === 0, guardedGlobs, violations };
}
