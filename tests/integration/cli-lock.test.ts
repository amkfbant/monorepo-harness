import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(
  args: string[],
  harnessRoot: string,
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: harnessRoot },
    }).toString();
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      status: err.status ?? 1,
    };
  }
}

function setupLocks(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-lockcli-"));
  mkdirSync(join(root, "locks"), { recursive: true });
  writeFileSync(
    join(root, "locks", "apps-user.lock"),
    JSON.stringify(
      {
        runId: "run-test-1",
        pid: 9999,
        hostname: "host-a",
        acquiredAt: "2026-05-20T00:00:00.000Z",
      },
      null,
      2,
    ),
  );
  return root;
}

describe("CLI harness lock", () => {
  it("list prints current locks with metadata", () => {
    const root = setupLocks();
    const { stdout, status } = runCli(["lock", "list"], root);
    expect(status).toBe(0);
    expect(stdout).toMatch(/apps-user\.lock/);
    expect(stdout).toMatch(/runId=run-test-1/);
    expect(stdout).toMatch(/pid=9999/);
  });

  it("list prints '(none)' under each section on an empty harness root", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-lockcli-"));
    mkdirSync(join(root, "locks"), { recursive: true });
    const { stdout, status } = runCli(["lock", "list"], root);
    expect(status).toBe(0);
    // Phase 9: lock list shows file + DB sections
    expect(stdout).toMatch(/file locks:\s+\(none\)/);
    expect(stdout).toMatch(/db locks:/);
  });

  it("release with matching --run-id removes the lock", () => {
    const root = setupLocks();
    const lockPath = join(root, "locks", "apps-user.lock");
    expect(existsSync(lockPath)).toBe(true);
    const { status } = runCli(
      ["lock", "release", "--domain", "apps/user", "--run-id", "run-test-1"],
      root,
    );
    expect(status).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("release errors on runId mismatch without --force", () => {
    const root = setupLocks();
    const { stdout, status } = runCli(
      ["lock", "release", "--domain", "apps/user", "--run-id", "wrong"],
      root,
    );
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/runId mismatch/);
  });

  it("release --force removes the lock even on runId mismatch", () => {
    const root = setupLocks();
    const lockPath = join(root, "locks", "apps-user.lock");
    const { status } = runCli(
      [
        "lock",
        "release",
        "--domain",
        "apps/user",
        "--run-id",
        "wrong",
        "--force",
      ],
      root,
    );
    expect(status).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("list surfaces unreadable lockfiles as status=unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-lockcli-"));
    mkdirSync(join(root, "locks"), { recursive: true });
    // intentionally invalid JSON
    writeFileSync(join(root, "locks", "broken.lock"), "{not json");
    const { stdout, status } = runCli(["lock", "list"], root);
    expect(status).toBe(0);
    expect(stdout).toMatch(/broken\.lock\tstatus=unreadable/);
  });
});
