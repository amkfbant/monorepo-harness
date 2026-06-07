import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { GoalRepository } from "../../src/goal/repository.js";
import { createAgentWorkspace } from "../../src/workspace/agent-workspace.js";
import { linkAgentWorkspaceToGoal } from "../../src/workspace/workspace-goal-link.js";

function setup(): { harnessRoot: string; repoPath: string; workspacesDir: string } {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-gl-"));
  const repoPath = join(harnessRoot, "repo");
  mkdirSync(repoPath, { recursive: true });
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(repoPath, "r.md"), "x\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  // init the harness DB + a goal.
  const handle = openManagedDb({ dbPath: join(harnessRoot, ".harness", "harness.sqlite") });
  runMigrations(handle.db);
  new GoalRepository(handle.db).createSession({
    goalId: "g1",
    title: "Goal",
    closeConditions: [{ id: "tc", kind: "command", required: true }],
    createdBy: "test",
    createdSource: "cli",
  });
  handle.close();
  return { harnessRoot, repoPath, workspacesDir: join(harnessRoot, "repo.agents") };
}

function goalIdOfWorkspace(harnessRoot: string, agent: string): string | null {
  const handle = openManagedDb({
    dbPath: join(harnessRoot, ".harness", "harness.sqlite"),
    readonly: true,
  });
  try {
    const row = handle.db
      .prepare("SELECT goal_id FROM workspaces WHERE agent = ?")
      .get(agent) as { goal_id: string | null } | undefined;
    return row?.goal_id ?? null;
  } finally {
    handle.close();
  }
}

describe("linkAgentWorkspaceToGoal", () => {
  it("links an agent worktree to the goal and records the workspace row", async () => {
    const { harnessRoot, repoPath, workspacesDir } = setup();
    const ws = await createAgentWorkspace(
      { repoPath, workspacesDir },
      { agent: "alice", base: "main" },
    );
    const res = await linkAgentWorkspaceToGoal({
      repoPath: ws.path, // orchestrate ran in the agent worktree
      goalId: "g1",
      harnessRoot,
    });
    expect(res.linked).toBe(true);
    expect(res.agent).toBe("alice");
    expect(goalIdOfWorkspace(harnessRoot, "alice")).toBe("g1");
  });

  it("links when --repo points at a SUBDIRECTORY inside an agent worktree", async () => {
    const { harnessRoot, repoPath, workspacesDir } = setup();
    const ws = await createAgentWorkspace(
      { repoPath, workspacesDir },
      { agent: "alice", base: "main" },
    );
    const sub = join(ws.path, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const res = await linkAgentWorkspaceToGoal({
      repoPath: sub, // a subdir of the agent worktree, not its root
      goalId: "g1",
      harnessRoot,
    });
    expect(res.linked).toBe(true);
    expect(res.agent).toBe("alice");
    expect(goalIdOfWorkspace(harnessRoot, "alice")).toBe("g1");
  });

  it("does not link when run from the main (non-agent) worktree", async () => {
    const { harnessRoot, repoPath } = setup();
    const res = await linkAgentWorkspaceToGoal({
      repoPath,
      goalId: "g1",
      harnessRoot,
    });
    expect(res.linked).toBe(false);
  });

  it("does not link the MAIN worktree even when it is on an agent/* branch", async () => {
    const { harnessRoot, repoPath } = setup();
    // put the primary checkout itself on an agent/* branch.
    execFileSync("git", ["checkout", "-q", "-b", "agent/main-imposter"], {
      cwd: repoPath,
      stdio: "ignore",
    });
    const res = await linkAgentWorkspaceToGoal({
      repoPath,
      goalId: "g1",
      harnessRoot,
    });
    expect(res.linked).toBe(false);
  });

  it("never throws outside a git repo (best-effort)", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "harness-gl-norepo-"));
    const res = await linkAgentWorkspaceToGoal({
      repoPath: notRepo,
      goalId: "g1",
      harnessRoot: notRepo,
    });
    expect(res.linked).toBe(false);
  });
});
