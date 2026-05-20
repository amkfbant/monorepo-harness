import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDomainLock } from "../../../src/workspace/domain-lock.js";

describe("acquireDomainLock", () => {
  it("creates a lockfile with runId/pid/hostname and returns a release()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const lock = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-xyz-001",
    });
    expect(lock.path).toMatch(/apps-user\.lock$/);
    const stored = JSON.parse(readFileSync(lock.path, "utf8"));
    expect(stored.runId).toBe("run-xyz-001");
    expect(typeof stored.pid).toBe("number");
    expect(typeof stored.hostname).toBe("string");
    expect(typeof stored.acquiredAt).toBe("string");
    await lock.release();
  });

  it("rejects when the same domain is already locked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const first = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-a",
    });
    await expect(
      acquireDomainLock({
        locksDir: dir,
        domain: "apps/user",
        runId: "run-b",
      }),
    ).rejects.toThrow(/locked/);
    await first.release();
  });

  it("allows different domains concurrently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const a = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-a",
    });
    const b = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/admin",
      runId: "run-b",
    });
    await a.release();
    await b.release();
  });

  it("release() does not remove a lock owned by a different runId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const lock = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-a",
    });
    // simulate a stale-recovery process: overwrite the lock with a different runId
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      lock.path,
      JSON.stringify({
        runId: "run-other",
        pid: 0,
        hostname: "x",
        acquiredAt: "2026-05-20",
      }),
    );
    await lock.release();
    expect(existsSync(lock.path)).toBe(true);
  });

  it("release() tolerates a lock file that has already been removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const lock = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-a",
    });
    const { rmSync } = await import("node:fs");
    rmSync(lock.path);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
