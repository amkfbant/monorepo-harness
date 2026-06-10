import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitCli, type GitResult } from "../git/git-cli.js";
import { assertSymlinkCapable } from "./fs-preflight.js";

/**
 * Agent workspace management: a thin, deterministic wrapper over `git worktree`
 * that lets multiple LLM agents / terminals work the same project concurrently
 * without colliding on a shared checkout. Each agent gets its OWN working tree
 * (own index / HEAD) on a dedicated `agent/<name>` branch, while the harness
 * state (HARNESS_ROOT / `.harness` DB, domain locks, goals, knowledge) stays
 * shared. git itself is the source of truth — there is no DB mirror to drift.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/** Injectable git runner (real git by default; fakes in tests). */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitResult>;

export function defaultGitRunner(timeoutMs = DEFAULT_TIMEOUT_MS): GitRunner {
  return (args, cwd) => gitCli(args, { cwd, timeoutMs });
}

export class AgentWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWorkspaceError";
  }
}

const AGENT_BRANCH_PREFIX = "agent/";

// First char alphanumeric; the rest [a-zA-Z0-9._-]; 1-64 chars. Keeps the name
// safe as both a branch suffix and a directory name (no slashes, no traversal).
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function assertAgentName(agent: string): void {
  if (!AGENT_NAME_RE.test(agent)) {
    throw new AgentWorkspaceError(
      `invalid agent name ${JSON.stringify(agent)}; use 1-64 chars of ` +
        `[a-zA-Z0-9._-] starting with an alphanumeric`,
    );
  }
}

/** The dedicated branch for an agent's workspace. */
export function agentBranch(agent: string): string {
  return `${AGENT_BRANCH_PREFIX}${agent}`;
}

/** The agent name encoded in a branch, or null if it is not an agent branch. */
export function agentNameFromBranch(branch: string | null): string | null {
  if (branch === null) return null;
  if (!branch.startsWith(AGENT_BRANCH_PREFIX)) return null;
  return branch.slice(AGENT_BRANCH_PREFIX.length);
}

/** Absolute-ish path where an agent's worktree lives under `workspacesDir`. */
export function agentWorkspacePath(
  workspacesDir: string,
  agent: string,
): string {
  return join(workspacesDir, agent);
}

export interface ParsedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
}

/** Parse `git worktree list --porcelain` output into structured records. */
export function parseWorktreePorcelain(stdout: string): ParsedWorktree[] {
  const blocks = stdout.split(/\n\n+/);
  const out: ParsedWorktree[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
      // a bare `detached` line leaves branch null.
    }
    if (path !== null) out.push({ path, head, branch });
  }
  return out;
}

/**
 * Parse NUL-delimited `git status --porcelain -z` into the list of changed
 * paths. `-z` avoids the rename/quote ambiguity of newline porcelain: a
 * rename/copy entry (`R`/`C`) is followed by its original path as a separate
 * NUL record, which we skip after reporting the destination path.
 */
export function parseStatusPorcelain(stdout: string): string[] {
  const tokens = stdout.split("\0");
  const files: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // each status record is `XY <path>` (2 status chars + space + path).
    if (t === undefined || t.length < 4) continue;
    files.push(t.slice(3));
    // a rename/copy carries the ORIGINAL path as the next NUL record — skip it.
    const xy = t.slice(0, 2);
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return files;
}

/**
 * Parse `git rev-list --left-right --count <base>...<branch>` output. git emits
 * `<left>\t<right>` where, for `base...branch`, left = commits on base not on
 * branch (= behind) and right = commits on branch not on base (= ahead).
 * Fail-closed: anything that is not exactly two non-negative integers throws
 * rather than being silently read as 0/0.
 */
export function parseAheadBehind(stdout: string): {
  behind: number;
  ahead: number;
} {
  const parts = stdout.trim().split(/\s+/);
  const isCount = (s: string | undefined): s is string =>
    s !== undefined && /^\d+$/.test(s);
  if (parts.length !== 2 || !isCount(parts[0]) || !isCount(parts[1])) {
    throw new AgentWorkspaceError(
      `unexpected rev-list --count output: ${JSON.stringify(stdout)}`,
    );
  }
  return { behind: Number(parts[0]), ahead: Number(parts[1]) };
}

export interface AgentWorkspace {
  agent: string;
  path: string;
  branch: string;
  head: string | null;
}

export interface AgentWorkspaceContext {
  /** the main checkout / repo the agent workspaces are worktrees of */
  repoPath: string;
  /** directory under which per-agent worktrees are created */
  workspacesDir: string;
  git?: GitRunner;
}

async function git(
  ctx: AgentWorkspaceContext,
  args: readonly string[],
): Promise<GitResult> {
  return (ctx.git ?? defaultGitRunner())(args, ctx.repoPath);
}

/**
 * A stable identity for the git repository at `repoPath`, used as the DB index
 * key so the same project resolves to ONE key regardless of how it is reached —
 * the repo root, a subdirectory, a symlinked path, or one of its own agent
 * worktrees. Uses the (absolute, realpath'd) common git dir, which every linked
 * worktree shares. Throws if `repoPath` is not inside a git repository.
 */
export async function canonicalRepoKey(ctx: {
  repoPath: string;
  git?: GitRunner;
}): Promise<string> {
  const run = ctx.git ?? defaultGitRunner();
  const r = await run(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ctx.repoPath,
  );
  if (r.exitCode !== 0 || r.timedOut) {
    throw new AgentWorkspaceError(
      `not a git repository: ${ctx.repoPath} (${r.stderr.trim()})`,
    );
  }
  const commonDir = r.stdout.trim();
  try {
    return realpathSync(commonDir);
  } catch {
    // common dir should exist, but fall back to the un-realpath'd absolute path
    // rather than throwing on a filesystem quirk.
    return commonDir;
  }
}

/**
 * Does the git worktree at `path` PROVABLY still belong to `repoKey`? True only
 * when its canonical repo key (`git rev-parse --git-common-dir`) equals
 * `repoKey`. A path that no longer resolves (deleted) or now belongs to a
 * DIFFERENT repo (the dir was reused for another repo) returns false — so a
 * caller never runs git against a foreign repository even when git's stale
 * worktree metadata still lists the path. Fail-closed: a git error → false.
 */
export async function worktreeBelongsToRepo(
  path: string,
  repoKey: string,
  git?: GitRunner,
): Promise<boolean> {
  try {
    return (await canonicalRepoKey({ repoPath: path, ...(git ? { git } : {}) })) === repoKey;
  } catch {
    return false;
  }
}

/**
 * The main working tree of the repository reachable from `repoPath`. git
 * `worktree list` always reports the main worktree first. Used as a STABLE cwd
 * for git operations: a command run with the to-be-deleted agent worktree as
 * its cwd (e.g. `workspace remove` pointed at that worktree) would, after the
 * worktree is removed, run its remaining git steps against a path that no
 * longer exists (`spawn git ENOENT`). Resolving to the main worktree avoids it.
 */
export async function resolveMainWorktree(ctx: {
  repoPath: string;
  git?: GitRunner;
}): Promise<string> {
  const run = ctx.git ?? defaultGitRunner();
  const r = await run(["worktree", "list", "--porcelain"], ctx.repoPath);
  if (r.exitCode !== 0 || r.timedOut) {
    throw new AgentWorkspaceError(
      `not a git repository: ${ctx.repoPath} (${r.stderr.trim()})`,
    );
  }
  const first = parseWorktreePorcelain(r.stdout)[0];
  if (first === undefined) {
    throw new AgentWorkspaceError(`no git worktree at ${ctx.repoPath}`);
  }
  return first.path;
}

async function branchExists(
  ctx: AgentWorkspaceContext,
  branch: string,
): Promise<boolean> {
  const r = await git(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.exitCode === 0;
}

/**
 * Canonicalize a worktree path for identity comparison: realpath when it exists
 * (resolves symlinks / `/var`→`/private/var`), else a plain absolute resolve.
 * Used on BOTH the user input and git-reported paths so a symlinked path does
 * not cause a false "not a worktree" or a wrong main-worktree match.
 */
export function normalizeWorktreePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** ALL git worktrees of the repo (parsed), the MAIN one first (git's order). */
export async function listWorktrees(
  ctx: AgentWorkspaceContext,
): Promise<ParsedWorktree[]> {
  const r = await git(ctx, ["worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0 || r.timedOut) {
    throw new AgentWorkspaceError(
      `git worktree list failed: ${r.stderr.trim()}`,
    );
  }
  return parseWorktreePorcelain(r.stdout);
}

/**
 * Register an EXISTING git worktree of the repo as agent `<name>`, on whatever
 * branch it is currently on (the `agent/<name>` convention is not required).
 * Unlike `create`, it never creates a worktree or branch — it fails if the path
 * is not a current worktree. The caller records the returned record in the DB
 * index; `list`/`status` then surface it (reconciled by worktree path).
 */
export async function adoptAgentWorkspace(
  ctx: AgentWorkspaceContext,
  opts: { agent: string; worktreePath: string },
): Promise<AgentWorkspace> {
  assertAgentName(opts.agent);
  const target = normalizeWorktreePath(opts.worktreePath);
  const worktrees = await listWorktrees(ctx);
  // normalize BOTH sides: git may report a symlinked / non-realpath path.
  const wt = worktrees.find(
    (w) => normalizeWorktreePath(w.path) === target,
  );
  if (wt === undefined) {
    throw new AgentWorkspaceError(
      `${opts.worktreePath} is not a git worktree of this repository`,
    );
  }
  // git lists the MAIN worktree first; never adopt the primary checkout as an
  // agent (it is the shared tree, not an isolated per-agent one).
  if (
    worktrees[0] !== undefined &&
    normalizeWorktreePath(worktrees[0].path) === target
  ) {
    throw new AgentWorkspaceError(
      `cannot adopt the main worktree (${target}); adopt an additional worktree`,
    );
  }
  if (wt.branch === null) {
    throw new AgentWorkspaceError(
      `worktree ${opts.worktreePath} is detached (no branch); adopt requires a branch`,
    );
  }
  return { agent: opts.agent, path: wt.path, branch: wt.branch, head: wt.head };
}

/** List the harness-managed agent workspaces (branch `agent/*`). */
export async function listAgentWorkspaces(
  ctx: AgentWorkspaceContext,
): Promise<AgentWorkspace[]> {
  const r = await git(ctx, ["worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0) {
    throw new AgentWorkspaceError(
      `git worktree list failed: ${r.stderr.trim()}`,
    );
  }
  const out: AgentWorkspace[] = [];
  for (const wt of parseWorktreePorcelain(r.stdout)) {
    const agent = agentNameFromBranch(wt.branch);
    if (agent === null) continue;
    out.push({ agent, path: wt.path, branch: wt.branch as string, head: wt.head });
  }
  return out;
}

/**
 * Create (or return the existing) isolated worktree for an agent on its
 * `agent/<name>` branch. Idempotent: a second call for the same agent returns
 * the existing workspace rather than failing. Reuses the branch if it already
 * exists; otherwise creates it from `base`.
 */
export async function createAgentWorkspace(
  ctx: AgentWorkspaceContext,
  opts: { agent: string; base: string },
): Promise<AgentWorkspace & { created: boolean }> {
  assertAgentName(opts.agent);
  const branch = agentBranch(opts.agent);
  const path = agentWorkspacePath(ctx.workspacesDir, opts.agent);

  // Idempotent: if this agent already has a worktree, return it unchanged.
  const existing = (await listAgentWorkspaces(ctx)).find(
    (w) => w.agent === opts.agent,
  );
  if (existing !== undefined) return { ...existing, created: false };

  // (#68) The agent workspace is created as a sibling of the repo, which may sit
  // on a different (symlink-incapable) FS than HARNESS_ROOT — fail fast there.
  assertSymlinkCapable(ctx.workspacesDir);
  const hasBranch = await branchExists(ctx, branch);
  const addArgs = hasBranch
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, opts.base];
  const r = await git(ctx, addArgs);
  if (r.exitCode !== 0) {
    throw new AgentWorkspaceError(
      `failed to create workspace for agent ${JSON.stringify(opts.agent)}: ` +
        r.stderr.trim(),
    );
  }
  const created = (await listAgentWorkspaces(ctx)).find(
    (w) => w.agent === opts.agent,
  );
  if (created === undefined) {
    throw new AgentWorkspaceError(
      `workspace for agent ${JSON.stringify(opts.agent)} was not registered by git`,
    );
  }
  return { ...created, created: true };
}

/**
 * Remove an agent's worktree (and, by default, its branch). Without `force`,
 * git refuses to remove a worktree with uncommitted changes — that refusal is
 * surfaced as an error rather than silently discarding work.
 */
export async function removeAgentWorkspace(
  ctx: AgentWorkspaceContext,
  opts: {
    agent: string;
    force?: boolean;
    keepBranch?: boolean;
    /** the resolved live workspace (path-first), e.g. an adopted any-branch one */
    workspace?: AgentWorkspace;
  },
): Promise<{ removed: boolean }> {
  assertAgentName(opts.agent);
  // Prefer the caller-resolved workspace (works for adopted non-agent/* trees);
  // fall back to the agent/* lookup.
  const existing =
    opts.workspace !== undefined && opts.workspace.agent === opts.agent
      ? opts.workspace
      : (await listAgentWorkspaces(ctx)).find((w) => w.agent === opts.agent);
  if (existing === undefined) return { removed: false };

  const removeArgs = ["worktree", "remove", existing.path];
  if (opts.force === true) removeArgs.push("--force");
  const r = await git(ctx, removeArgs);
  if (r.exitCode !== 0) {
    throw new AgentWorkspaceError(
      `failed to remove workspace for agent ${JSON.stringify(opts.agent)} ` +
        `(use --force to discard uncommitted changes): ${r.stderr.trim()}`,
    );
  }
  if (opts.keepBranch !== true) {
    // Best-effort branch delete; a checked-out-elsewhere branch would fail, but
    // the worktree (the thing the agent used) is already gone.
    await git(ctx, ["branch", "-D", existing.branch]);
  }
  return { removed: true };
}

/**
 * The set of files an agent workspace has changed relative to `base`: its
 * committed-ahead diff (`base...branch`) unioned with its uncommitted working
 * tree. Used by the cross-agent conflict pre-check. Fail-closed on git errors;
 * a missing base ref degrades to the uncommitted set only (best-effort).
 */
export async function changedFilesForWorkspace(
  ctx: AgentWorkspaceContext,
  opts: { agent: string; base?: string; workspace?: AgentWorkspace },
): Promise<string[]> {
  assertAgentName(opts.agent);
  const ws =
    opts.workspace !== undefined && opts.workspace.agent === opts.agent
      ? opts.workspace
      : (await listAgentWorkspaces(ctx)).find((w) => w.agent === opts.agent);
  if (ws === undefined) {
    throw new AgentWorkspaceError(
      `no workspace for agent ${JSON.stringify(opts.agent)}`,
    );
  }
  const base = opts.base ?? "main";
  const run = ctx.git ?? defaultGitRunner();

  // `--no-renames` for conflict detection: a rename `foo -> bar` is split into a
  // delete of `foo` and an add of `bar`, so BOTH endpoints are captured. (This
  // differs from inspect, which uses `--renames` for a tidier display.) Without
  // it, an agent renaming `foo` would not conflict with one editing `foo`.
  const status = await run(
    ["status", "--porcelain", "-z", "--no-renames"],
    ws.path,
  );
  if (status.exitCode !== 0 || status.timedOut) {
    throw new AgentWorkspaceError(
      `git status failed in ${ws.path}: ${status.stderr.trim()}`,
    );
  }
  const files = new Set(parseStatusPorcelain(status.stdout));

  const baseCheck = await run(
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    ws.path,
  );
  if (baseCheck.timedOut) {
    throw new AgentWorkspaceError(
      `git rev-parse timed out resolving base ${JSON.stringify(base)} in ${ws.path}`,
    );
  }
  if (baseCheck.exitCode === 0) {
    const diff = await run(
      ["diff", "--name-only", "-z", "--no-renames", `${base}...${ws.branch}`],
      ws.path,
    );
    if (diff.exitCode !== 0 || diff.timedOut) {
      throw new AgentWorkspaceError(
        `git diff failed for ${JSON.stringify(base)}...${ws.branch} in ${ws.path}: ` +
          diff.stderr.trim(),
      );
    }
    for (const f of diff.stdout.split("\0")) {
      if (f !== "") files.add(f);
    }
  } else if (baseCheck.stderr.trim() !== "") {
    throw new AgentWorkspaceError(
      `git rev-parse failed resolving base ${JSON.stringify(base)} in ${ws.path}: ` +
        baseCheck.stderr.trim(),
    );
  }
  return [...files];
}

export interface WorkspaceInspection {
  agent: string;
  path: string;
  branch: string;
  head: string | null;
  base: string;
  /** false when `base` could not be resolved (ahead/behind are then 0). */
  baseResolved: boolean;
  ahead: number;
  behind: number;
  dirtyFiles: string[];
  lastCommit: { sha: string; subject: string } | null;
}

/**
 * A deterministic briefing of an agent's workspace, reconstructed entirely from
 * git (no stored state): branch / HEAD, uncommitted files, ahead/behind vs a
 * base, and the last commit. This is the authoritative "what is the state of
 * this workspace" layer — an LLM reads it to understand its own (or another
 * agent's) workspace without trusting any saved self-report.
 */
export async function inspectAgentWorkspace(
  ctx: AgentWorkspaceContext,
  opts: { agent: string; base?: string; workspace?: AgentWorkspace },
): Promise<WorkspaceInspection> {
  assertAgentName(opts.agent);
  // Callers that already hold the worktree list (e.g. `workspace status`) can
  // pass the known workspace to skip a redundant `git worktree list`.
  const ws =
    opts.workspace !== undefined && opts.workspace.agent === opts.agent
      ? opts.workspace
      : (await listAgentWorkspaces(ctx)).find((w) => w.agent === opts.agent);
  if (ws === undefined) {
    throw new AgentWorkspaceError(
      `no workspace for agent ${JSON.stringify(opts.agent)}`,
    );
  }
  const base = opts.base ?? "main";
  const run = ctx.git ?? defaultGitRunner();
  // git status / log run IN the worktree so they reflect THIS agent's tree.
  // Fail-closed: a git error must NOT be read as a clean / up-to-date tree.
  // `--renames` forces rename detection regardless of the repo's
  // `status.renames` config, so a staged `git mv` is always an `R` record (one
  // path) rather than split D/A records — keeps the briefing deterministic.
  const status = await run(
    ["status", "--porcelain", "-z", "--renames"],
    ws.path,
  );
  if (status.exitCode !== 0 || status.timedOut) {
    throw new AgentWorkspaceError(
      `git status failed in ${ws.path}: ${status.stderr.trim()}`,
    );
  }
  const dirtyFiles = parseStatusPorcelain(status.stdout);

  // Resolve the base ref explicitly first, so a genuinely missing base
  // (baseResolved=false) is distinguished from a git error after it resolves.
  // `rev-parse --verify --quiet` exits 1 with NO output for a missing ref;
  // a timeout or any stderr is an unexpected failure → fail closed (throw).
  const baseCheck = await run(
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    ws.path,
  );
  if (baseCheck.timedOut) {
    throw new AgentWorkspaceError(
      `git rev-parse timed out resolving base ${JSON.stringify(base)} in ${ws.path}`,
    );
  }
  const baseResolved = baseCheck.exitCode === 0;
  if (!baseResolved && baseCheck.stderr.trim() !== "") {
    throw new AgentWorkspaceError(
      `git rev-parse failed resolving base ${JSON.stringify(base)} in ${ws.path}: ` +
        baseCheck.stderr.trim(),
    );
  }
  let ahead = 0;
  let behind = 0;
  if (baseResolved) {
    const revs = await run(
      ["rev-list", "--left-right", "--count", `${base}...${ws.branch}`],
      ws.path,
    );
    if (revs.exitCode !== 0 || revs.timedOut) {
      throw new AgentWorkspaceError(
        `git rev-list failed for base ${JSON.stringify(base)} in ${ws.path}: ` +
          revs.stderr.trim(),
      );
    }
    ({ ahead, behind } = parseAheadBehind(revs.stdout));
  }

  const log = await run(["log", "-1", "--format=%H%n%s"], ws.path);
  if (log.timedOut) {
    throw new AgentWorkspaceError(
      `git log timed out in ${ws.path}`,
    );
  }
  const lines = log.stdout.split("\n");
  const lastCommit =
    log.exitCode === 0 && (lines[0] ?? "") !== ""
      ? { sha: lines[0] as string, subject: lines[1] ?? "" }
      : null;
  return {
    agent: ws.agent,
    path: ws.path,
    branch: ws.branch,
    head: ws.head,
    base,
    baseResolved,
    ahead,
    behind,
    dirtyFiles,
    lastCommit,
  };
}
