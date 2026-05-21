import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.email=t@e.com",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "init",
  ]);
}

function file(repo: string, rel: string, content: string): void {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

function nodeAppsPackages(): string {
  const r = mkdtempSync(join(tmpdir(), "harness-m-nap-"));
  file(r, "package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] }));
  file(r, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  file(r, "apps/web/package.json", JSON.stringify({ name: "@m/web", scripts: { test: "v" } }));
  file(r, "apps/admin/package.json", JSON.stringify({ name: "@m/admin" }));
  file(r, "packages/ui/package.json", JSON.stringify({ name: "@m/ui" }));
  gitInit(r);
  return r;
}

function servicesLibs(): string {
  const r = mkdtempSync(join(tmpdir(), "harness-m-sl-"));
  file(r, "package.json", JSON.stringify({ name: "root" }));
  file(r, "package-lock.json", "{}");
  file(r, "services/api/package.json", JSON.stringify({ name: "@m/api" }));
  file(r, "libs/common/package.json", JSON.stringify({ name: "@m/common" }));
  gitInit(r);
  return r;
}

function pythonServices(): string {
  const r = mkdtempSync(join(tmpdir(), "harness-m-py-"));
  file(r, "pyproject.toml", "[project]\nname = 'm'\n");
  file(r, "services/api/app.py", "print('hi')\n");
  file(r, "packages/common/__init__.py", "");
  gitInit(r);
  return r;
}

function docsOnly(): string {
  const r = mkdtempSync(join(tmpdir(), "harness-m-docs-"));
  file(r, "README.md", "# docs\n");
  file(r, "docs/guide.md", "guide\n");
  gitInit(r);
  return r;
}

/** a temp HARNESS_ROOT with the real template catalogs. */
function harnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-m-root-"));
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  return root;
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

interface InspectJson {
  registryId: string;
  candidates: Array<{
    id: string;
    kind: string;
    suggestedCommandPresets: string[];
  }>;
}

function inspect(repo: string): InspectJson {
  const { out, code } = runCli(process.cwd(), [
    "project",
    "inspect",
    "--repo",
    repo,
    "--json",
  ]);
  expect(code).toBe(0);
  return JSON.parse(out) as InspectJson;
}

describe("project matrix — non-mini-commerce layouts (Phase 5-9)", () => {
  it("E5-9-1: node apps+packages — exact candidate set", () => {
    const r = inspect(nodeAppsPackages());
    expect(r.registryId).toBe("node-monorepo-default-v1");
    expect(r.candidates.map((c) => c.id)).toEqual([
      "apps/admin",
      "apps/web",
      "packages/ui",
    ]);
    expect(r.candidates.find((c) => c.id === "apps/web")?.kind).toBe("app");
    expect(
      r.candidates.find((c) => c.id === "packages/ui")?.suggestedCommandPresets,
    ).toEqual(["node-package-basic-v1"]);
  });

  it("E5-9-2: services+libs — exact candidate set", () => {
    const r = inspect(servicesLibs());
    expect(r.candidates.map((c) => c.id)).toEqual([
      "libs/common",
      "services/api",
    ]);
    expect(r.candidates.find((c) => c.id === "services/api")?.kind).toBe(
      "service",
    );
  });

  it("E5-9-3: python services — generic registry, python preset", () => {
    const r = inspect(pythonServices());
    expect(r.registryId).toBe("generic-repo-default-v1");
    expect(r.candidates.map((c) => c.id)).toEqual([
      "packages/common",
      "services/api",
    ]);
    expect(
      r.candidates.find((c) => c.id === "services/api")?.suggestedCommandPresets,
    ).toEqual(["python-basic-v1"]);
  });

  it("E5-9-4: docs-only — docs domain", () => {
    const r = inspect(docsOnly());
    expect(r.registryId).toBe("generic-repo-default-v1");
    expect(r.candidates.map((c) => c.id)).toEqual(["docs"]);
    expect(r.candidates[0]?.kind).toBe("docs");
  });

  it("E5-9-5: init --dry-run proposes a policy and writes nothing, for every layout", () => {
    for (const repo of [
      nodeAppsPackages(),
      servicesLibs(),
      pythonServices(),
      docsOnly(),
    ]) {
      const root = harnessRoot();
      const { out, code } = runCli(root, [
        "project",
        "init",
        "--repo",
        repo,
        "--project-id",
        "matrix-demo",
        "--dry-run",
        "--json",
      ]);
      expect(code).toBe(0);
      expect((JSON.parse(out) as { written: string[] }).written).toEqual([]);
      // a dry-run must not create projects/ or policies/ under the root.
      expect(existsSync(join(root, "projects"))).toBe(false);
      expect(existsSync(join(root, "policies"))).toBe(false);
    }
  });

  it("E5-9-6: init --write → check → run --project --dry-run for a fixture", () => {
    const root = harnessRoot();
    const repo = nodeAppsPackages();

    const init = runCli(root, [
      "project",
      "init",
      "--repo",
      repo,
      "--project-id",
      "matrix",
      "--write",
    ]);
    expect(init.code).toBe(0);
    expect(readdirSync(join(root, "projects"))).toContain("matrix.yaml");

    const check = runCli(root, ["project", "check", "--project", "matrix"]);
    expect(check.code).toBe(0);
    expect(check.out).toMatch(/status: (ok|warn)/);

    const dry = runCli(root, [
      "run",
      "--project",
      "matrix",
      "--domain",
      "apps/web",
      "--goal",
      "noop",
      "--dry-run",
    ]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/resolved policy for apps\/web/);
  });

  it("E5-9-7: check detects an intentionally-broken setup", () => {
    const root = harnessRoot();
    runCli(root, [
      "project",
      "init",
      "--repo",
      nodeAppsPackages(),
      "--project-id",
      "matrix",
      "--write",
    ]);
    // point check at a repo path that does not exist → config error, exit 1.
    const broken = runCli(root, [
      "project",
      "check",
      "--project",
      "matrix",
      "--repo",
      join(tmpdir(), "harness-m-no-such-repo"),
    ]);
    expect(broken.code).toBe(1);
    expect(broken.out).toMatch(/status: error/);
  });
});
