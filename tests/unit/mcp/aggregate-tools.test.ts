import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG, type McpConfig } from "../../../src/mcp/security/config.js";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";

interface ToolContent<T> {
  status: string;
  data: T;
}

interface MetricsToolData {
  totalRuns: number;
  hitch: {
    totalSessions: number;
    byStatus: Record<string, number>;
    findingsBySeverity: Record<string, number>;
  };
  mcpConfirmations: {
    total: number;
    byStatus: Record<string, number>;
    confirmationRate: number | null;
  };
}

function insertRun(
  db: Database.Database,
  runId: string,
  projectId: string,
  status: string,
): void {
  db.prepare(
    `INSERT INTO runs (
       run_id, repo_id, project_id, domain, workflow, base_branch, status,
       started_at, source_meta_sha256, updated_at
     )
     VALUES (?, 'demo', ?, 'apps/web', 'domain-coding', 'main', ?,
       '2026-06-10T00:00:00.000Z', 'x', '2026-06-10T00:00:00.000Z')`,
  ).run(runId, projectId, status);
}

function insertHitchSession(
  db: Database.Database,
  input: {
    hitchId: string;
    projectId: string;
    domain: string;
    status: string;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO hitch_sessions (
       hitch_id, title, status, project_id, repo_id, domain, scope_json,
       close_conditions_json, policy_json, max_iterations, max_review_cycles,
       max_reruns, max_total_new_findings, created_by, created_source,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, 'demo', ?, '{}', '[]', '{}', 3, 3, 2, 12,
       'test', 'cli', ?, ?)`,
  ).run(
    input.hitchId,
    input.hitchId,
    input.status,
    input.projectId,
    input.domain,
    input.createdAt,
    input.createdAt,
  );
}

function insertFinding(
  db: Database.Database,
  hitchId: string,
  findingId: string,
): void {
  db.prepare(
    `INSERT INTO hitch_findings (
       finding_id, hitch_id, stable_key, source, severity, category,
       scope_status, lifecycle_status, summary, first_seen_at, last_seen_at,
       reopen_count
     )
     VALUES (?, ?, ?, 'review', 'P1', 'correctness', 'in_scope', 'fixed', ?,
       '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z', 0)`,
  ).run(findingId, hitchId, findingId, findingId);
}

function insertMcpConfirmation(
  db: Database.Database,
  confirmationId: string,
  status: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO mcp_confirmation_requests (
       confirmation_id, client_name, actor, tool_name, operation_type,
       input_json, preview_json, permission_snapshot_json, status,
       created_at, expires_at
     )
     VALUES (?, 'client', 'actor', 'harness.pr.create', 'pr.create',
       '{}', '{}', '{}', ?, ?, '2026-07-01T00:00:00.000Z')`,
  ).run(confirmationId, status, createdAt);
}

function setup(): string {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-mcp-agg-unit-"));
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  const handle = openManagedDb({
    dbPath: join(harnessRoot, ".harness", "harness.sqlite"),
  });
  try {
    runMigrations(handle.db);
    insertRun(handle.db, "run-demo", "demo", "approved");
    insertRun(handle.db, "run-other", "other", "approved");
    insertHitchSession(handle.db, {
      hitchId: "hitch-demo",
      projectId: "demo",
      domain: "apps/web",
      status: "open",
      createdAt: "2026-06-10T00:00:00.000Z",
    });
    insertHitchSession(handle.db, {
      hitchId: "hitch-other",
      projectId: "other",
      domain: "apps/web",
      status: "closed",
      createdAt: "2026-06-10T00:00:00.000Z",
    });
    insertHitchSession(handle.db, {
      hitchId: "hitch-old",
      projectId: "demo",
      domain: "apps/web",
      status: "closed",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    insertFinding(handle.db, "hitch-demo", "finding-demo");
    insertMcpConfirmation(
      handle.db,
      "confirm-new",
      "confirmed",
      "2026-06-10T00:00:00.000Z",
    );
    insertMcpConfirmation(
      handle.db,
      "confirm-old",
      "expired",
      "2026-05-01T00:00:00.000Z",
    );
  } finally {
    handle.close();
  }
  return harnessRoot;
}

function server(root: string, config: McpConfig = DEFAULT_MCP_CONFIG): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_metrics_unit",
  });
}

async function callMetrics(
  s: HarnessMcpServer,
  args: Record<string, unknown>,
): Promise<ToolContent<MetricsToolData>> {
  const response = await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "harness.metrics", arguments: args },
  });
  const result = response as {
    result: { structuredContent: ToolContent<MetricsToolData> };
  };
  return result.result.structuredContent;
}

describe("harness.metrics aggregate tool", () => {
  it("returns run metrics plus hitch and MCP confirmation summaries", async () => {
    const out = await callMetrics(server(setup()), {
      projectId: "demo",
      domain: "apps/web",
      sinceHours: 24 * 10,
    });

    expect(out.status).toBe("ok");
    expect(out.data.totalRuns).toBe(1);
    expect(out.data.hitch.totalSessions).toBe(1);
    expect(out.data.hitch.byStatus).toEqual({ open: 1 });
    expect(out.data.hitch.findingsBySeverity).toEqual({ P1: 1 });
    expect(out.data.mcpConfirmations.total).toBe(1);
    expect(out.data.mcpConfirmations.byStatus).toEqual({ confirmed: 1 });
    expect(out.data.mcpConfirmations.confirmationRate).toBe(1);
  });

  it("keeps project-restricted default scoping for hitch metrics", async () => {
    const out = await callMetrics(
      server(setup(), { ...DEFAULT_MCP_CONFIG, allowedProjects: ["demo"] }),
      {},
    );

    expect(out.status).toBe("ok");
    expect(out.data.totalRuns).toBe(1);
    expect(out.data.hitch.totalSessions).toBe(2);
    expect(out.data.hitch.byStatus).toEqual({ closed: 1, open: 1 });
  });
});
