import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openManagedDb,
  withManagedDb,
  withManagedDbAsync,
} from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  acquireExclusive,
  MaintenanceLockBusyError,
} from "../../../src/db/maintenance-lock.js";
import { openDb } from "../../../src/db/connection.js";

/**
 * Phase 9 post-close P0 fix — runtime DB open holds shared maintenance
 * lock for the lifetime of the connection, so `db restore`'s exclusive
 * sidecar lock can actually exclude live runtime handles.
 */

function paths(): { dbPath: string; lockPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-managed-"));
  return {
    dbPath: join(root, ".harness", "harness.sqlite"),
    lockPath: join(root, ".harness", "db.lock"),
  };
}

function seedSchema(dbPath: string): void {
  // every test wants a v5 DB ready for runtime queries
  const db = openDb(dbPath);
  try {
    runMigrations(db);
  } finally {
    db.close();
  }
}

describe("managed-connection — shared lock + DB handle lifecycle", () => {
  it("openManagedDb returns a usable handle and close releases lock", () => {
    const { dbPath, lockPath } = paths();
    seedSchema(dbPath);
    const h = openManagedDb({ dbPath, lockPath });
    expect(h.lock.mode).toBe("shared");
    // the lock is held — an exclusive contender must fail fast
    expect(() => acquireExclusive(lockPath, { timeoutMs: 100 })).toThrow(
      MaintenanceLockBusyError,
    );
    // run a trivial query through the DB handle to prove it's live
    const v = h.db.prepare("SELECT 1 AS n").get() as { n: number };
    expect(v.n).toBe(1);
    h.close();
    // after close, exclusive must succeed
    const ex = acquireExclusive(lockPath, { timeoutMs: 100 });
    ex.release();
  });

  it("close is idempotent", () => {
    const { dbPath, lockPath } = paths();
    seedSchema(dbPath);
    const h = openManagedDb({ dbPath, lockPath });
    h.close();
    // second close must not throw
    h.close();
  });

  it("withManagedDb releases the lock even when fn throws", () => {
    const { dbPath, lockPath } = paths();
    seedSchema(dbPath);
    expect(() =>
      withManagedDb({ dbPath, lockPath }, () => {
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    // lock must be free
    const ex = acquireExclusive(lockPath, { timeoutMs: 100 });
    ex.release();
  });

  it("openManagedDb releases the lock when openDb fails", () => {
    const { lockPath } = paths();
    // dbPath points to a directory, so openDb fails — lock must be freed
    const badDbPath = join(
      mkdtempSync(join(tmpdir(), "harness-managed-bad-")),
      "is-a-dir",
    );
    require("node:fs").mkdirSync(badDbPath, { recursive: true });
    expect(() => openManagedDb({ dbPath: badDbPath, lockPath })).toThrow();
    // lock should not be held
    const ex = acquireExclusive(lockPath, { timeoutMs: 100 });
    ex.release();
  });

  it("withManagedDbAsync awaits the fn and releases on resolve", async () => {
    const { dbPath, lockPath } = paths();
    seedSchema(dbPath);
    const v = await withManagedDbAsync({ dbPath, lockPath }, async (db) => {
      const row = db.prepare("SELECT 7 AS n").get() as { n: number };
      return row.n;
    });
    expect(v).toBe(7);
    const ex = acquireExclusive(lockPath, { timeoutMs: 100 });
    ex.release();
  });

  it("withManagedDbAsync releases on reject", async () => {
    const { dbPath, lockPath } = paths();
    seedSchema(dbPath);
    await expect(
      withManagedDbAsync({ dbPath, lockPath }, async () => {
        throw new Error("async-boom");
      }),
    ).rejects.toThrow(/async-boom/);
    const ex = acquireExclusive(lockPath, { timeoutMs: 100 });
    ex.release();
  });

  it("read-only managed handle still takes a shared lock", () => {
    const { dbPath, lockPath } = paths();
    seedSchema(dbPath);
    const h = openManagedDb({ dbPath, lockPath, readonly: true });
    expect(h.lock.mode).toBe("shared");
    // exclusive contender must fail even though we are readonly
    expect(() => acquireExclusive(lockPath, { timeoutMs: 100 })).toThrow(
      MaintenanceLockBusyError,
    );
    h.close();
  });

  it("exclusive runtime open blocks another shared opener", () => {
    const { dbPath, lockPath } = paths();
    seedSchema(dbPath);
    const h = openManagedDb({ dbPath, lockPath, mode: "exclusive" });
    expect(h.lock.mode).toBe("exclusive");
    // a second shared opener must fail fast
    expect(() =>
      openManagedDb({ dbPath, lockPath, timeoutMs: 100 }),
    ).toThrow(MaintenanceLockBusyError);
    h.close();
  });
});

describe("managed-connection — restore-vs-runtime safety", () => {
  it("a held runtime managed handle prevents an exclusive lock until close", () => {
    const { dbPath, lockPath } = paths();
    seedSchema(dbPath);
    const runtime = openManagedDb({ dbPath, lockPath });
    expect(existsSync(lockPath)).toBe(true);
    expect(() => acquireExclusive(lockPath, { timeoutMs: 50 })).toThrow(
      MaintenanceLockBusyError,
    );
    runtime.close();
    const ex = acquireExclusive(lockPath, { timeoutMs: 100 });
    ex.release();
  });
});
