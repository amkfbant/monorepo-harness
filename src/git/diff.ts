import { gitCli, gitCliOrThrow } from "./git-cli.js";

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

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// git pseudo-refs that resolve specially at the top level (and `@`, the HEAD
// alias). A base of `HEAD` would otherwise resolve via `refs/remotes/origin/HEAD`
// (a clone's default-branch symref) and `FETCH_HEAD`/`ORIG_HEAD` resolve transient
// state — none are "a branch", so reject them outright.
const PSEUDO_REFS = new Set([
  "@",
  "HEAD",
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_HEAD",
]);

// A real branch name, NOT a rev-expression, refspec, or pseudo-ref: blocks
// rev-syntax (`~ ^ : ? * [ \`), control chars, `@{`, `..`, a leading `-` (git
// option-injection) / leading or trailing `/`, and the pseudo-refs above.
// baseBranch is operator-supplied (CLI / project config), so this is
// defense-in-depth, but it keeps the value safe to pass to `git fetch` /
// `rev-parse` and avoids `main~1` / `HEAD` silently resolving to an unexpected
// commit.
function isSafeRefName(s: string): boolean {
  if (s.length === 0 || s.length > 255) return false;
  if (s.startsWith("-") || s.startsWith("/") || s.endsWith("/")) return false;
  if (s.includes("..") || s.includes("@{") || PSEUDO_REFS.has(s)) return false;
  return !/[\x00-\x20~^:?*[\\\x7f]/.test(s);
}

async function revParseCommit(
  ref: string,
  g: { cwd: string; timeoutMs?: number },
): Promise<string | null> {
  // `--end-of-options` so a hostile `ref` cannot be parsed as a git option;
  // `^{commit}` peels tags/commit-ish to a commit; `--quiet` → exit 1 (no SHA)
  // on failure instead of throwing.
  const r = await gitCli(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    g,
  );
  if (r.timedOut) {
    // fail-closed: a timeout must NOT silently fall through to the next candidate
    // (which could resolve a different/stale base).
    throw new Error(`git rev-parse of "${ref}" timed out`);
  }
  const sha = r.stdout.trim();
  return r.exitCode === 0 && FULL_SHA_RE.test(sha) ? sha : null;
}

export async function resolveBaseSha(opts: {
  repoPath: string;
  baseBranch: string;
  timeoutMs?: number;
  /**
   * Best-effort `git fetch origin <base>` before resolving (default true) so the
   * run worktree + diff base branch from the REMOTE tip, not a stale local ref
   * (#154). Set false for hermetic / offline resolution (e.g. tests, repos with
   * no remote where local refs are authoritative).
   */
  fetchRemote?: boolean;
}): Promise<string> {
  const g = withTimeout(opts.repoPath, opts.timeoutMs);
  const { baseBranch } = opts;

  // A pinned full SHA resolves directly — no fetch, no remote-tracking candidate.
  if (FULL_SHA_RE.test(baseBranch)) {
    const sha = await revParseCommit(baseBranch, g);
    if (sha !== null) return sha;
    throw new Error(
      `cannot resolve base commit "${baseBranch}" in ${opts.repoPath}`,
    );
  }
  if (!isSafeRefName(baseBranch)) {
    throw new Error(
      `invalid base branch "${baseBranch}": expected a branch name or 40-hex ` +
        `SHA (no rev-expression / refspec syntax)`,
    );
  }

  // Refresh origin/<base> so we branch from the remote tip, not a stale local ref
  // (#154: merges landing via `gh pr merge` leave the local clone behind). The
  // fetch is BEST-EFFORT and its result GATES whether origin is trusted: offline,
  // no remote, a local-only base branch (#195), or a transient spawn error make
  // it fail, and a STALE `origin/<base>` remote-tracking ref must NOT then be
  // preferred over the local branch (it is no fresher than local).
  let fetchOk = false;
  if (opts.fetchRemote !== false) {
    try {
      const r = await gitCli(
        [
          "fetch",
          "--no-tags",
          "origin",
          // anchor the src to refs/heads/<base> so only the remote BRANCH is
          // fetched (not a tag / pseudo-ref of the same name).
          `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
        ],
        g,
      );
      fetchOk = r.exitCode === 0 && !r.timedOut;
    } catch {
      fetchOk = false; // spawn error (ENOENT/EACCES/EAGAIN) → degrade to local
    }
  }

  // Resolve in priority order, NEVER silently falling back to a DIFFERENT base
  // (#195: a `--base-branch` that resolved nowhere used to slide to main, wasting
  // the run). When the fetch refreshed origin, prefer the fresh remote tip;
  // otherwise prefer the local branch (the operator's current state) and only
  // fall back to a possibly-stale remote-tracking ref as a last resort. The local
  // candidate is anchored to refs/heads/<base> so only a real branch resolves (not
  // HEAD / a tag / a pseudo-ref).
  const originRef = `refs/remotes/origin/${baseBranch}`;
  const localRef = `refs/heads/${baseBranch}`;
  const candidates = fetchOk
    ? [originRef, localRef]
    : [localRef, originRef];
  for (const ref of candidates) {
    const sha = await revParseCommit(ref, g);
    if (sha !== null) return sha;
  }
  throw new Error(
    `cannot resolve base branch "${baseBranch}" in ${opts.repoPath}: ` +
      `no origin/${baseBranch} or local ${baseBranch} ` +
      `(refusing to silently fall back to a different base)`,
  );
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
