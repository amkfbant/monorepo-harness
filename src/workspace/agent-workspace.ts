import { join } from "node:path";
import { gitCli, type GitResult } from "../git/git-cli.js";

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

async function branchExists(
  ctx: AgentWorkspaceContext,
  branch: string,
): Promise<boolean> {
  const r = await git(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.exitCode === 0;
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
  opts: { agent: string; force?: boolean; keepBranch?: boolean },
): Promise<{ removed: boolean }> {
  assertAgentName(opts.agent);
  const existing = (await listAgentWorkspaces(ctx)).find(
    (w) => w.agent === opts.agent,
  );
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
  opts: { agent: string; base?: string },
): Promise<WorkspaceInspection> {
  assertAgentName(opts.agent);
  const ws = (await listAgentWorkspaces(ctx)).find(
    (w) => w.agent === opts.agent,
  );
  if (ws === undefined) {
    throw new AgentWorkspaceError(
      `no workspace for agent ${JSON.stringify(opts.agent)}`,
    );
  }
  const base = opts.base ?? "main";
  const run = ctx.git ?? defaultGitRunner();
  // git status / log run IN the worktree so they reflect THIS agent's tree.
  // Fail-closed: a git error must NOT be read as a clean / up-to-date tree.
  const status = await run(["status", "--porcelain", "-z"], ws.path);
  if (status.exitCode !== 0 || status.timedOut) {
    throw new AgentWorkspaceError(
      `git status failed in ${ws.path}: ${status.stderr.trim()}`,
    );
  }
  const dirtyFiles = parseStatusPorcelain(status.stdout);

  // Resolve the base ref explicitly first, so a genuinely missing base
  // (baseResolved=false) is distinguished from a git error after it resolves.
  const baseCheck = await run(
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    ws.path,
  );
  const baseResolved = baseCheck.exitCode === 0;
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
