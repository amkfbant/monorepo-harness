import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  acquireDomainLock,
  listActiveDomainLocks,
  findActiveDomainLock,
  releaseDomainLockByDomain,
  DomainLockBusyError,
  LeaseLostError,
} from "../../../src/workspace/db-domain-lock.js";

/**
 * Phase 9-4 — DB-backed domain lock.
 *
 * The lease duration / heartbeat interval are tuned to short test values
 * via `HARNESS_LOCK_LEASE_MS` so we can exercise expiry / stolen-lease
 * deterministically without a fake clock plumbed through every call.
 */

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "harness-dlock-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

const PRIOR_LEASE = process.env.HARNESS_LOCK_LEASE_MS;

afterEach(() => {
  if (PRIOR_LEASE === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
  else process.env.HARNESS_LOCK_LEASE_MS = PRIOR_LEASE;
});

const HOLDER = {
  repoId: "demo",
  domain: "apps/web",
  domainKey: "demo::apps/web",
  pid: 100,
  hostname: "h1",
};

describe("acquireDomainLock", () => {
  it("acquires and releases a lease cleanly", () => {
    const db = freshDb();
    const handle = acquireDomainLock(db, { ...HOLDER, runId: "run-1" });
    expect(handle.lockId).toBeGreaterThan(0);
    expect(handle.fencingToken).toBe(handle.lockId);
    expect(listActiveDomainLocks(db)).toHaveLength(1);
    handle.release();
    expect(listActiveDomainLocks(db)).toHaveLength(0);
    db.close();
  });

  it("rejects a concurrent acquire on the same domain with DomainLockBusyError", () => {
    const db = freshDb();
    const a = acquireDomainLock(db, { ...HOLDER, runId: "run-a" });
    expect(() =>
      acquireDomainLock(db, { ...HOLDER, runId: "run-b" }),
    ).toThrow(DomainLockBusyError);
    a.release();
    db.close();
  });

  it("soft-releases an expired lease before re-acquiring (lease stealing semantics)", () => {
    process.env.HARNESS_LOCK_LEASE_MS = "10"; // 10ms — guaranteed to expire
    const db = freshDb();
    const a = acquireDomainLock(db, { ...HOLDER, runId: "run-a" });
    const expiredAt = new Date(Date.now() + 1_000); // a `now` well past lease
    const b = acquireDomainLock(db, {
      ...HOLDER,
      runId: "run-b",
      now: expiredAt,
    });
    expect(b.lockId).toBeGreaterThan(a.lockId);
    expect(b.fencingToken).toBeGreaterThan(a.fencingToken);
    // the prior lease was soft-released with reason='expired'
    const all = db
      .prepare(
        "SELECT release_reason FROM domain_locks WHERE lock_id = ?",
      )
      .get(a.lockId) as { release_reason: string };
    expect(all.release_reason).toBe("expired");
    b.release();
    db.close();
  });

  it("heartbeat extends expires_at and updates heartbeat_at", () => {
    const db = freshDb();
    const start = new Date("2026-05-23T10:00:00Z");
    const handle = acquireDomainLock(db, {
      ...HOLDER,
      runId: "run-hb",
      now: start,
    });
    const beforeRow = findActiveDomainLock(db, HOLDER.domainKey);
    const beat = new Date("2026-05-23T10:01:00Z");
    handle.heartbeat(beat);
    const afterRow = findActiveDomainLock(db, HOLDER.domainKey);
    expect(afterRow?.heartbeatAt).not.toBe(beforeRow?.heartbeatAt);
    expect(afterRow?.expiresAt > (beforeRow?.expiresAt ?? "")).toBe(true);
    handle.release();
    db.close();
  });

  it("heartbeat throws LeaseLostError when the lease was stolen", () => {
    process.env.HARNESS_LOCK_LEASE_MS = "10";
    const db = freshDb();
    const a = acquireDomainLock(db, { ...HOLDER, runId: "run-a" });
    const expiredAt = new Date(Date.now() + 1_000);
    // b takes the lease while a is unaware
    acquireDomainLock(db, { ...HOLDER, runId: "run-b", now: expiredAt });
    expect(() => a.heartbeat(expiredAt)).toThrow(LeaseLostError);
    db.close();
  });

  it("release() is idempotent", () => {
    const db = freshDb();
    const h = acquireDomainLock(db, { ...HOLDER, runId: "r" });
    h.release();
    h.release(); // no throw, no row resurrection
    expect(listActiveDomainLocks(db)).toHaveLength(0);
    db.close();
  });
});

describe("listActiveDomainLocks / findActiveDomainLock / releaseByDomain", () => {
  it("lists only active leases", () => {
    const db = freshDb();
    const a = acquireDomainLock(db, { ...HOLDER, runId: "a" });
    acquireDomainLock(db, {
      ...HOLDER,
      domainKey: "demo::apps/api",
      domain: "apps/api",
      runId: "b",
    });
    expect(listActiveDomainLocks(db)).toHaveLength(2);
    a.release();
    expect(listActiveDomainLocks(db)).toHaveLength(1);
    db.close();
  });

  it("releaseByDomain with runId mismatch refuses without --force", () => {
    const db = freshDb();
    const a = acquireDomainLock(db, { ...HOLDER, runId: "run-a" });
    const r = releaseDomainLockByDomain(db, {
      domainKey: HOLDER.domainKey,
      runId: "run-other",
    });
    expect(r).toBeNull();
    // still active
    expect(findActiveDomainLock(db, HOLDER.domainKey)).not.toBeNull();
    a.release();
    db.close();
  });

  it("releaseByDomain with --force releases despite runId mismatch", () => {
    const db = freshDb();
    acquireDomainLock(db, { ...HOLDER, runId: "run-a" });
    const r = releaseDomainLockByDomain(db, {
      domainKey: HOLDER.domainKey,
      runId: "run-other",
      force: true,
      releasedBy: "operator",
    });
    expect(r?.holderRunId).toBe("run-a");
    expect(findActiveDomainLock(db, HOLDER.domainKey)).toBeNull();
    const row = db
      .prepare(
        "SELECT release_reason, released_by FROM domain_locks WHERE lock_id = ?",
      )
      .get(r?.lockId) as { release_reason: string; released_by: string };
    expect(row.release_reason).toBe("force");
    expect(row.released_by).toBe("operator");
    db.close();
  });
});
