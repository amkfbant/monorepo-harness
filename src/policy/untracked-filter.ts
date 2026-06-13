import { minimatch } from "minimatch";

// minimatch options shared by every policy-glob match in the harness.
// `dot: true` so dotfiles match; `nocomment: true` so a leading `#` in a glob
// is a literal path char, not a comment. See docs/policy-semantics.md for the
// root-anchored matching pitfalls these globs must respect.
export const UNTRACKED_MATCH_OPTS = { dot: true, nocomment: true } as const;

/**
 * Split untracked paths into those the policy KEEPS (subject to write-scope
 * validation) and those it IGNORES (policy.ignoreUntracked, e.g. node_modules,
 * dist). `.gitignore` is deliberately NOT honored upstream (collectDiff runs
 * `git ls-files --others` without `--exclude-standard`) so codex cannot hide
 * behavior in throwaway/generated files; this policy list is the only filter.
 */
export function partitionUntracked(
  paths: readonly string[],
  ignoreGlobs: readonly string[],
): { kept: string[]; ignored: string[] } {
  if (ignoreGlobs.length === 0) return { kept: [...paths], ignored: [] };
  const kept: string[] = [];
  const ignored: string[] = [];
  for (const p of paths) {
    if (ignoreGlobs.some((g) => minimatch(p, g, UNTRACKED_MATCH_OPTS))) {
      ignored.push(p);
    } else {
      kept.push(p);
    }
  }
  return { kept, ignored };
}
