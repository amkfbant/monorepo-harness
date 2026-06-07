import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessMcpServer } from "../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/security/config.js";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaces.js";
import {
  canonicalRepoKey,
  createAgentWorkspace,
} from "../../src/workspace/agent-workspace.js";

async function setup(): Promise<{ harnessRoot: string; worktreePath: string }> {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-mcp-st-"));
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

  const ws = await createAgentWorkspace(
    { repoPath, workspacesDir: join(harnessRoot, "repo.agents") },
    { agent: "alice", base: "main" },
  );
  // a dirty edit in alice's worktree → git-inclusive status should see it.
  writeFileSync(join(ws.path, "wip.txt"), "work\n");

  const repoKey = await canonicalRepoKey({ repoPath });
  const handle = openManagedDb({ dbPath: join(harnessRoot, ".harness", "harness.sqlite") });
  runMigrations(handle.db);
  new WorkspaceRepository(handle.db).upsert({
    agent: "alice",
    repoPath: repoKey,
    branch: ws.branch,
    worktreePath: ws.path,
  });
  handle.close();
  return { harnessRoot, worktreePath: ws.path };
}

function server(harnessRoot: string): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot,
    config: DEFAULT_MCP_CONFIG,
    clientName: "t",
    transport: "stdio",
    sessionId: "mcpsess_st",
  });
}

async function callTool(s: HarnessMcpServer, name: string, args: Record<string, unknown>): Promise<any> {
  const r = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as any;
  return r.result.structuredContent;
}

describe("harness.workspace.status MCP tool (real git)", () => {
  it("returns git-inclusive status for a tracked repo", async () => {
    const { harnessRoot, worktreePath } = await setup();
    const out = await callTool(server(harnessRoot), "harness.workspace.status", {
      repoPath: worktreePath, // a tracked worktree path (from workspace.list)
    });
    expect(out.status).toBe("ok");
    const alice = out.data.workspaces.find((w: any) => w.agent === "alice");
    expect(alice).toBeDefined();
    expect(alice.git.dirtyCount).toBe(1); // saw the uncommitted file
    expect(alice.label).toBe("dirty");
  });

  it("accepts a subpath inside a tracked worktree", async () => {
    const { harnessRoot, worktreePath } = await setup();
    // a file/subdir path under the worktree (Copilot #1): must resolve to the
    // owning tracked worktree, not error.
    const out = await callTool(server(harnessRoot), "harness.workspace.status", {
      repoPath: join(worktreePath, "wip.txt"),
    });
    expect(out.status).toBe("ok");
    expect(
      out.data.workspaces.some((w: any) => w.agent === "alice"),
    ).toBe(true);
  });

  it("errors for a path that is not a tracked repo", async () => {
    const { harnessRoot } = await setup();
    const notRepo = mkdtempSync(join(tmpdir(), "harness-mcp-st-norepo-"));
    const out = await callTool(server(harnessRoot), "harness.workspace.status", {
      repoPath: notRepo,
    });
    expect(out.status).toBe("error");
  });

  it("rejects an out-of-scope path with the SAME error as an unknown path", async () => {
    // codex P2: a restricted client probing an out-of-scope tracked path must
    // get the SAME "not tracked" error as an unknown path — no existence leak.
    const { harnessRoot, worktreePath } = await setup();
    const scoped = new HarnessMcpServer({
      harnessRoot,
      // restrict to a project the alice workspace's (unlinked) goal is NOT in.
      config: { ...DEFAULT_MCP_CONFIG, allowedProjects: ["some-other-project"] },
      clientName: "t",
      transport: "stdio",
      sessionId: "mcpsess_scoped",
    });
    const out = await callTool(scoped, "harness.workspace.status", {
      repoPath: worktreePath,
    });
    expect(out.status).toBe("error");
    expect(out.summary).toContain("not a tracked workspace worktree");
  });
});
