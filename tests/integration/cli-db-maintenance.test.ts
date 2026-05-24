import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-clidbm-"));
  runCli(root, ["db", "init"]);
  return root;
}

describe("CLI harness db — backup / restore", () => {
  it("backup writes a copy and restore round-trips it", () => {
    const root = setup();
    const backup = join(root, "snap.sqlite");
    const b = runCli(root, ["db", "backup", "--out", backup]);
    expect(b.code).toBe(0);
    expect(b.out).toMatch(/schema version: 10/);
    expect(existsSync(backup)).toBe(true);
    // restore over an existing DB needs --force
    const r = runCli(root, ["db", "restore", "--from", backup, "--force"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/db restore: replaced/);
  });

  it("restore refuses to overwrite the live DB without --force", () => {
    const root = setup();
    const backup = join(root, "snap.sqlite");
    runCli(root, ["db", "backup", "--out", backup]);
    const r = runCli(root, ["db", "restore", "--from", backup]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--force/);
  });

  it("backup refuses an existing target", () => {
    const root = setup();
    const backup = join(root, "snap.sqlite");
    writeFileSync(backup, "");
    const b = runCli(root, ["db", "backup", "--out", backup]);
    expect(b.code).toBe(1);
    expect(b.out).toMatch(/already exists/);
  });
});

describe("CLI harness db — checkpoint / vacuum / stats", () => {
  it("checkpoint reports the WAL truncation", () => {
    const root = setup();
    const r = runCli(root, ["db", "checkpoint"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/db checkpoint:/);
  });

  it("vacuum reports the size change", () => {
    const root = setup();
    const r = runCli(root, ["db", "vacuum"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/db vacuum:/);
  });

  it("stats reports schema version and table section", () => {
    const root = setup();
    const r = runCli(root, ["db", "stats"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/schema version: 10/);
    expect(r.out).toMatch(/artifact blobs:/);
  });

  it("stats --json emits parseable JSON", () => {
    const root = setup();
    const r = runCli(root, ["db", "stats", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(10);
  });

  it("stats rejects an uninitialized DB", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-clidbm-noinit-"));
    const r = runCli(root, ["db", "stats"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not initialized/);
  });
});
