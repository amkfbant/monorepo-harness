import { gitCliOrThrow } from "./git-cli.js";

export interface DiffResult {
  /** tracked-file changes between baseSha and the working tree */
  trackedChangedPaths: string[];
  /**
   * Files present in the working tree but not yet tracked.
   * .gitignore is NOT honored here — callers must apply their own
   * ignore list so codex-created throwaway files surface to validation.
   */
  untrackedPaths: string[];
  /** unified diff against baseSha for tracked changes only */
  patch: string;
}

export interface DiffOpts {
  repoPath: string;
  baseSha: string;
  timeoutMs?: number;
}

// `--no-ext-diff` blocks per-repo `diff.external` drivers; `--no-textconv`
// blocks per-file textconv filters. Either could be configured in the
// TARGET repo to run arbitrary shell commands during artifact collection
// — outside the codex env allowlist — so we disable them on every diff.
const DIFF_BASE_ARGS = ["diff", "--no-ext-diff", "--no-textconv"] as const;

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
  const tracked = await gitCliOrThrow(
    [...DIFF_BASE_ARGS, "--name-only", "-z", opts.baseSha],
    g,
  );
  // NOTE: no --exclude-standard so .gitignore'd files still surface.
  // Filtering belongs in the harness (policy.ignoreUntracked) so codex
  // cannot hide behavior in throwaway / generated files.
  const untracked = await gitCliOrThrow(
    ["ls-files", "--others", "-z"],
    g,
  );
  const patch = await gitCliOrThrow([...DIFF_BASE_ARGS, opts.baseSha], g);
  return {
    trackedChangedPaths: parseNullSeparated(tracked),
    untrackedPaths: parseNullSeparated(untracked),
    patch,
  };
}
