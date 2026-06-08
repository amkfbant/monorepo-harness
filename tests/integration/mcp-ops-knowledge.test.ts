import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessMcpServer } from "../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/security/config.js";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { recordOperationalKnowledge } from "../../src/core/operational-knowledge.js";

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-ops-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const handle = openManagedDb({ dbPath: join(root, ".harness", "harness.sqlite") });
  runMigrations(handle.db);
  recordOperationalKnowledge(handle.db, {
    key: "portable", title: "Portable tool note",
    body: "ext4 only, not /mnt", kind: "environment", tags: ["wsl"], actor: "op",
  });
  recordOperationalKnowledge(handle.db, {
    key: "demo-ci", title: "Demo CI note",
    body: "spending limit fails fast", kind: "ci", projectId: "demo", actor: "op",
  });
  recordOperationalKnowledge(handle.db, {
    key: "other-ci", title: "Other CI note",
    body: "secret detail", kind: "ci", projectId: "other", actor: "op",
  });
  recordOperationalKnowledge(handle.db, {
    key: "stale", title: "Stale note", body: "old", actor: "op",
  });
  handle.close();
  return root;
}

function server(root: string, allowedProjects: string[] = []): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config: { ...DEFAULT_MCP_CONFIG, allowedProjects },
    clientName: "t",
    transport: "stdio",
    sessionId: "mcpsess_ops",
  });
}

async function call(s: HarnessMcpServer, name: string, args: Record<string, unknown>): Promise<any> {
  const r = (await s.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args },
  })) as any;
  return r.result.structuredContent;
}

describe("harness.ops_knowledge MCP read tools (issue #57)", () => {
  it("search lists operational entries for an unrestricted client", async () => {
    const out = await call(server(setup()), "harness.ops_knowledge.search", {});
    expect(out.status).toBe("ok");
    const ids = out.data.entries.map((e: any) => e.entryId).sort();
    expect(ids).toEqual(["ops/demo-ci", "ops/other-ci", "ops/portable", "ops/stale"]);
  });

  it("search filters by query text", async () => {
    const out = await call(server(setup()), "harness.ops_knowledge.search", { query: "spending" });
    expect(out.data.entries.map((e: any) => e.entryId)).toEqual(["ops/demo-ci"]);
  });

  it("a restricted client sees only allowed-project + portable entries", async () => {
    const out = await call(server(setup(), ["demo"]), "harness.ops_knowledge.search", {});
    const ids = out.data.entries.map((e: any) => e.entryId).sort();
    expect(ids).toEqual(["ops/demo-ci", "ops/portable", "ops/stale"]);
    expect(ids).not.toContain("ops/other-ci");
  });

  it("search rejects an explicit projectId outside the allowlist", async () => {
    const out = await call(server(setup(), ["demo"]), "harness.ops_knowledge.search", {
      projectId: "other",
    });
    expect(out.status).toBe("permission_denied");
  });

  it("get returns the body only when requested and caps it", async () => {
    const s = server(setup());
    const omitted = await call(s, "harness.ops_knowledge.get", { entryId: "ops/portable" });
    expect(omitted.status).toBe("ok");
    expect(omitted.data.entry.body).toBeUndefined();
    expect(omitted.data.entry.bodyPreview).toMatchObject({ omitted: true });

    const full = await call(s, "harness.ops_knowledge.get", {
      entryId: "ops/portable", includeBody: true,
    });
    expect(full.data.entry.body).toContain("ext4 only");
    expect(full.data.entry.tags).toEqual(["wsl"]);
  });

  it("get returns a portable entry to a restricted client (search/get parity)", async () => {
    const out = await call(server(setup(), ["demo"]), "harness.ops_knowledge.get", {
      entryId: "ops/portable", includeBody: true,
    });
    expect(out.status).toBe("ok");
    expect(out.data.entry.body).toContain("ext4 only");
  });

  it("get denies an operational entry in a disallowed project", async () => {
    const out = await call(server(setup(), ["demo"]), "harness.ops_knowledge.get", {
      entryId: "ops/other-ci", includeBody: true,
    });
    expect(out.status).toBe("permission_denied");
  });

  it("get returns not-found for a missing or codebase id", async () => {
    const s = server(setup());
    const missing = await call(s, "harness.ops_knowledge.get", { entryId: "ops/nope" });
    expect(missing.status).toBe("error");
    const codebase = await call(s, "harness.ops_knowledge.get", {
      entryId: "docs/knowledge/x.md",
    });
    expect(codebase.status).toBe("error");
  });
});
