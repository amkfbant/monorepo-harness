import { gitCliOrThrow } from "./git-cli.js";

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  deletedFiles: number;
}

export interface DiffResult {
  /** tracked-file changes between baseSha and the working tree */
  trackedChangedPaths: string[];
  /** staged/index changes between baseSha and the git index */
  stagedChangedPaths: string[];
  /**
   * Files present in the working tree but not yet tracked.
   * .gitignore is NOT honored here — callers must apply their own
   * ignore list so codex-created throwaway files surface to validation.
   */
  untrackedPaths: string[];
  /** tracked diff line/file counts from git numstat + exact deleted-file pass */
  stat: DiffStat;
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

function parseNumStatCount(raw: string): number {
  if (raw === "-") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`git diff --numstat parse error: invalid count "${raw}"`);
  }
  return n;
}

function parseNumStat(numstat: string, deletedFiles: number): DiffStat {
  const fields = numstat.length === 0 ? [] : numstat.split("\0");
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (let i = 0; i < fields.length;) {
    const row = fields[i];
    i += 1;
    if (row === undefined || row.length === 0) continue;
    const firstTab = row.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : row.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error(`git diff --numstat parse error: malformed row "${row}"`);
    }
    const added = parseNumStatCount(row.slice(0, firstTab));
    const deleted = parseNumStatCount(row.slice(firstTab + 1, secondTab));
    const path = row.slice(secondTab + 1);
    if (path === "") {
      // With -z, rename/copy rows are: add<TAB>del<TAB><NUL>old<NUL>new<NUL>.
      if (i + 1 >= fields.length) {
        throw new Error("git diff --numstat parse error: malformed rename row");
      }
      i += 2;
    }
    filesChanged += 1;
    insertions += added;
    deletions += deleted;
  }
  return { filesChanged, insertions, deletions, deletedFiles };
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
  const staged = await gitCliOrThrow(
    [...DIFF_BASE_ARGS, "--cached", "--name-only", "-z", opts.baseSha],
    g,
  );
  const numstat = await gitCliOrThrow(
    [...DIFF_BASE_ARGS, "--numstat", "-z", opts.baseSha],
    g,
  );
  const deletedFiles = await gitCliOrThrow(
    [...DIFF_BASE_ARGS, "--diff-filter=D", "--name-only", "-z", opts.baseSha],
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
    stagedChangedPaths: parseNullSeparated(staged),
    untrackedPaths: parseNullSeparated(untracked),
    stat: parseNumStat(numstat, parseNullSeparated(deletedFiles).length),
    patch,
  };
}
