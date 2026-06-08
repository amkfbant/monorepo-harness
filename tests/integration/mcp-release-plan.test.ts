import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessMcpServer } from "../../src/mcp/server.js";
import { DEFAULT_MCP_CONFIG } from "../../src/mcp/security/config.js";

function git(repo: string, args: string[]): void {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if ((r.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function writeSurface(repo: string, o: { schema: number; tools: string[] }): void {
  mkdirSync(join(repo, "src/db"), { recursive: true });
  mkdirSync(join(repo, "src/mcp/registry"), { recursive: true });
  writeFileSync(join(repo, "src/db/schema.ts"), `export const SCHEMA_VERSION = ${o.schema};\n`);
  writeFileSync(
    join(repo, "src/mcp/registry/tool-registry.ts"),
    o.tools.map((t) => `  name: "${t}",`).join("\n") + "\n",
  );
}

function buildRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-mcp-relplan-"));
  git(repo, ["init", "-q"]);
  writeSurface(repo, { schema: 18, tools: ["harness.a"] });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: base"]);
  git(repo, ["tag", "v0.0.1"]);
  writeSurface(repo, { schema: 19, tools: ["harness.a", "harness.b"] });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: add b, schema 19"]);
  git(repo, ["tag", "v0.0.2"]);
  return repo;
}

// The tool always analyzes `harnessRoot` (no client-supplied repo path), so the
// server's harnessRoot IS the hermetic git repo under test.
function server(harnessRoot: string): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot,
    config: DEFAULT_MCP_CONFIG,
    clientName: "t",
    transport: "stdio",
    sessionId: "mcpsess_rel",
  });
}

async function call(s: HarnessMcpServer, args: Record<string, unknown>): Promise<any> {
  const r = (await s.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "harness.release.plan", arguments: args },
  })) as any;
  return r.result.structuredContent;
}

describe("harness.release.plan MCP read tool", () => {
  let repo: string;
  beforeAll(() => {
    repo = buildRepo();
  });

  it("returns the plan for a tag range (analyzes harnessRoot, read-only)", async () => {
    const out = await call(server(repo), { since: "v0.0.1", to: "v0.0.2" });
    expect(out.status).toBe("ok");
    expect(out.data.schema).toMatchObject({ fromVersion: 18, toVersion: 19, noDowngrade: true });
    expect(out.data.mcpTools.added).toEqual(["harness.b"]);
    expect(out.data.mcpTools.removed).toEqual([]);
    expect(out.data.recommendedBump).not.toBe("none");
  });

  it("errors (not throws) on an unresolvable ref", async () => {
    const out = await call(server(repo), { since: "v9.9.9" });
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/cannot resolve/i);
  });

  it("rejects a client-supplied repo arg (strict schema — no arbitrary-repo read)", async () => {
    const out = await call(server(repo), { repo: "/etc", since: "v0.0.1" });
    expect(out.status).toBe("error"); // strict zod rejects the unknown `repo` arg
  });
});
