import { describe, it, expect } from "vitest";
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
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if ((r.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

interface RepoOpts {
  manifestVersion?: string; // default matches package version 0.0.2
  mcpDoc?: string; // default documents harness.b
  dbDoc?: string; // default documents v19
}

/** Hermetic git repo: v0.0.1 (schema 18, harness.a) → v0.0.2 (schema 19, +harness.b). */
function buildRepo(o: RepoOpts = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-relcheck-"));
  mkdirSync(join(repo, "src/db"), { recursive: true });
  mkdirSync(join(repo, "src/mcp/registry"), { recursive: true });
  mkdirSync(join(repo, "docs/specs"), { recursive: true });
  const write = (p: string, c: string) => writeFileSync(join(repo, p), c);

  write("src/db/schema.ts", "export const SCHEMA_VERSION = 18;\n");
  write("src/mcp/registry/tool-registry.ts", `  name: "harness.a",\n`);
  write("package.json", JSON.stringify({ name: "x", version: "0.0.1" }));
  write(".release-please-manifest.json", JSON.stringify({ ".": "0.0.1" }));
  write("docs/specs/mcp.md", "# mcp\n");
  write("docs/specs/db.md", "# db\nschema v18\n");
  write("docs/specs/cli.md", "# cli\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: base"]);
  git(repo, ["tag", "v0.0.1"]);

  write("src/db/schema.ts", "export const SCHEMA_VERSION = 19;\n");
  write("src/mcp/registry/tool-registry.ts", `  name: "harness.a",\n  name: "harness.b",\n`);
  write("package.json", JSON.stringify({ name: "x", version: "0.0.2" }));
  write(".release-please-manifest.json", JSON.stringify({ ".": o.manifestVersion ?? "0.0.2" }));
  write("docs/specs/mcp.md", o.mcpDoc ?? "# mcp\nthe harness.b read tool\n");
  write("docs/specs/db.md", o.dbDoc ?? "# db\nschema v19 adds a column\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: add harness.b, schema 19, docs"]);
  git(repo, ["tag", "v0.0.2"]);
  return repo;
}

function check(repo: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(
    "node",
    ["--import", "tsx", CLI, "release", "check", "--repo", repo, "--since", "v0.0.1", "--to", "v0.0.2", "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function checkOf(report: any, name: string) {
  return report.checks.find((c: any) => c.name === name);
}

describe("harness release check", () => {
  it("PASSES (exit 0) when consistent + documented + clean", () => {
    const r = check(buildRepo());
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.every((c: any) => c.pass)).toBe(true);
  });

  it("FAILS (exit 1) version-consistency on a manifest mismatch", () => {
    const r = check(buildRepo({ manifestVersion: "0.0.1" }));
    expect(r.status).toBe(1);
    expect(checkOf(JSON.parse(r.stdout), "version-consistency").pass).toBe(false);
  });

  it("FAILS (exit 1) spec-sync when an added MCP tool is undocumented", () => {
    const r = check(buildRepo({ mcpDoc: "# mcp\n(nothing here)\n" }));
    expect(r.status).toBe(1);
    expect(checkOf(JSON.parse(r.stdout), "spec-sync").pass).toBe(false);
    expect(checkOf(JSON.parse(r.stdout), "spec-sync").detail).toMatch(/harness\.b/);
  });

  it("FAILS (exit 1) spec-sync when the schema bump is undocumented", () => {
    const r = check(buildRepo({ dbDoc: "# db\nschema v18 only\n" }));
    expect(r.status).toBe(1);
    expect(checkOf(JSON.parse(r.stdout), "spec-sync").detail).toMatch(/v19/);
  });

  it("FAILS (exit 1) clean-tree on uncommitted changes", () => {
    const repo = buildRepo();
    writeFileSync(join(repo, "uncommitted.txt"), "dirty");
    const r = check(repo);
    expect(r.status).toBe(1);
    expect(checkOf(JSON.parse(r.stdout), "clean-tree").pass).toBe(false);
  });
});
