import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG } from "../../../src/mcp/security/config.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaces.js";
import { GoalRepository } from "../../../src/goal/repository.js";

function freshHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-ws-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  const ws = new WorkspaceRepository(db);
  const goals = new GoalRepository(db);
  goals.createSession({
    goalId: "g1",
    title: "Goal one",
    closeConditions: [{ id: "tc", kind: "command", required: true }],
    createdBy: "test",
    createdSource: "cli",
  });
  const alice = ws.upsert({
    agent: "alice",
    repoPath: "/repo/.git",
    branch: "agent/alice",
    worktreePath: "/repo.agents/alice",
  });
  ws.linkGoal("/repo/.git", "alice", "g1");
  ws.setObjective("/repo/.git", "alice", "ship the thing");
  ws.recordCheckpoint({
    workspaceId: alice.workspaceId,
    note: "wip",
    createdBy: "alice",
    now: "2026-06-07T03:00:00.000Z",
  });
  ws.upsert({
    agent: "bob",
    repoPath: "/repo/.git",
    branch: "agent/bob",
    worktreePath: "/repo.agents/bob",
  });
  db.close();
  return root;
}

function server(root: string): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config: DEFAULT_MCP_CONFIG,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_ws",
  });
}

async function callTool(
  s: HarnessMcpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const response = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as any;
  return response.result.structuredContent;
}

describe("harness.workspace.list MCP tool", () => {
  it("returns the coordination view with goal decision, objective, checkpoint", async () => {
    const s = server(freshHarness());
    const out = await callTool(s, "harness.workspace.list");
    expect(out.status).toBe("ok");
    const byAgent = new Map(
      out.data.workspaces.map((w: any) => [w.agent, w]),
    );
    expect([...byAgent.keys()].sort()).toEqual(["alice", "bob"]);

    const alice = byAgent.get("alice") as any;
    expect(alice.branch).toBe("agent/alice");
    expect(alice.goalId).toBe("g1");
    // a real (live) goal → a non-null convergence decision.
    expect(typeof alice.goalDecision).toBe("string");
    expect(alice.objective).toBe("ship the thing");
    expect(alice.lastCheckpointAt).toBe("2026-06-07T03:00:00.000Z");

    const bob = byAgent.get("bob") as any;
    expect(bob.goalId).toBeNull();
    expect(bob.goalDecision).toBeNull();
    expect(bob.lastCheckpointAt).toBeNull();
  });

  it("filters by agent", async () => {
    const s = server(freshHarness());
    const out = await callTool(s, "harness.workspace.list", { agent: "alice" });
    expect(out.data.workspaces).toHaveLength(1);
    expect(out.data.workspaces[0].agent).toBe("alice");
  });

  it("is a read tool: allowed by default (no allowlist needed)", async () => {
    const s = server(freshHarness());
    const out = await callTool(s, "harness.workspace.list");
    expect(out.status).toBe("ok");
  });
});
