import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalRepoKey,
  changedFilesForWorkspace,
  createAgentWorkspace,
  inspectAgentWorkspace,
  listAgentWorkspaces,
  removeAgentWorkspace,
  resolveMainWorktree,
} from "../../src/workspace/agent-workspace.js";

function setupRepo(): { repoPath: string; workspacesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-agent-ws-"));
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(repoPath, "README.md"), "# project\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return { repoPath, workspacesDir: join(root, "agents") };
}

describe("agent workspaces (real git)", () => {
  let ctx: { repoPath: string; workspacesDir: string };
  beforeEach(() => {
    ctx = setupRepo();
  });

  it("creates an isolated worktree on the agent/<name> branch", async () => {
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    expect(ws.created).toBe(true);
    expect(ws.agent).toBe("alice");
    expect(ws.branch).toBe("agent/alice");
    // git reports the canonical (realpath) worktree path; assert the suffix so
    // a symlinked tmpdir (/var → /private/var on macOS) does not break it.
    expect(ws.path.endsWith(join("agents", "alice"))).toBe(true);
    // the worktree is a real checkout of the repo.
    expect(existsSync(join(ws.path, "README.md"))).toBe(true);
  });

  it("is idempotent: a second create returns the existing workspace", async () => {
    const first = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    const second = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });

  it("lists only the harness-managed agent worktrees (not the main checkout)", async () => {
    await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    await createAgentWorkspace(ctx, { agent: "bob", base: "main" });
    const list = await listAgentWorkspaces(ctx);
    expect(list.map((w) => w.agent).sort()).toEqual(["alice", "bob"]);
    // the main checkout (branch `main`) is not an agent workspace.
    expect(list.some((w) => w.branch === "main")).toBe(false);
  });

  it("reuses an existing agent/<name> branch instead of failing", async () => {
    // pre-create the branch, then ask for a workspace on it.
    execFileSync("git", ["branch", "agent/carol", "main"], {
      cwd: ctx.repoPath,
      stdio: "ignore",
    });
    const ws = await createAgentWorkspace(ctx, { agent: "carol", base: "main" });
    expect(ws.created).toBe(true);
    expect(ws.branch).toBe("agent/carol");
  });

  it("removes a workspace and its branch", async () => {
    await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    const res = await removeAgentWorkspace(ctx, { agent: "alice" });
    expect(res.removed).toBe(true);
    expect(existsSync(join(ctx.workspacesDir, "alice"))).toBe(false);
    expect(await listAgentWorkspaces(ctx)).toHaveLength(0);
    // the branch is gone too.
    const branches = execFileSync("git", ["branch", "--list", "agent/alice"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    });
    expect(branches.trim()).toBe("");
  });

  it("removing a non-existent agent is a no-op (removed=false)", async () => {
    const res = await removeAgentWorkspace(ctx, { agent: "ghost" });
    expect(res.removed).toBe(false);
  });

  it("inspect: reports a clean workspace deterministically from git", async () => {
    await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    const insp = await inspectAgentWorkspace(ctx, { agent: "alice", base: "main" });
    expect(insp.agent).toBe("alice");
    expect(insp.branch).toBe("agent/alice");
    expect(insp.baseResolved).toBe(true);
    expect(insp.ahead).toBe(0);
    expect(insp.behind).toBe(0);
    expect(insp.dirtyFiles).toEqual([]);
    expect(insp.lastCommit?.subject).toBe("init");
  });

  it("inspect: reflects uncommitted files and commits ahead of base", async () => {
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    const g = (args: string[]) =>
      execFileSync("git", args, { cwd: ws.path, stdio: "ignore" });
    // one new commit on the agent branch → ahead by 1.
    writeFileSync(join(ws.path, "feature.ts"), "export const x = 1;\n");
    g(["add", "feature.ts"]);
    g(["commit", "-qm", "add feature"]);
    // an uncommitted edit → dirty.
    writeFileSync(join(ws.path, "wip.txt"), "in progress\n");

    const insp = await inspectAgentWorkspace(ctx, { agent: "alice", base: "main" });
    expect(insp.ahead).toBe(1);
    expect(insp.behind).toBe(0);
    expect(insp.dirtyFiles).toContain("wip.txt");
    expect(insp.lastCommit?.subject).toBe("add feature");
  });

  it("inspect: reports a renamed file's destination path (real git rename)", async () => {
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    execFileSync("git", ["mv", "README.md", "DOCS.md"], {
      cwd: ws.path,
      stdio: "ignore",
    });
    const insp = await inspectAgentWorkspace(ctx, { agent: "alice", base: "main" });
    expect(insp.dirtyFiles).toContain("DOCS.md");
    expect(insp.dirtyFiles).not.toContain("README.md");
  });

  it("canonicalRepoKey: stable across repo root, a subdirectory, a symlink, and a worktree", async () => {
    const fromRoot = await canonicalRepoKey({ repoPath: ctx.repoPath });
    // a subdirectory of the repo resolves to the same identity.
    const sub = join(ctx.repoPath, "sub", "dir");
    mkdirSync(sub, { recursive: true });
    const fromSub = await canonicalRepoKey({ repoPath: sub });
    expect(fromSub).toBe(fromRoot);
    // a symlink to the repo resolves to the same identity.
    const link = join(mkdtempSync(join(tmpdir(), "harness-link-")), "repo-link");
    symlinkSync(ctx.repoPath, link);
    const fromLink = await canonicalRepoKey({ repoPath: link });
    expect(fromLink).toBe(fromRoot);
    // invoking from one of the repo's own agent worktrees → same identity.
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    const fromWorktree = await canonicalRepoKey({ repoPath: ws.path });
    expect(fromWorktree).toBe(fromRoot);
  });

  it("resolveMainWorktree: returns the main worktree from root, subdir, and a linked worktree", async () => {
    const fromRoot = await resolveMainWorktree({ repoPath: ctx.repoPath });
    expect(fromRoot.endsWith("repo")).toBe(true);
    const sub = join(ctx.repoPath, "s");
    mkdirSync(sub, { recursive: true });
    expect(await resolveMainWorktree({ repoPath: sub })).toBe(fromRoot);
    // from a linked agent worktree, the MAIN worktree is still resolved (so a
    // command run there does not pin git to the soon-to-be-removed worktree).
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    expect(await resolveMainWorktree({ repoPath: ws.path })).toBe(fromRoot);
  });

  it("resolveMainWorktree: throws outside a git repository", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "harness-norepo2-"));
    await expect(
      resolveMainWorktree({ repoPath: notRepo }),
    ).rejects.toThrow(/not a git repository/);
  });

  it("canonicalRepoKey: throws outside a git repository", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "harness-norepo-"));
    await expect(canonicalRepoKey({ repoPath: notRepo })).rejects.toThrow(
      /not a git repository/,
    );
  });

  it("changedFilesForWorkspace: unions committed-ahead and uncommitted files", async () => {
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    const g = (args: string[]) =>
      execFileSync("git", args, { cwd: ws.path, stdio: "ignore" });
    // a committed change (ahead of main) + an uncommitted edit.
    writeFileSync(join(ws.path, "committed.ts"), "export const x = 1;\n");
    g(["add", "committed.ts"]);
    g(["commit", "-qm", "add committed"]);
    writeFileSync(join(ws.path, "wip.ts"), "work\n");

    const files = await changedFilesForWorkspace(ctx, {
      agent: "alice",
      base: "main",
    });
    expect([...files].sort()).toEqual(["committed.ts", "wip.ts"]);
  });

  it("changedFilesForWorkspace: a rename contributes BOTH endpoints (conflict-safe)", async () => {
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    // README.md exists from the repo init; rename it (staged).
    execFileSync("git", ["mv", "README.md", "DOCS.md"], {
      cwd: ws.path,
      stdio: "ignore",
    });
    const files = await changedFilesForWorkspace(ctx, {
      agent: "alice",
      base: "main",
    });
    // an agent editing README.md must still be seen as overlapping → both ends.
    expect([...files].sort()).toEqual(["DOCS.md", "README.md"]);
  });

  it("changedFilesForWorkspace: a missing base degrades to the uncommitted set", async () => {
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    writeFileSync(join(ws.path, "wip.ts"), "work\n");
    const files = await changedFilesForWorkspace(ctx, {
      agent: "alice",
      base: "nonexistent",
    });
    expect(files).toEqual(["wip.ts"]);
  });

  it("inspect: throws for an unknown agent", async () => {
    await expect(
      inspectAgentWorkspace(ctx, { agent: "ghost" }),
    ).rejects.toThrow(/no workspace/);
  });

  it("inspect: baseResolved=false when the base ref does not exist", async () => {
    await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    const insp = await inspectAgentWorkspace(ctx, {
      agent: "alice",
      base: "nonexistent-branch",
    });
    expect(insp.baseResolved).toBe(false);
    expect(insp.ahead).toBe(0);
    expect(insp.behind).toBe(0);
  });

  it("refuses to remove a dirty workspace without force, but succeeds with force", async () => {
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    writeFileSync(join(ws.path, "uncommitted.txt"), "work in progress\n");
    await expect(removeAgentWorkspace(ctx, { agent: "alice" })).rejects.toThrow(
      /force/,
    );
    const res = await removeAgentWorkspace(ctx, { agent: "alice", force: true });
    expect(res.removed).toBe(true);
  });
});
