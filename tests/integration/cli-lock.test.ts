import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(
  args: string[],
  harnessRoot: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, HARNESS_ROOT: harnessRoot, ...extraEnv },
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

function setupRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-lockcli-"));
}

function seedLegacyLockFile(root: string): void {
  mkdirSync(join(root, "locks"), { recursive: true });
  writeFileSync(
    join(root, "locks", "apps-user.lock"),
    JSON.stringify({
      runId: "run-legacy",
      pid: 9999,
      hostname: "host-a",
      acquiredAt: "2026-05-20T00:00:00.000Z",
    }),
  );
}

describe("CLI harness lock (Phase 10)", () => {
  it("list prints '(none)' for db locks on an empty harness root with no DB", () => {
    const root = setupRoot();
    const r = runCli(["lock", "list"], root, {
      HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING: "1",
    });
    expect(r.status).toBe(0);
    // Phase 10: only the DB locks section is printed; no `file locks:` line.
    expect(r.stdout).not.toMatch(/file locks:/);
    expect(r.stdout).toMatch(/db locks:/);
    // no DB initialised → structured message
    expect(r.stdout).toMatch(/db not initialised/);
  });

  it("list warns once about legacy file locks when sentinels are present", () => {
    const root = setupRoot();
    seedLegacyLockFile(root);
    const r = runCli(["lock", "list"], root);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/legacy file domain lock/);
    expect(r.stderr).toMatch(/apps-user\.lock/);
    // db locks section still printed below the warning
    expect(r.stdout).toMatch(/db locks:/);
  });

  it("list is silent about legacy file locks when HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING=1", () => {
    const root = setupRoot();
    seedLegacyLockFile(root);
    const r = runCli(["lock", "list"], root, {
      HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/legacy file domain lock/);
  });

  it("release prints 'no lock' for an unheld domain (no DB)", () => {
    const root = setupRoot();
    const r = runCli(
      ["lock", "release", "--domain", "apps/user"],
      root,
      { HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING: "1" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no lock for domain apps\/user/);
  });

  it("release --source file is deprecated: warns and is a no-op for the DB lock", () => {
    const root = setupRoot();
    seedLegacyLockFile(root);
    const r = runCli(
      [
        "lock",
        "release",
        "--domain",
        "apps/user",
        "--source",
        "file",
      ],
      root,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/`--source file` is deprecated/);
  });

  it("release --source both warns but still releases the DB lock", () => {
    const root = setupRoot();
    const r = runCli(
      [
        "lock",
        "release",
        "--domain",
        "apps/user",
        "--source",
        "both",
      ],
      root,
      { HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING: "1" },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/`--source both` is deprecated/);
  });
});
