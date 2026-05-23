import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

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

describe("CLI harness db", () => {
  it("status reports 'not initialized' before db init", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    const { out, code } = runCli(root, ["db", "status"]);
    expect(code).toBe(0);
    expect(out).toMatch(/not initialized/);
  });

  it("init creates harness.sqlite at the latest schema version", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    const { out, code } = runCli(root, ["db", "init"]);
    expect(code).toBe(0);
    expect(out).toMatch(/schema version: 5/);
    expect(existsSync(join(root, ".harness", "harness.sqlite"))).toBe(true);
  });

  it("status after init shows the latest version and the tables", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "status"]);
    expect(code).toBe(0);
    expect(out).toMatch(/schema version: 5/);
    expect(out).toMatch(/tables: [23][0-9]/);
  });

  it("migrate is idempotent after init", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "migrate"]);
    expect(code).toBe(0);
    expect(out).toMatch(/already at schema version 5/);
  });

  it("init is idempotent — re-running keeps the schema current", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "init"]);
    expect(code).toBe(0);
    expect(out).toMatch(/already current/);
  });

  it("import requires --from-files", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    const { out, code } = runCli(root, ["db", "import"]);
    expect(code).toBe(1);
    expect(out).toMatch(/requires --from-files/);
  });

  it("import --from-files builds the read model from a project tree", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: demo",
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
      "db",
      "import",
      "--from-files",
      "--json",
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { projects: number; errors: number };
    expect(report.projects).toBe(1);
    expect(report.errors).toBe(0);
  });

  it("check-consistency reports ok right after an import", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: demo",
        "domains:",
        "  - id: apps/web",
        "    root: apps/web",
        "    kind: app",
        "",
      ].join("\n"),
    );
    runCli(root, ["db", "import", "--from-files"]);
    const { out, code } = runCli(root, ["db", "check-consistency"]);
    expect(code).toBe(0);
    expect(out).toMatch(/db consistency: ok/);
  });

  it("check-consistency exits 1 when a profile drifts", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    mkdirSync(join(root, "projects"), { recursive: true });
    const profile = [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: demo",
      "domains:",
      "  - id: apps/web",
      "    root: apps/web",
      "    kind: app",
      "",
    ].join("\n");
    writeFileSync(join(root, "projects", "demo.yaml"), profile);
    runCli(root, ["db", "import", "--from-files"]);
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      `${profile}description: drifted\n`,
    );
    const { out, code } = runCli(root, ["db", "check-consistency"]);
    expect(code).toBe(1);
    expect(out).toMatch(/drift/);
  });
});
