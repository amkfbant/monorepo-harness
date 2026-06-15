import { spawnSync } from "node:child_process";
import { minimatch } from "minimatch";

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

/**
 * Guarded write scope = every domain's **compiled** `write` + `deny_write`
 * globs. The compiled policy (from `compileProjectPolicy`) is used rather than
 * the raw profile so kind-template defaults (e.g. a `write`-less domain getting
 * `{root}/**`), placeholder expansion (`{root}` / `{other_domain_roots}` /
 * `{root_deny}`), and the cross-domain deny additions all resolve — otherwise a
 * template-driven profile's guarded paths would be silently missed (not
 * fail-closed). Takes the loose `{ domains }` shape of the compile result so
 * this stays decoupled from the compiler's concrete types.
 */
export function guardedWriteGlobs(compiled: {
  domains: Record<string, { write?: readonly string[]; deny_write?: readonly string[] }>;
}): string[] {
  const globs: string[] = [];
  for (const d of Object.values(compiled.domains)) {
    if (d.write) globs.push(...d.write);
    if (d.deny_write) globs.push(...d.deny_write);
  }
  return [...new Set(globs)];
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
      // Mirror the central gitCli hardening for this sync read: force-disable
      // replace-ref resolution (see git-cli.ts) so the guard sees the real
      // object graph regardless of any local refs/replace/*.
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (r.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed in ${repo}: ${(r.stderr || "").trim()}`,
      );
    }
    return r.stdout;
  };
  return [
    // `--no-renames`: a rename of a GUARDED source to an unguarded path would
    // otherwise collapse to the destination only, hiding the guarded source
    // deletion from the guard check. Surface it as delete(source) + add(dest).
    // `--no-ext-diff --no-textconv`: never run a target-repo diff driver
    // (defense-in-depth; matches DIFF_BASE_ARGS in git/diff.ts).
    ...parseNulPaths(
      run([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        "HEAD",
      ]),
    ),
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
 * (fail-closed) when any uncommitted change lands in the guarded scope — such a
 * change did not go through a reviewed harness run. `guardedGlobs` are the
 * compiled write/deny_write globs (see `guardedWriteGlobs`); the caller resolves
 * them so this stays a pure git+match step.
 */
export function verifyGuarded(opts: {
  guardedGlobs: readonly string[];
  repo: string;
}): VerifyGuardedResult {
  const guardedGlobs = [...opts.guardedGlobs];
  const changed = gitWorkingTreeChangedPaths(opts.repo);
  const violations = findGuardedChanges(changed, guardedGlobs).sort();
  return { ok: violations.length === 0, guardedGlobs, violations };
}
