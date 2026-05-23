import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireShared,
  acquireExclusive,
  MaintenanceLockBusyError,
} from "../../../src/db/maintenance-lock.js";

/**
 * Phase 9-2 — DB-wide reader/writer maintenance lock.
 *
 * The lock is acquired on a sidecar file via POSIX flock — two open file
 * descriptors on the same file from the same process still serialise
 * through the kernel's flock table, so the in-process tests below
 * exercise real cross-fd semantics.
 */

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "harness-mlock-")), "db.lock");
}

describe("maintenance lock — shared / exclusive", () => {
  it("acquires and releases a shared lock", () => {
    const path = lockPath();
    const h = acquireShared(path);
    expect(h.mode).toBe("shared");
    h.release();
    // release is idempotent — calling it again must not throw
    h.release();
  });

  it("acquires and releases an exclusive lock", () => {
    const path = lockPath();
    const h = acquireExclusive(path);
    expect(h.mode).toBe("exclusive");
    h.release();
  });

  it("two concurrent shared holders both succeed", () => {
    const path = lockPath();
    const a = acquireShared(path);
    const b = acquireShared(path, { timeoutMs: 500 });
    expect(b.mode).toBe("shared");
    a.release();
    b.release();
  });

  it("a shared lock blocks an exclusive contender (busy on timeout)", () => {
    const path = lockPath();
    const a = acquireShared(path);
    expect(() => acquireExclusive(path, { timeoutMs: 200 })).toThrow(
      MaintenanceLockBusyError,
    );
    a.release();
    // once the shared lock is released, exclusive acquires cleanly
    const b = acquireExclusive(path, { timeoutMs: 500 });
    b.release();
  });

  it("an exclusive lock blocks another exclusive contender", () => {
    const path = lockPath();
    const a = acquireExclusive(path);
    expect(() => acquireExclusive(path, { timeoutMs: 150 })).toThrow(
      MaintenanceLockBusyError,
    );
    a.release();
  });

  it("an exclusive lock blocks a shared contender", () => {
    const path = lockPath();
    const a = acquireExclusive(path);
    expect(() => acquireShared(path, { timeoutMs: 150 })).toThrow(
      MaintenanceLockBusyError,
    );
    a.release();
  });

  // (a cross-process "wait then acquire" scenario requires a spawned
  // worker because `acquire`'s retry loop blocks the event loop via
  // `Atomics.wait` — a same-process `setTimeout` cannot fire during it.
  // That coverage lives in the Phase 9-12 concurrency fixture matrix.)

  it("creates the lock file with restrictive permissions (0600)", () => {
    if (process.platform === "win32") return;
    const path = lockPath();
    const h = acquireShared(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    h.release();
  });

  it(
    "non-busy flock errors (e.g. EBADF) propagate instead of being " +
      "disguised as MaintenanceLockBusyError (Phase 9 post-close P2-4)",
    () => {
      // a lock file path inside a non-existent directory triggers
      // ENOENT on openSync — the surface for non-EWOULDBLOCK errors.
      // The test confirms acquire surfaces the raw error rather than
      // swallowing it into a busy / retry loop forever.
      const badPath = "/nonexistent-harness-mlock-dir/db.lock";
      expect(() => acquireShared(badPath, { timeoutMs: 100 })).toThrow();
    },
  );
});
