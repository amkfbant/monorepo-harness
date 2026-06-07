import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentWorkspace } from "../../src/workspace/agent-workspace.js";
import { reconcileWorkspaces } from "../../src/workspace/workspace-reconcile.js";
import type { WorkspaceRecord } from "../../src/db/repositories/workspaces.js";

function setupRepo(): { repoPath: string; workspacesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-reconcile-"));
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(repoPath, "README.md"), "# r\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return { repoPath, workspacesDir: join(root, "agents") };
}

function record(over: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    workspaceId: "ws-x",
    agent: "x",
    repoPath: "/r/.git",
    branch: "agent/x",
    worktreePath: "/x",
    goalId: null,
    objective: null,
    status: "active",
    createdAt: "t",
    updatedAt: "t",
    lastActiveAt: "t",
    ...over,
  };
}

describe("reconcileWorkspaces (real git)", () => {
  let ctx: { repoPath: string; workspacesDir: string };
  beforeEach(() => {
    ctx = setupRepo();
  });

  it("live = agent/* worktrees + adopted (path-present) rows; stale = path gone", async () => {
    // an agent/* worktree (created the harness way).
    await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    // an adopted worktree on a non-agent branch.
    const featurePath = join(ctx.workspacesDir, "..", "feature");
    execFileSync(
      "git",
      ["worktree", "add", "-b", "feature/x", featurePath, "main"],
      { cwd: ctx.repoPath, stdio: "ignore" },
    );

    const rows = [
      // a STALE recorded branch: reconcile must hydrate the LIVE branch instead.
      record({ agent: "dave", branch: "stale-old", worktreePath: featurePath }),
      record({ agent: "ghost", branch: "agent/ghost", worktreePath: "/gone/x" }),
    ];
    const { live, stale } = await reconcileWorkspaces(ctx, rows);

    expect(live.map((w) => w.agent).sort()).toEqual(["alice", "dave"]);
    // the adopted entry is hydrated from git (feature/x), NOT the DB's stale-old.
    expect(live.find((w) => w.agent === "dave")?.branch).toBe("feature/x");
    // the row whose worktree path is gone is stale.
    expect(stale.map((r) => r.agent)).toEqual(["ghost"]);
  });

  it("a present-but-detached adopted worktree is neither live nor (wrongly) stale", async () => {
    const det = join(ctx.workspacesDir, "..", "det");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ctx.repoPath,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["worktree", "add", "--detach", det, head], {
      cwd: ctx.repoPath,
      stdio: "ignore",
    });
    const rows = [record({ agent: "dee", branch: "feature/z", worktreePath: det })];
    const { live, stale } = await reconcileWorkspaces(ctx, rows);
    expect(live.some((w) => w.agent === "dee")).toBe(false); // detached → not usable
    expect(stale.some((r) => r.agent === "dee")).toBe(false); // path present → not stale
  });

  it("hydrates an agent/* worktree that has switched branches from git", async () => {
    const ws = await createAgentWorkspace(ctx, { agent: "alice", base: "main" });
    // switch the worktree to a different branch behind the harness's back.
    execFileSync("git", ["checkout", "-q", "-b", "agent/alice-v2"], {
      cwd: ws.path,
      stdio: "ignore",
    });
    const rows = [record({ agent: "alice", branch: "agent/alice", worktreePath: ws.path })];
    const { live } = await reconcileWorkspaces(ctx, rows);
    expect(live.find((w) => w.agent === "alice-v2")?.branch).toBe(
      "agent/alice-v2",
    );
  });
});
