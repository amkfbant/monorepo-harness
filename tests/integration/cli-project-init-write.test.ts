import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const CLI = join(process.cwd(), "src/cli/run.ts");

/** A temp harness root with the real template catalogs copied in. */
function harnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-iw-"));
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  return root;
}

function nodeMonorepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-iw-repo-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
  );
  writeFileSync(join(repo, "package-lock.json"), "{}");
  mkdirSync(join(repo, "apps/web"), { recursive: true });
  writeFileSync(
    join(repo, "apps/web/package.json"),
    JSON.stringify({ name: "@demo/web", scripts: { test: "vitest" } }),
  );
  return repo;
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

describe("CLI project init --write", () => {
  it("E5-5-5: writes the profile, repo policy, and provenance sidecar", () => {
    const root = harnessRoot();
    const repo = nodeMonorepo();
    const { code } = runCli(root, [
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "demo",
      "--write",
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "projects/demo.yaml"))).toBe(true);
    expect(existsSync(join(root, "policies/repos/demo.yaml"))).toBe(true);
    expect(
      existsSync(join(root, "policies/repos/demo.generated.json")),
    ).toBe(true);
  });

  it("E5-5-6: the generated profile and policy are valid YAML", () => {
    const root = harnessRoot();
    const repo = nodeMonorepo();
    runCli(root, [
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "demo",
      "--write",
    ]);
    const profile = parseYaml(
      execFileSync("cat", [join(root, "projects/demo.yaml")]).toString(),
    );
    expect((profile as { project_id: string }).project_id).toBe("demo");
  });

  it("refuses to overwrite an existing file without --force", () => {
    const root = harnessRoot();
    const repo = nodeMonorepo();
    const first = runCli(root, [
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "demo",
      "--write",
    ]);
    expect(first.code).toBe(0);
    const second = runCli(root, [
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "demo",
      "--write",
    ]);
    expect(second.code).toBe(1);
    expect(second.out).toMatch(/refusing to overwrite/);
  });

  it("overwrites with --force", () => {
    const root = harnessRoot();
    const repo = nodeMonorepo();
    runCli(root, [
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "demo",
      "--write",
    ]);
    const forced = runCli(root, [
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "demo",
      "--write",
      "--force",
    ]);
    expect(forced.code).toBe(0);
  });
});
