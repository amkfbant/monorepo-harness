import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDomainLock } from "../../../src/workspace/domain-lock.js";

describe("acquireDomainLock", () => {
  it("creates a lockfile and returns a release()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const lock = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-1",
    });
    expect(lock.path).toMatch(/apps-user\.lock$/);
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
});
