import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setup(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-rpd-"));
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  mkdirSync(join(root, "projects"), { recursive: true });

  // a minimal real git repo so prepareProjectRun's repo scan works.
  const repo = mkdtempSync(join(tmpdir(), "harness-rpd-repo-"));
  mkdirSync(join(repo, "apps/web"), { recursive: true });
  writeFileSync(
    join(repo, "apps/web/package.json"),
    JSON.stringify({ name: "@demo/web" }),
  );
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@e.com",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "init",
  ]);

  writeFileSync(
    join(root, "projects", "demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: demo",
      `  path: ${repo}`,
      "policy:",
      "  template: strict-monorepo-v1",
      "domains:",
      "  - id: apps/web",
      "    root: apps/web",
      "    kind: app",
      "",
    ].join("\n"),
  );
  return { root };
}

function runCli(root: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: root },
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

describe("CLI run --project --dry-run", () => {
  it("E5-7-5: resolves a profile policy and exits 0", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "run",
      "--project",
      "demo",
      "--domain",
      "apps/web",
      "--goal",
      "noop",
      "--dry-run",
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/resolved policy for apps\/web/);
    expect(out).toMatch(/"write"/);
  });

  it("exits 1 for an unknown domain", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "run",
      "--project",
      "demo",
      "--domain",
      "apps/ghost",
      "--goal",
      "noop",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/not defined/);
  });

  it("exits 1 for a missing project", () => {
    const { root } = setup();
    const { code } = runCli(root, [
      "run",
      "--project",
      "nope",
      "--domain",
      "apps/web",
      "--goal",
      "noop",
      "--dry-run",
    ]);
    expect(code).toBe(1);
  });

  it("Phase 6-1: rejects --project combined with --repo-id", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "run",
      "--project",
      "demo",
      "--repo-id",
      "demo",
      "--domain",
      "apps/web",
      "--goal",
      "noop",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/cannot combine --project with --repo-id/);
  });

  it("Phase 6-1: errors when the profile repo path is not a directory", () => {
    const { root } = setup();
    // point the profile's repo.path at a file
    const filePath = join(root, "not-a-dir.txt");
    writeFileSync(filePath, "file\n");
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: demo",
        `  path: ${filePath}`,
        "policy:",
        "  template: strict-monorepo-v1",
        "domains:",
        "  - id: apps/web",
        "    root: apps/web",
        "    kind: app",
        "",
      ].join("\n"),
    );
    const { out, code } = runCli(root, [
      "run",
      "--project",
      "demo",
      "--domain",
      "apps/web",
      "--goal",
      "noop",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/not a directory/);
  });
});
