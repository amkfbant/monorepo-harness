import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
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

  it("init creates harness.sqlite at schema version 1", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    const { out, code } = runCli(root, ["db", "init"]);
    expect(code).toBe(0);
    expect(out).toMatch(/schema version: 1/);
    expect(existsSync(join(root, ".harness", "harness.sqlite"))).toBe(true);
  });

  it("status after init shows version 1 and the v1 tables", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "status"]);
    expect(code).toBe(0);
    expect(out).toMatch(/schema version: 1/);
    expect(out).toMatch(/tables: 2[0-9]/);
  });

  it("migrate is idempotent after init", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "migrate"]);
    expect(code).toBe(0);
    expect(out).toMatch(/already at schema version 1/);
  });

  it("init is idempotent — re-running keeps version 1", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidb-"));
    runCli(root, ["db", "init"]);
    const { out, code } = runCli(root, ["db", "init"]);
    expect(code).toBe(0);
    expect(out).toMatch(/already current/);
  });
});
