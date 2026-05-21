import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setup(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-cc-"));
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  mkdirSync(join(root, "projects"), { recursive: true });

  const repo = mkdtempSync(join(tmpdir(), "harness-cc-repo-"));
  writeFileSync(join(repo, "package-lock.json"), "{}");
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
    "user.email=t@example.com",
    "-c",
    "user.name=test",
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
  return { root, repo };
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

describe("CLI project check", () => {
  it("E5-6-8: a sound profile checks ok and exits 0", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "project",
      "check",
      "--project",
      "demo",
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/status: ok/);
  });

  it("emits parseable JSON with --json", () => {
    const { root } = setup();
    const { out, code } = runCli(root, [
      "project",
      "check",
      "--project",
      "demo",
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.projectId).toBe("demo");
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it("exits 1 when the profile has a config error", () => {
    const { root } = setup();
    const { code } = runCli(root, [
      "project",
      "check",
      "--project",
      "demo",
      "--repo",
      join(tmpdir(), "no-such-repo-cc"),
    ]);
    expect(code).toBe(1);
  });
});
