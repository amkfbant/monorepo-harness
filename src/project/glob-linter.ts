/**
 * Glob linter (Phase 5-6).
 *
 * minimatch patterns are root-anchored: `dist/**` matches only the
 * repo-root `dist/`, NOT `apps/x/dist/`. This linter flags the common
 * mistake of a bare build-output directory glob that almost certainly
 * was meant to be nested (`**\/dist/**`). See docs/policy-semantics.md.
 */

export interface GlobLintFinding {
  glob: string;
  level: "warn";
  message: string;
}

// build/vendor directories that nest under every package, so a root-anchored
// `<name>/**` almost never expresses the operator's intent.
const NESTED_BUILD_DIRS = new Set([
  "dist",
  "build",
  "coverage",
  "node_modules",
  "out",
  ".turbo",
  ".next",
]);

const BARE_DIR_GLOB = /^([^/*]+)\/\*\*$/;

export function lintGlobs(globs: readonly string[]): GlobLintFinding[] {
  const findings: GlobLintFinding[] = [];
  for (const glob of globs) {
    const m = glob.match(BARE_DIR_GLOB);
    const dir = m?.[1];
    if (dir !== undefined && NESTED_BUILD_DIRS.has(dir)) {
      findings.push({
        glob,
        level: "warn",
        message: `"${glob}" is root-anchored — it matches only the repo-root ${dir}/. Use "**/${dir}/**" to also match nested ${dir} directories.`,
      });
    }
  }
  return findings;
}
