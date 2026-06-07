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

/** Two agent workspaces, both committing a change to the SAME file (overlap),
 *  plus a dirty edit in alice's tree. Returns the harness root + alice's path. */
async function setup(): Promise<{ harnessRoot: string; alicePath: string }> {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-mcp-rd-"));
  const repoPath = join(harnessRoot, "repo");
  mkdirSync(repoPath, { recursive: true });
  const g = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  g(repoPath, ["init", "-q", "-b", "main"]);
  g(repoPath, ["config", "user.email", "t@e.com"]);
  g(repoPath, ["config", "user.name", "T"]);
  writeFileSync(join(repoPath, "shared.txt"), "base\n");
  g(repoPath, ["add", "."]);
  g(repoPath, ["commit", "-qm", "init"]);

  const wsDir = join(harnessRoot, "repo.agents");
  const repoKey = await canonicalRepoKey({ repoPath });
  const handle = openManagedDb({ dbPath: join(harnessRoot, ".harness", "harness.sqlite") });
  runMigrations(handle.db);
  const repo = new WorkspaceRepository(handle.db);

  for (const agent of ["alice", "bob"]) {
    const ws = await createAgentWorkspace({ repoPath, workspacesDir: wsDir }, { agent, base: "main" });
    // both touch shared.txt and COMMIT (ahead of main) → an overlapping change.
    writeFileSync(join(ws.path, "shared.txt"), `${agent} edit\n`);
    g(ws.path, ["config", "user.email", "t@e.com"]);
    g(ws.path, ["config", "user.name", "T"]);
    g(ws.path, ["commit", "-qam", `${agent} change`]);
    repo.upsert({ agent, repoPath: repoKey, branch: ws.branch, worktreePath: ws.path });
  }
  // an extra uncommitted edit in alice's tree → inspect should see it dirty.
  const alicePath = join(wsDir, "alice");
  writeFileSync(join(alicePath, "wip.txt"), "uncommitted\n");

  handle.close();
  return { harnessRoot, alicePath };
}

function server(harnessRoot: string, allowedProjects: string[] = []): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot,
    config: { ...DEFAULT_MCP_CONFIG, allowedProjects },
    clientName: "t",
    transport: "stdio",
    sessionId: "mcpsess_rd",
  });
}

async function callTool(
  s: HarnessMcpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const r = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as any;
  return r.result.structuredContent;
}

describe("MCP workspace read tools (real git)", () => {
  it("inspect returns a git briefing for a tracked agent", async () => {
    const { harnessRoot, alicePath } = await setup();
    const out = await callTool(server(harnessRoot), "harness.workspace.inspect", {
      repoPath: alicePath,
      agent: "alice",
    });
    expect(out.status).toBe("ok");
    expect(out.data.agent).toBe("alice");
    expect(out.data.ahead).toBe(1); // one commit ahead of main
    expect(out.data.dirtyFiles).toContain("wip.txt");
  });

  it("inspect accepts a subpath and reports an unknown/out-of-scope agent as not found", async () => {
    const { harnessRoot, alicePath } = await setup();
    const out = await callTool(server(harnessRoot), "harness.workspace.inspect", {
      repoPath: join(alicePath, "wip.txt"), // subpath of the tracked worktree
      agent: "nobody",
    });
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/no workspace for agent "nobody"/);
  });

  it("conflicts reports the overlapping pair (alice ⨯ bob on shared.txt)", async () => {
    const { harnessRoot, alicePath } = await setup();
    const out = await callTool(server(harnessRoot), "harness.workspace.conflicts", {
      repoPath: alicePath,
    });
    expect(out.status).toBe("ok");
    expect(out.data.workspaces).toBe(2);
    expect(out.data.conflicts).toHaveLength(1);
    const c = out.data.conflicts[0];
    expect([c.a, c.b].sort()).toEqual(["alice", "bob"]);
    expect(c.files).toContain("shared.txt");
  });

  it("recover returns a briefing with deterministic next steps", async () => {
    const { harnessRoot, alicePath } = await setup();
    const out = await callTool(server(harnessRoot), "harness.workspace.recover", {
      repoPath: alicePath,
      agent: "alice",
    });
    expect(out.status).toBe("ok");
    expect(out.data.inspection.agent).toBe("alice");
    expect(Array.isArray(out.data.nextSteps)).toBe(true);
    // dirty + ahead → there is at least one concrete next step.
    expect(out.data.nextSteps.length).toBeGreaterThan(0);
  });

  it("a restricted client gets the SAME not-tracked error (no scope leak) on all three", async () => {
    const { harnessRoot, alicePath } = await setup();
    // alice's workspace has no linked goal → no project → out of scope for a
    // client restricted to some project. Each tool must reject identically.
    const scoped = server(harnessRoot, ["other-project"]);
    for (const [name, args] of [
      ["harness.workspace.inspect", { repoPath: alicePath, agent: "alice" }],
      ["harness.workspace.conflicts", { repoPath: alicePath }],
      ["harness.workspace.recover", { repoPath: alicePath, agent: "alice" }],
    ] as const) {
      const out = await callTool(scoped, name, args);
      expect(out.status).toBe("error");
      expect(out.summary).toMatch(/is not a tracked workspace worktree/);
    }
  });
});
