import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-cps-"));
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(
    join(root, "projects", "demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "description: a demo project",
      "repo:",
      "  id: demo",
      "  path: ../demo-repo",
      "  base_branch: main",
      "  package_manager: npm",
      "domains:",
      "  - id: apps/web",
      "    root: apps/web",
      "    kind: app",
      "    title: Web app",
      "  - id: packages/ui",
      "    root: packages/ui",
      "    kind: package",
      "",
    ].join("\n"),
  );
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

describe("CLI project show", () => {
  it("E5-1-6: displays a project profile as text", () => {
    const root = setupHarness();
    const { out, code } = runCli(root, ["project", "show", "--project", "demo"]);
    expect(code).toBe(0);
    expect(out).toMatch(/Project: demo/);
    expect(out).toMatch(/domains \(2\)/);
    expect(out).toMatch(/apps\/web/);
    expect(out).toMatch(/packages\/ui/);
  });

  it("emits parseable JSON with --json", () => {
    const root = setupHarness();
    const { out, code } = runCli(root, [
      "project",
      "show",
      "--project",
      "demo",
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.projectId).toBe("demo");
    expect(parsed.profile.domains).toHaveLength(2);
    expect(parsed.repoPath).toMatch(/demo-repo$/);
  });

  it("exits 1 for a missing project", () => {
    const root = setupHarness();
    const { out, code } = runCli(root, [
      "project",
      "show",
      "--project",
      "nope",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/no project profile/);
  });

  it("exits 1 (not 2) for an unsafe project id", () => {
    const root = setupHarness();
    const { out, code } = runCli(root, [
      "project",
      "show",
      "--project",
      "../escape",
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/invalid project id/);
  });
});
