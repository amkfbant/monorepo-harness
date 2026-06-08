import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { HarnessMcpServer } from "../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG, type McpConfig } from "../../src/mcp/security/config.js";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { listOperationalKnowledge } from "../../src/core/operational-knowledge.js";

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-ops-write-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
  } finally {
    db.close();
  }
  return root;
}

function server(root: string, config: McpConfig): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_opswrite",
  });
}

const GUARDED: McpConfig = {
  ...DEFAULT_MCP_CONFIG,
  defaultMode: "guarded-mutation",
  allowedOperations: ["ops_knowledge.record", "ops_knowledge.deprecate"],
};

async function callTool(s: HarnessMcpServer, name: string, args: Record<string, unknown>): Promise<any> {
  const r = (await s.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
  })) as any;
  return r.result.structuredContent;
}

function readOps(root: string): ReturnType<typeof listOperationalKnowledge> {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    return listOperationalKnowledge(db, { includeDeprecated: true });
  } finally {
    db.close();
  }
}

describe("harness.ops_knowledge.record / deprecate MCP mutations (issue #57)", () => {
  it("records an operational entry under a guarded-mutation client", async () => {
    const root = freshRoot();
    const out = await callTool(server(root, GUARDED), "harness.ops_knowledge.record", {
      key: "ci-note", title: "CI quirk", body: "spending limit fails fast",
      kind: "ci", tags: ["github"], idempotencyKey: "k1",
    });
    expect(out.status).toBe("operation_started");
    expect(out.data.result.entryId).toBe("ops/ci-note");
    const stored = readOps(root);
    expect(stored.map((e) => e.entryId)).toEqual(["ops/ci-note"]);
    expect(stored[0]?.title).toBe("CI quirk");
  });

  it("denies a read-only client (mutation disabled)", async () => {
    const root = freshRoot();
    const out = await callTool(server(root, DEFAULT_MCP_CONFIG), "harness.ops_knowledge.record", {
      key: "k", title: "x", body: "y", idempotencyKey: "k1",
    });
    expect(out.status).toBe("permission_denied");
    expect(readOps(root)).toHaveLength(0);
  });

  it("denies a guarded client when the operation is not allowlisted", async () => {
    const root = freshRoot();
    const cfg: McpConfig = {
      ...DEFAULT_MCP_CONFIG, defaultMode: "guarded-mutation", allowedOperations: ["backlog.create"],
    };
    const out = await callTool(server(root, cfg), "harness.ops_knowledge.record", {
      key: "k", title: "x", body: "y", idempotencyKey: "k1",
    });
    expect(out.status).toBe("permission_denied");
    expect(out.summary).toMatch(/operation_not_allowlisted/i);
  });

  it("denies a restricted client from creating a portable (global) entry", async () => {
    const root = freshRoot();
    const cfg: McpConfig = { ...GUARDED, allowedProjects: ["demo"] };
    const out = await callTool(server(root, cfg), "harness.ops_knowledge.record", {
      key: "global", title: "x", body: "y", idempotencyKey: "k1", // no projectId → portable
    });
    expect(out.status).toBe("permission_denied");
    expect(readOps(root)).toHaveLength(0);
  });

  it("denies a restricted client from hijacking an existing other-project entry", async () => {
    const root = freshRoot();
    // seed an entry owned by project 'other' via an unrestricted client
    await callTool(server(root, GUARDED), "harness.ops_knowledge.record", {
      key: "shared", title: "Other", body: "owned by other", projectId: "other", idempotencyKey: "seed",
    });
    const cfg: McpConfig = { ...GUARDED, allowedProjects: ["demo"] };
    const out = await callTool(server(root, cfg), "harness.ops_knowledge.record", {
      key: "shared", title: "Hijacked", body: "z", projectId: "demo", idempotencyKey: "k1",
    });
    expect(out.status).toBe("permission_denied");
    // unchanged: still owned by 'other'
    expect(readOps(root).find((e) => e.entryId === "ops/shared")?.projectId).toBe("other");
  });

  it("denies a hijack via a non-canonical key (trailing space normalizes to the same entry)", async () => {
    const root = freshRoot();
    await callTool(server(root, GUARDED), "harness.ops_knowledge.record", {
      key: "shared", title: "Other", body: "owned by other", projectId: "other", idempotencyKey: "seed",
    });
    const cfg: McpConfig = { ...GUARDED, allowedProjects: ["demo"] };
    const out = await callTool(server(root, cfg), "harness.ops_knowledge.record", {
      key: "shared ", title: "Hijacked", body: "z", projectId: "demo", idempotencyKey: "k1",
    });
    expect(out.status).toBe("permission_denied");
    expect(readOps(root).find((e) => e.entryId === "ops/shared")?.projectId).toBe("other");
  });

  it("denies a restricted client from deprecating a portable entry", async () => {
    const root = freshRoot();
    await callTool(server(root, GUARDED), "harness.ops_knowledge.record", {
      key: "global", title: "Global", body: "portable", idempotencyKey: "seed",
    });
    const cfg: McpConfig = { ...GUARDED, allowedProjects: ["demo"] };
    const out = await callTool(server(root, cfg), "harness.ops_knowledge.deprecate", {
      entryId: "ops/global", idempotencyKey: "k1",
    });
    expect(out.status).toBe("permission_denied");
    expect(readOps(root)).toHaveLength(1); // not deprecated
  });

  it("is idempotent on a replayed idempotencyKey", async () => {
    const root = freshRoot();
    const s = server(root, GUARDED);
    const a = await callTool(s, "harness.ops_knowledge.record", {
      key: "k", title: "T", body: "b", idempotencyKey: "same",
    });
    const b = await callTool(s, "harness.ops_knowledge.record", {
      key: "k", title: "T", body: "b", idempotencyKey: "same",
    });
    expect(a.data.operation.operationId).toBe(b.data.operation.operationId);
    expect(b.data.replayed).toBe(true);
    expect(readOps(root)).toHaveLength(1);
  });

  it("rejects invalid input via the strict schema (empty title)", async () => {
    const root = freshRoot();
    const out = await callTool(server(root, GUARDED), "harness.ops_knowledge.record", {
      key: "k", title: "", body: "y", idempotencyKey: "k1",
    });
    expect(out.status).toBe("error");
    expect(readOps(root)).toHaveLength(0);
  });

  it("deprecates an operational entry over MCP", async () => {
    const root = freshRoot();
    const s = server(root, GUARDED);
    await callTool(s, "harness.ops_knowledge.record", {
      key: "old", title: "Old", body: "stale", idempotencyKey: "r1",
    });
    const dep = await callTool(s, "harness.ops_knowledge.deprecate", {
      entryId: "ops/old", idempotencyKey: "d1",
    });
    expect(dep.status).toBe("operation_started");
    expect(dep.data.result.alreadyDeprecated).toBe(false);
    const visible = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      expect(listOperationalKnowledge(visible)).toHaveLength(0); // hidden by default
    } finally {
      visible.close();
    }
  });
});
