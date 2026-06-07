import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentWorkspace,
  listAgentWorkspaces,
  removeAgentWorkspace,
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
