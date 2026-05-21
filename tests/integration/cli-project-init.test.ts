import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function nodeMonorepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-init-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
  );
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  mkdirSync(join(repo, "apps/web"), { recursive: true });
  writeFileSync(
    join(repo, "apps/web/package.json"),
    JSON.stringify({ name: "@demo/web", scripts: { test: "vitest" } }),
  );
  return repo;
}

function runCli(args: string[]): { out: string; code: number } {
  try {
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

describe("CLI project init --dry-run", () => {
  it("E5-5-3: shows a policy proposal and writes nothing", () => {
    const repo = nodeMonorepo();
    const { out, code } = runCli([
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "demo-init",
      "--dry-run",
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/policy proposal: demo-init/);
    expect(out).toMatch(/apps\/web/);
    // dry-run never writes — the profile must not appear under projects/.
    expect(existsSync(join(process.cwd(), "projects/demo-init.yaml"))).toBe(
      false,
    );
  });

  it("E5-5-4: --from-policy migrates an existing repo policy", () => {
    const { out, code } = runCli([
      "project",
      "init",
      "--from-policy",
      "mini-commerce",
      "--project-id",
      "mc-migrated",
      "--dry-run",
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/policy proposal: mc-migrated/);
  });

  it("exits 1 when neither --repo nor --from-policy is given", () => {
    const { out, code } = runCli([
      "project",
      "init",
      "--project-id",
      "x",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/requires --repo or --from-policy/);
  });

  it("exits 1 when --write and --dry-run are combined", () => {
    const repo = nodeMonorepo();
    const { out, code } = runCli([
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "x",
      "--write",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/mutually exclusive/);
  });
});
