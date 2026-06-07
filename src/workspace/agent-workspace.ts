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
