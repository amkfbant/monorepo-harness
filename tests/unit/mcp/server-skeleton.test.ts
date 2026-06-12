import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { HarnessMcpServer, MCP_PROTOCOL_VERSION } from "../../../src/mcp/server.js";
import { harnessVersion } from "../../../src/config/version.js";
import { serveMcpStdio } from "../../../src/mcp/transports/stdio.js";
import { DEFAULT_MCP_CONFIG, type McpConfig } from "../../../src/mcp/security/config.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-mcp-server-"));
}

function server(config = DEFAULT_MCP_CONFIG, root = tempRoot()): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_test",
  });
}

describe("HarnessMcpServer skeleton", () => {
  it("responds to initialize and advertises tools/resources/prompts", async () => {
    const root = tempRoot();
    const s = server(DEFAULT_MCP_CONFIG, root);
    const init = await s.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex", version: "0" } },
    });
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
      },
    });
    // serverInfo.version reflects the package version (read at runtime), never
    // the previously hard-coded — and stale — "0.1.0" literal.
    const reportedVersion = (init as any).result.serverInfo.version as string;
    expect(reportedVersion).toBe(harnessVersion());
    expect(reportedVersion).toMatch(/^\d+\.\d+\.\d+/);

    const tools = await s.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(JSON.stringify(tools)).toContain("harness.run.dry_run");
    const toolNames = ((tools as any).result.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(toolNames).not.toContain("harness.operation.confirm");
    expect(toolNames).not.toContain("harness.operation.reject");
    // (#83) the bounded hitch-loop driver is exposed as a mutation tool
    expect(toolNames).toContain("harness.hitch.orchestrate");
    // (SP-0) goal.* tools were renamed to hitch.*
    expect(toolNames).toContain("harness.hitch.start");
    expect(toolNames).not.toContain("harness.goal.start");

    const resources = await s.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/templates/list",
    });
    expect(JSON.stringify(resources)).toContain("harness://run/{runId}");
    expect(JSON.stringify(resources)).toContain("harness://hitch/{hitchId}");

    const prompts = await s.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "prompts/list",
    });
    expect(JSON.stringify(prompts)).toContain("harness.prompt.review_run");
    expect(JSON.stringify(prompts)).toContain("harness.prompt.drive_hitch_convergence");
  });

  it("denies mutation by default and returns guarded confirmation_required as non-error", async () => {
    const root = tempRoot();
    const s = server(DEFAULT_MCP_CONFIG, root);
    await s.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex" } },
    });

    const denied = await s.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "harness.run.start",
        arguments: {
          projectId: "demo",
          domain: "apps/web",
          goal: "x",
          idempotencyKey: "k",
        },
      },
    });
    expect(denied).toMatchObject({
      result: {
        structuredContent: {
          status: "permission_denied",
        },
        isError: true,
      },
    });

    // (#83) the hitch-loop driver is a mutation: denied by default permissions
    const orchestrateDenied = await s.handleMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "harness.hitch.orchestrate",
        arguments: { hitchId: "hitch-1", idempotencyKey: "k" },
      },
    });
    expect(orchestrateDenied).toMatchObject({
      result: {
        structuredContent: { status: "permission_denied" },
        isError: true,
      },
    });

    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs
         (run_id, repo_id, project_id, repo_path, domain, workflow,
          base_branch, run_branch, status, safety_status, started_at,
          source_meta_sha256, updated_at, meta_json)
       VALUES
         ('run-1', 'demo-repo', 'demo', '/tmp/demo', 'apps/web',
          'domain-coding', 'main', 'harness/run-1', 'approved', 'clean',
          '2026-05-25T00:00:00Z', 'sha', '2026-05-25T00:00:00Z', '{}')`,
    ).run();
    db.close();

    const guarded = server(
      { ...DEFAULT_MCP_CONFIG, defaultMode: "guarded-mutation" },
      root,
    );
    await guarded.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: { clientInfo: { name: "codex" } },
    });
    const confirmation = await guarded.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "harness.pr.create",
        arguments: {
          runId: "run-1",
          idempotencyKey: "k",
        },
      },
    });
    expect(confirmation).toMatchObject({
      result: {
        structuredContent: {
          status: "confirmation_required",
        },
        isError: false,
      },
    });
  });

  it("does not let initialize clientInfo spoof the permission client name", async () => {
    const root = tempRoot();
    const config: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "read-only",
      clients: [{ id: "codex-local", names: ["codex"], mode: "guarded-mutation" }],
      allowedProjects: ["demo"],
      allowedOperations: ["backlog.create"],
    };
    const spoofed = new HarnessMcpServer({
      harnessRoot: root,
      config,
      transport: "stdio",
      sessionId: "mcpsess_spoofed",
    });
    await spoofed.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codex", version: "spoof" } },
    });
    const denied = await spoofed.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "harness.backlog.create",
        arguments: {
          projectId: "demo",
          domain: "apps/web",
          title: "Spoof",
          goal: "Should not run",
          idempotencyKey: "spoofed",
        },
      },
    }) as any;
    expect(denied.result.structuredContent.status).toBe("permission_denied");

    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    db.prepare(
      `INSERT INTO projects
         (project_id, repo_id, profile_path, profile_version, repo_path,
          base_branch, package_manager, created_at, updated_at)
       VALUES ('demo', 'demo-repo', 'projects/demo.yaml', 1, '/tmp/demo',
               'main', 'npm', '2026-05-25T00:00:00Z',
               '2026-05-25T00:00:00Z')`,
    ).run();
    db.close();

    const launched = new HarnessMcpServer({
      harnessRoot: root,
      config,
      clientName: "codex",
      transport: "stdio",
      sessionId: "mcpsess_launched",
    });
    await launched.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { clientInfo: { name: "untrusted-client", version: "1" } },
    });
    const allowed = await launched.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "harness.backlog.create",
        arguments: {
          projectId: "demo",
          domain: "apps/web",
          title: "Allowed",
          goal: "Should run",
          idempotencyKey: "launched-codex",
        },
      },
    }) as any;
    expect(allowed.result.structuredContent.status).toBe("operation_started");
    const auditDb = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      const session = auditDb
        .prepare(
          `SELECT client_name, reported_client_name
             FROM mcp_sessions
            WHERE session_id = 'mcpsess_launched'`,
        )
        .get() as { client_name: string; reported_client_name: string };
      expect(session).toEqual({
        client_name: "codex",
        reported_client_name: "untrusted-client",
      });
    } finally {
      auditDb.close();
    }
  });

  it("returns structured argument errors", async () => {
    const invalid = await server().handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "harness.run.dry_run",
        arguments: { projectId: "demo" },
      },
    });
    expect(invalid).toMatchObject({
      result: {
        structuredContent: {
          status: "error",
        },
        isError: true,
      },
    });
    expect(JSON.stringify(invalid)).toContain("domain");
    expect(JSON.stringify(invalid)).toContain("goal");
  });

  it("rejects id-less request methods without dispatching them", async () => {
    const s = server();
    const requestWithoutId = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "harness.run.dry_run",
        arguments: {
          projectId: "demo",
          domain: "apps/web",
          goal: "x",
        },
      },
    };
    for (let i = 0; i < 60; i += 1) {
      await expect(s.handleMessage(requestWithoutId)).resolves.toMatchObject({
        id: null,
        error: { code: -32600 },
      });
    }
    const validRequest = (await s.handleMessage({
      ...requestWithoutId,
      id: 1,
    })) as any;
    expect(validRequest).toMatchObject({
      result: {
        structuredContent: {
          status: "error",
        },
        isError: true,
      },
    });
    expect(JSON.stringify(validRequest)).not.toContain("rate limit");
  });

  it("ignores unknown notifications without returning JSON-RPC errors", async () => {
    await expect(
      server().handleMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      }),
    ).resolves.toBeUndefined();
  });

  it("serves newline-delimited JSON-RPC over stdio streams", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    error.on("data", (chunk) => errors.push(Buffer.from(chunk)));

    const serving = serveMcpStdio({
      server: server(),
      input,
      output,
      error,
    });
    input.write("{not-json}\n");
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "stdio-test" } },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      })}\n`,
    );
    input.end();
    await serving;

    const responses = Buffer.concat(chunks)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as any);
    expect(responses[0]).toMatchObject({
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(responses[1]).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "monorepo-harness" } },
    });
    expect(responses[2].result.tools.some((t: any) => t.name === "harness.db.status")).toBe(
      true,
    );
    expect(Buffer.concat(errors).toString("utf8")).toContain("parse error");
  });
});
