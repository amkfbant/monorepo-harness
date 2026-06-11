import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG, type McpConfig } from "../../../src/mcp/security/config.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaces.js";
import { HitchRepository } from "../../../src/hitch/repository.js";

function freshHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-ws-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  const ws = new WorkspaceRepository(db);
  const goals = new HitchRepository(db);
  goals.createSession({
    hitchId: "g1",
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
  ws.linkHitch("/repo/.git", "alice", "g1");
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
    expect(alice.hitchId).toBe("g1");
    // a real (live) goal → a non-null convergence decision.
    expect(typeof alice.hitchDecision).toBe("string");
    expect(alice.objective).toBe("ship the thing");
    expect(alice.lastCheckpointAt).toBe("2026-06-07T03:00:00.000Z");

    const bob = byAgent.get("bob") as any;
    expect(bob.hitchId).toBeNull();
    expect(bob.hitchDecision).toBeNull();
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

  function mutationServer(root: string, ops: string[], projects: string[] = []): HarnessMcpServer {
    const config: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: projects,
      allowedOperations: ops,
    };
    return new HarnessMcpServer({
      harnessRoot: root,
      config,
      clientName: "m",
      transport: "stdio",
      sessionId: "mcpsess_mut",
    });
  }

  it("checkpoint: records an advisory checkpoint (guarded-mutation + allowlisted)", async () => {
    const s = mutationServer(freshHarness(), ["workspace.checkpoint"]);
    const out = await callTool(s, "harness.workspace.checkpoint", {
      repoPath: "/repo/.git",
      agent: "alice",
      note: "saved via mcp",
      objective: "ship",
      idempotencyKey: "k1",
    });
    expect(out.status).toBe("operation_started");
    expect(out.data.result.note).toBe("saved via mcp");
  });

  it("checkpoint: refreshes the heartbeat even for a note-only checkpoint", async () => {
    const root = freshHarness();
    // backdate alice's heartbeat.
    {
      const db = openDb(join(root, ".harness", "harness.sqlite"));
      runMigrations(db);
      db.prepare("UPDATE workspaces SET last_active_at = '2026-01-01T00:00:00.000Z' WHERE agent = 'alice'").run();
      db.close();
    }
    const s = mutationServer(root, ["workspace.checkpoint"]);
    const out = await callTool(s, "harness.workspace.checkpoint", {
      repoPath: "/repo/.git",
      agent: "alice",
      note: "just a note",
      idempotencyKey: "hb",
    });
    expect(out.status).toBe("operation_started");
    // the standard mutation shape includes operation provenance + a resource link.
    expect(out.data.operation.operationType).toBe("workspace.checkpoint");
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    const row = db.prepare("SELECT last_active_at FROM workspaces WHERE agent = 'alice'").get() as { last_active_at: string };
    db.close();
    expect(row.last_active_at).not.toBe("2026-01-01T00:00:00.000Z"); // refreshed
  });

  it("checkpoint: replays the same idempotency key", async () => {
    const s = mutationServer(freshHarness(), ["workspace.checkpoint"]);
    const args = { repoPath: "/repo/.git", agent: "alice", idempotencyKey: "dup" };
    const first = await callTool(s, "harness.workspace.checkpoint", args);
    const second = await callTool(s, "harness.workspace.checkpoint", args);
    expect(first.status).toBe("operation_started");
    expect(second.data.replayed).toBe(true);
  });

  it("checkpoint: denied when workspace.checkpoint is not allowlisted", async () => {
    const s = mutationServer(freshHarness(), []);
    const out = await callTool(s, "harness.workspace.checkpoint", {
      repoPath: "/repo/.git",
      agent: "alice",
      idempotencyKey: "k2",
    });
    expect(out.status).toBe("permission_denied");
  });

  it("checkpoint: errors for an unknown agent", async () => {
    const s = mutationServer(freshHarness(), ["workspace.checkpoint"]);
    const out = await callTool(s, "harness.workspace.checkpoint", {
      repoPath: "/repo/.git",
      agent: "ghost",
      idempotencyKey: "k3",
    });
    expect(out.status).toBe("error");
  });

  function scopedHarness(aliceGoalProject: string): string {
    const root = mkdtempSync(join(tmpdir(), "harness-mcp-cpscope-"));
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    const ws = new WorkspaceRepository(db);
    const goals = new HitchRepository(db);
    for (const [hitchId, projectId] of [
      ["g-alice", aliceGoalProject],
      ["g-demo", "demo"],
    ] as const) {
      goals.createSession({
        hitchId,
        title: hitchId,
        projectId,
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "t",
        createdSource: "cli",
      });
    }
    ws.upsert({ agent: "alice", repoPath: "/r/.git", branch: "agent/alice", worktreePath: "/r.agents/alice" });
    ws.linkHitch("/r/.git", "alice", "g-alice");
    db.close();
    return root;
  }

  it("checkpoint scoping: denies an out-of-scope workspace even with an allowed hitchId (no bypass)", async () => {
    // alice's workspace is in project "other"; the client is restricted to "demo".
    const s = mutationServer(scopedHarness("other"), ["workspace.checkpoint"], ["demo"]);
    const out = await callTool(s, "harness.workspace.checkpoint", {
      repoPath: "/r/.git",
      agent: "alice",
      hitchId: "g-demo", // an allowed goal — must NOT unlock the out-of-scope workspace
      idempotencyKey: "x",
    });
    expect(out.status).toBe("permission_denied");
  });

  it("checkpoint scoping: allows a workspace whose goal is in an allowed project", async () => {
    const s = mutationServer(scopedHarness("demo"), ["workspace.checkpoint"], ["demo"]);
    const out = await callTool(s, "harness.workspace.checkpoint", {
      repoPath: "/r/.git",
      agent: "alice",
      idempotencyKey: "y",
    });
    expect(out.status).toBe("operation_started");
  });

  it("scopes results to allowedProjects (omits cross-project + unlinked rows)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-mcp-ws-scope-"));
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    const ws = new WorkspaceRepository(db);
    const goals = new HitchRepository(db);
    for (const [hitchId, projectId] of [
      ["g-demo", "demo"],
      ["g-other", "other"],
    ] as const) {
      goals.createSession({
        hitchId,
        title: hitchId,
        projectId,
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "cli",
      });
    }
    ws.upsert({ agent: "alice", repoPath: "/r/.git", branch: "agent/alice", worktreePath: "/r.agents/alice" });
    ws.linkHitch("/r/.git", "alice", "g-demo");
    ws.upsert({ agent: "bob", repoPath: "/r/.git", branch: "agent/bob", worktreePath: "/r.agents/bob" });
    ws.linkHitch("/r/.git", "bob", "g-other");
    ws.upsert({ agent: "carol", repoPath: "/r/.git", branch: "agent/carol", worktreePath: "/r.agents/carol" });
    db.close();

    const s = new HarnessMcpServer({
      harnessRoot: root,
      config: { ...DEFAULT_MCP_CONFIG, allowedProjects: ["demo"] },
      clientName: "scoped",
      transport: "stdio",
      sessionId: "mcpsess_scope",
    });
    const out = await callTool(s, "harness.workspace.list");
    // only the demo-linked workspace; "other" and the unlinked "carol" are hidden.
    expect(out.data.workspaces.map((w: any) => w.agent)).toEqual(["alice"]);
  });
});
