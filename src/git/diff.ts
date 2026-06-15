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

interface NumStatRow {
  path: string;
  insertions: number;
  deletions: number;
}

// `--no-ext-diff` blocks per-repo `diff.external` drivers; `--no-textconv`
// blocks per-file textconv filters. Either could be configured in the
// TARGET repo to run arbitrary shell commands during artifact collection
// — outside the codex env allowlist — so we disable them on every diff.
//
// `--no-renames` is a SECURITY flag, not cosmetic: with rename detection on
// (git's default), a rename of an OUT-OF-SCOPE tracked source into an in-scope
// destination collapses to the destination path only, hiding the out-of-scope
// SOURCE DELETION from policy/budget/subset validation — a coder could delete
// arbitrary out-of-scope files by renaming them into scope. With `--no-renames`
// every rename surfaces as a delete (source) + add (destination), so the
// out-of-scope source deletion is always validated (fail-closed, conservative).
const DIFF_BASE_ARGS = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
] as const;

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

function parseNumStatRows(numstat: string): NumStatRow[] {
  const fields = numstat.length === 0 ? [] : numstat.split("\0");
  const rows: NumStatRow[] = [];
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
    let path = row.slice(secondTab + 1);
    if (path === "") {
      // With -z, rename/copy rows are: add<TAB>del<TAB><NUL>old<NUL>new<NUL>.
      if (i + 1 >= fields.length) {
        throw new Error("git diff --numstat parse error: malformed rename row");
      }
      path = fields[i + 1] ?? "";
      i += 2;
    }
    if (path === "") {
      throw new Error("git diff --numstat parse error: missing path");
    }
    rows.push({ path, insertions: added, deletions: deleted });
  }
  return rows;
}

function combineNumStat(
  numstats: readonly string[],
  deletedFileLists: readonly string[],
): DiffStat {
  const byPath = new Map<string, NumStatRow>();
  for (const numstat of numstats) {
    for (const row of parseNumStatRows(numstat)) {
      const prev = byPath.get(row.path);
      byPath.set(row.path, {
        path: row.path,
        insertions: Math.max(prev?.insertions ?? 0, row.insertions),
        deletions: Math.max(prev?.deletions ?? 0, row.deletions),
      });
    }
  }
  const deletedFiles = new Set<string>();
  for (const list of deletedFileLists) {
    for (const path of parseNullSeparated(list)) deletedFiles.add(path);
  }
  let insertions = 0;
  let deletions = 0;
  for (const row of byPath.values()) {
    insertions += row.insertions;
    deletions += row.deletions;
  }
  return {
    filesChanged: byPath.size,
    insertions,
    deletions,
    deletedFiles: deletedFiles.size,
  };
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
  const stagedNumstat = await gitCliOrThrow(
    [...DIFF_BASE_ARGS, "--cached", "--numstat", "-z", opts.baseSha],
    g,
  );
  const deletedFiles = await gitCliOrThrow(
    [...DIFF_BASE_ARGS, "--diff-filter=D", "--name-only", "-z", opts.baseSha],
    g,
  );
  const stagedDeletedFiles = await gitCliOrThrow(
    [
      ...DIFF_BASE_ARGS,
      "--cached",
      "--diff-filter=D",
      "--name-only",
      "-z",
      opts.baseSha,
    ],
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
    stat: combineNumStat(
      [numstat, stagedNumstat],
      [deletedFiles, stagedDeletedFiles],
    ),
    patch,
  };
}
