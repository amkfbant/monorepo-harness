import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function git(repo: string, args: string[]): void {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

function writeSurface(
  repo: string,
  opts: { schema: number; tools: string[]; commands: string[] },
): void {
  mkdirSync(join(repo, "src/db"), { recursive: true });
  mkdirSync(join(repo, "src/mcp/registry"), { recursive: true });
  mkdirSync(join(repo, "src/cli"), { recursive: true });
  writeFileSync(join(repo, "src/db/schema.ts"), `export const SCHEMA_VERSION = ${opts.schema};\n`);
  writeFileSync(
    join(repo, "src/mcp/registry/tool-registry.ts"),
    opts.tools.map((t) => `  name: "${t}",`).join("\n") + "\n",
  );
  writeFileSync(
    join(repo, "src/cli/run.ts"),
    opts.commands.map((c) => `program.command("${c}");`).join("\n") + "\n",
  );
}

/** A hermetic git repo with tagged history — independent of the dev repo. */
function buildRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-relplan-"));
  git(repo, ["init", "-q"]);
  writeSurface(repo, { schema: 18, tools: ["harness.a"], commands: ["x"] });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "chore: base"]);
  git(repo, ["tag", "v0.0.1"]);
  writeSurface(repo, { schema: 19, tools: ["harness.a", "harness.b"], commands: ["x", "y"] });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: add b + y, schema 19"]);
  git(repo, ["tag", "v0.0.2"]);
  // v0.0.3 REMOVES a tool (an undeclared breaking change)
  writeSurface(repo, { schema: 19, tools: ["harness.b"], commands: ["x", "y"] });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fix: drop harness.a"]);
  git(repo, ["tag", "v0.0.3"]);
  return repo;
}

function plan(repo: string, args: string[]): { stdout: string; stderr: string; status: number } {
  // Run from the dev repo (so `tsx` resolves), but point the analyzer at the
  // hermetic temp repo via --repo.
  const r = spawnSync("node", ["--import", "tsx", CLI, "release", "plan", "--repo", repo, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

describe("harness release plan", () => {
  let repo: string;
  beforeAll(() => {
    repo = buildRepo();
  });

  it("computes the schema delta + surface diff for a tag range", () => {
    const r = plan(repo, ["--since", "v0.0.1", "--to", "v0.0.2", "--json"]);
    expect(r.status).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.schema).toMatchObject({ fromVersion: 18, toVersion: 19, changed: true, noDowngrade: true });
    expect(p.mcpTools.added).toEqual(["harness.b"]);
    expect(p.mcpTools.removed).toEqual([]);
    expect(p.cliCommands.added).toEqual(["y"]);
    expect(p.recommendedBump).not.toBe("none");
    expect(p.analysisWarnings).toEqual([]);
  });

  it("reports nothing for an empty range (since == to)", () => {
    const r = plan(repo, ["--since", "v0.0.2", "--to", "v0.0.2", "--json"]);
    expect(r.status).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.commits).toEqual([]);
    expect(p.recommendedBump).toBe("none");
    expect(p.schema.changed).toBe(false);
  });

  it("text output labels the no-downgrade caveat", () => {
    const r = plan(repo, ["--since", "v0.0.1", "--to", "v0.0.2"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/schema: 18 → 19/);
    expect(r.stdout).toMatch(/no downgrade/i);
  });

  it("exits 2 on an UNDECLARED breaking change (removed MCP tool, no marker)", () => {
    const r = plan(repo, ["--since", "v0.0.2", "--to", "v0.0.3", "--json"]);
    expect(r.status).toBe(2);
    const p = JSON.parse(r.stdout);
    expect(p.mcpTools.removed).toEqual(["harness.a"]);
    expect(p.undeclaredBreaking.join(" ")).toMatch(/harness\.a/);
  });

  it("exits 1 on an unresolvable --since ref", () => {
    const r = plan(repo, ["--since", "v9.9.9"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot resolve/i);
  });
});
