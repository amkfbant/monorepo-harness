import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

/** A node monorepo fixture: apps/* + packages/* with package.json each. */
function nodeMonorepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-insp-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["apps/*", "packages/*"] }),
  );
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  for (const [dir, name] of [
    ["apps/web", "@demo/web"],
    ["apps/admin", "@demo/admin"],
    ["packages/ui", "@demo/ui"],
  ]) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(
      join(repo, dir, "package.json"),
      JSON.stringify({ name, scripts: { test: "vitest" } }),
    );
  }
  return repo;
}

function runCli(args: string[]): { out: string; code: number } {
  try {
    // HARNESS_ROOT = the harness repo itself, so templates/ resolves.
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: process.cwd() },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

describe("CLI project inspect", () => {
  it("E5-3-5: proposes candidate domains for a node monorepo", () => {
    const repo = nodeMonorepo();
    const { out, code } = runCli(["project", "inspect", "--repo", repo]);
    expect(code).toBe(0);
    expect(out).toMatch(/registry: node-monorepo-default-v1/);
    expect(out).toMatch(/apps\/web/);
    expect(out).toMatch(/apps\/admin/);
    expect(out).toMatch(/packages\/ui/);
  });

  it("emits parseable JSON with --json", () => {
    const repo = nodeMonorepo();
    const { out, code } = runCli([
      "project",
      "inspect",
      "--repo",
      repo,
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.candidates).toHaveLength(3);
    expect(parsed.candidates.map((c: { id: string }) => c.id)).toEqual([
      "apps/admin",
      "apps/web",
      "packages/ui",
    ]);
  });

  it("exits 1 for a missing repo path", () => {
    const { out, code } = runCli([
      "project",
      "inspect",
      "--repo",
      join(tmpdir(), "no-such-repo-xyz"),
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/does not exist/);
  });

  it("exits 1 when --repo points at a file, not a directory", () => {
    const repo = nodeMonorepo();
    const { out, code } = runCli([
      "project",
      "inspect",
      "--repo",
      join(repo, "package.json"),
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/not a directory/);
  });
});
