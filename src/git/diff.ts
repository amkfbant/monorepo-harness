import { gitCliOrThrow } from "./git-cli.js";

export interface DiffResult {
  /** tracked-file changes between baseSha and the working tree */
  trackedChangedPaths: string[];
  /** files present in the working tree but not yet tracked */
  untrackedPaths: string[];
  /** unified diff against baseSha for tracked changes only */
  patch: string;
}

export interface DiffOpts {
  repoPath: string;
  baseSha: string;
  timeoutMs?: number;
}

function withTimeout(repoPath: string, timeoutMs: number | undefined) {
  const o: { cwd: string; timeoutMs?: number } = { cwd: repoPath };
  if (timeoutMs !== undefined) o.timeoutMs = timeoutMs;
  return o;
}

function parseNullSeparated(s: string): string[] {
  if (s.length === 0) return [];
  return s.split("\0").filter((p) => p.length > 0);
}

export async function resolveBaseSha(opts: {
  repoPath: string;
  baseBranch: string;
  timeoutMs?: number;
}): Promise<string> {
  const out = await gitCliOrThrow(
    ["rev-parse", "--verify", opts.baseBranch],
    withTimeout(opts.repoPath, opts.timeoutMs),
  );
  return out.trim();
}

export async function collectDiff(opts: DiffOpts): Promise<DiffResult> {
  const g = withTimeout(opts.repoPath, opts.timeoutMs);
  // tracked changes (working tree vs baseSha), NUL-separated paths
  const tracked = await gitCliOrThrow(
    ["diff", "--name-only", "-z", opts.baseSha],
    g,
  );
  // untracked files NOT yet staged. exclude-standard respects .gitignore.
  const untracked = await gitCliOrThrow(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    g,
  );
  // patch for tracked changes only. untracked files are reported separately
  // so the index is not polluted with `git add -N`.
  const patch = await gitCliOrThrow(["diff", opts.baseSha], g);
  return {
    trackedChangedPaths: parseNullSeparated(tracked),
    untrackedPaths: parseNullSeparated(untracked),
    patch,
  };
}
