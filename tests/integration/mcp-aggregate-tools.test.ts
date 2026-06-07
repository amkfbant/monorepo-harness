import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { HarnessMcpServer } from "../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/security/config.js";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";

function insertRun(db: Database.Database, runId: string, projectId: string, status: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, project_id, domain, workflow,
       base_branch, status, started_at, source_meta_sha256, updated_at)
     VALUES (?, 'demo', ?, 'apps/web', 'domain-coding', 'main', ?,
       '2026-05-21T00:00:00Z', 'x', '2026-05-22T00:00:00Z')`,
  ).run(runId, projectId, status);
}

function setup(): string {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-mcp-agg-"));
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  const handle = openManagedDb({ dbPath: join(harnessRoot, ".harness", "harness.sqlite") });
  runMigrations(handle.db);
  insertRun(handle.db, "run-a", "demo", "approved");
  insertRun(handle.db, "run-b", "demo", "needs_review");
  insertRun(handle.db, "run-c", "other", "needs_review");
  insertRun(handle.db, "run-d", "demo", "failed-policy-violation");
  insertRun(handle.db, "run-e", "demo", "changes_requested");
  handle.close();
  return harnessRoot;
}

function server(harnessRoot: string, allowedProjects: string[] = []): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot,
    config: { ...DEFAULT_MCP_CONFIG, allowedProjects },
    clientName: "t",
    transport: "stdio",
    sessionId: "mcpsess_agg",
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

describe("harness.inbox / harness.metrics MCP tools", () => {
  it("metrics aggregates all runs for an unrestricted client", async () => {
    const out = await callTool(server(setup()), "harness.metrics", {});
    expect(out.status).toBe("ok");
    expect(out.data.totalRuns).toBe(5);
    expect(out.data.needsReview).toBe(2);
    expect(out.data.failed).toBe(1);
  });

  it("inbox lists attention items for an unrestricted client", async () => {
    const out = await callTool(server(setup()), "harness.inbox", {});
    expect(out.status).toBe("ok");
    expect(out.data.needsReview).toHaveLength(2); // demo + other
    expect(out.data.changesRequested).toHaveLength(1);
    expect(out.data.failed).toHaveLength(1);
  });

  it("a single-project restricted client is scoped to its project by default", async () => {
    const scoped = server(setup(), ["demo"]);
    const metrics = await callTool(scoped, "harness.metrics", {});
    expect(metrics.status).toBe("ok");
    expect(metrics.data.totalRuns).toBe(4); // demo only, not 'other'
    const inbox = await callTool(scoped, "harness.inbox", {});
    expect(inbox.data.needsReview).toHaveLength(1); // only demo's run-b
  });

  it("rejects a projectId outside the client's allowed set", async () => {
    const out = await callTool(server(setup(), ["demo"]), "harness.metrics", {
      projectId: "other",
    });
    expect(out.status).toBe("permission_denied");
    expect(out.summary).toMatch(/project_not_allowed/i);
  });

  it("requires an explicit project when several are allowed", async () => {
    const out = await callTool(server(setup(), ["demo", "other"]), "harness.inbox", {});
    expect(out.status).toBe("permission_denied");
    expect(out.summary).toMatch(/project/i);
  });

  it("filters metrics by an explicit allowed projectId", async () => {
    const out = await callTool(server(setup(), ["demo", "other"]), "harness.metrics", {
      projectId: "other",
    });
    expect(out.status).toBe("ok");
    expect(out.data.totalRuns).toBe(1); // only 'other'
  });
});
