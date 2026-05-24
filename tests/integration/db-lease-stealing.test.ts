import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname } from "node:os";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { RunRepository } from "../../src/db/repositories/runs.js";
import {
  acquireDomainLock,
  assertActiveLease,
  DomainLockBusyError,
  LeaseGuardFailedError,
  LeaseLostError,
} from "../../src/workspace/db-domain-lock.js";

/**
 * Phase 10-2 — Real DB lease stealing integration tests
 *
 * Phase 9 ran the file lock in dual mode, so the runtime path that loses
 * a DB lease was never actually exercised. Phase 10-1 retired the file
 * lock; Phase 10-2 verifies the full lease-stealing path is race-safe.
 *
 * Covers design §3.B B1/B2/B3 of
 * docs/superpowers/specs/2026-05-23-phase10-db-only-runtime-completion-design.md.
 */

interface Fixture {
  dbPath: string;
  runIdA: string;
  runIdB: string;
  domainKey: string;
  repoId: string;
  domain: string;
}

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-leasesteal-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const runIdA = "run-20260524-apps-user-leaseA";
  const runIdB = "run-20260524-apps-user-leaseB";
  const domainKey = "t::apps/user";
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    for (const runId of [runIdA, runIdB]) {
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, started_at,
           updated_at, meta_json)
         VALUES (?, 't', 'apps/user', 'domain-coding', 'main',
           'running', 'db-first', 1, 'disabled', ?, ?, ?)`,
      ).run(
        runId,
        "2026-05-24T00:00:00Z",
        "2026-05-24T00:00:00Z",
        JSON.stringify({ runId, status: "running" }),
      );
    }
  } finally {
    db.close();
  }
  return {
    dbPath,
    runIdA,
    runIdB,
    domainKey,
    repoId: "t",
    domain: "apps/user",
  };
}

/** Force an "expired" lease by directly aging out the row in SQLite. */
function expireLease(dbPath: string, lockId: number): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `UPDATE domain_locks SET expires_at = '1970-01-01T00:00:00Z'
        WHERE lock_id = ?`,
    ).run(lockId);
  } finally {
    db.close();
  }
}

describe("Phase 10-2 DB lease stealing — full integration", () => {
  it("expired lease can be stolen by a second acquire", () => {
    const f = setup();
    const dbA = openDb(f.dbPath);
    let lockIdA: number;
    try {
      const leaseA = acquireDomainLock(dbA, {
        domainKey: f.domainKey,
        repoId: f.repoId,
        domain: f.domain,
        runId: f.runIdA,
        pid: process.pid,
        hostname: hostname(),
      });
      lockIdA = leaseA.lockId;
      // record A's lease on the run row (mirrors what workflow-runner does).
      dbA.prepare(
        "UPDATE runs SET lease_lock_id = ?, lease_token = ?, lease_domain_key = ? WHERE run_id = ?",
      ).run(lockIdA, lockIdA, f.domainKey, f.runIdA);
    } finally {
      dbA.close();
    }
    // simulate A pausing past the lease window.
    expireLease(f.dbPath, lockIdA);
    // B now tries to acquire — should succeed (expired lease soft-released).
    const dbB = openDb(f.dbPath);
    try {
      const leaseB = acquireDomainLock(dbB, {
        domainKey: f.domainKey,
        repoId: f.repoId,
        domain: f.domain,
        runId: f.runIdB,
        pid: process.pid + 1,
        hostname: hostname(),
      });
      expect(leaseB.lockId).toBeGreaterThan(lockIdA);
      // A's row was soft-released (release_reason='expired') so B's INSERT
      // satisfies the partial unique index.
      const expired = dbB
        .prepare(
          "SELECT release_reason FROM domain_locks WHERE lock_id = ?",
        )
        .get(lockIdA) as { release_reason: string };
      expect(expired.release_reason).toBe("expired");
      leaseB.release({ reason: "test-cleanup" });
    } finally {
      dbB.close();
    }
  });

  it("a non-expired lease blocks a second acquire with DomainLockBusyError", () => {
    const f = setup();
    const dbA = openDb(f.dbPath);
    try {
      acquireDomainLock(dbA, {
        domainKey: f.domainKey,
        repoId: f.repoId,
        domain: f.domain,
        runId: f.runIdA,
        pid: process.pid,
        hostname: hostname(),
      });
      const dbB = openDb(f.dbPath);
      try {
        expect(() =>
          acquireDomainLock(dbB, {
            domainKey: f.domainKey,
            repoId: f.repoId,
            domain: f.domain,
            runId: f.runIdB,
            pid: process.pid + 1,
            hostname: hostname(),
          }),
        ).toThrow(DomainLockBusyError);
      } finally {
        dbB.close();
      }
    } finally {
      dbA.close();
    }
  });

  it(
    "stale writer A — assertActiveLease throws LeaseGuardFailedError after " +
      "B steals the lease",
    () => {
      const f = setup();
      const dbA = openDb(f.dbPath);
      let lockIdA: number;
      try {
        const leaseA = acquireDomainLock(dbA, {
          domainKey: f.domainKey,
          repoId: f.repoId,
          domain: f.domain,
          runId: f.runIdA,
          pid: process.pid,
          hostname: hostname(),
        });
        lockIdA = leaseA.lockId;
        dbA.prepare(
          "UPDATE runs SET lease_lock_id = ?, lease_token = ?, lease_domain_key = ? WHERE run_id = ?",
        ).run(lockIdA, lockIdA, f.domainKey, f.runIdA);
        // before the steal, A's own guard succeeds.
        expect(() => assertActiveLease(dbA, f.runIdA)).not.toThrow();
        expireLease(f.dbPath, lockIdA);
        const dbB = openDb(f.dbPath);
        try {
          acquireDomainLock(dbB, {
            domainKey: f.domainKey,
            repoId: f.repoId,
            domain: f.domain,
            runId: f.runIdB,
            pid: process.pid + 1,
            hostname: hostname(),
          });
        } finally {
          dbB.close();
        }
        // A's guard now fails — its lease is no longer the active one.
        expect(() => assertActiveLease(dbA, f.runIdA)).toThrow(
          LeaseGuardFailedError,
        );
        // heartbeat() from A's still-open handle also throws LeaseLostError.
        expect(() => leaseA.heartbeat()).toThrow(LeaseLostError);
      } finally {
        dbA.close();
      }
    },
  );

  it(
    "forceFailFinalize with lostLockId guard — flips A's run only when " +
      "the run still carries A's lost lockId",
    () => {
      const f = setup();
      const dbA = openDb(f.dbPath);
      try {
        // Pretend A held lock 42 and B held lock 99.
        const lockIdA = 42;
        const lockIdB = 99;
        dbA.prepare(
          "UPDATE runs SET lease_lock_id = ? WHERE run_id = ?",
        ).run(lockIdA, f.runIdA);
        // A's recovery: lostLockId matches → flip happens.
        const r1 = new RunRepository(dbA).forceFailFinalize({
          runId: f.runIdA,
          finishedAt: "2026-05-24T01:00:00Z",
          reason: "lease_lost",
          errorMessage: "lease 42 stolen",
          lostLockId: lockIdA,
        });
        expect(r1.changed).toBe(true);
        const r1row = dbA
          .prepare("SELECT status FROM runs WHERE run_id = ?")
          .get(f.runIdA) as { status: string };
        expect(r1row.status).toBe("failed-internal-error");

        // Now simulate a *different* run row that was reacquired by a new
        // attempt under lock 99; A's stale recovery for lock 42 must NOT
        // flip B's live row.
        dbA.prepare(
          "UPDATE runs SET lease_lock_id = ?, status = 'running' WHERE run_id = ?",
        ).run(lockIdB, f.runIdB);
        const r2 = new RunRepository(dbA).forceFailFinalize({
          runId: f.runIdB,
          finishedAt: "2026-05-24T01:01:00Z",
          reason: "lease_lost",
          errorMessage: "stale recovery from a different lock",
          lostLockId: lockIdA, // mismatch
        });
        expect(r2.changed).toBe(false);
        const r2row = dbA
          .prepare("SELECT status FROM runs WHERE run_id = ?")
          .get(f.runIdB) as { status: string };
        expect(r2row.status).toBe("running"); // untouched
      } finally {
        dbA.close();
      }
    },
  );

  it(
    "db doctor orphan SQL fixtures — NOT EXISTS NULL-safe form returns " +
      "expected rows",
    () => {
      const f = setup();
      const db = openDb(f.dbPath);
      try {
        // Setup: A holds an expired lease that was never released; B holds
        // an active lease for a different run.
        const lockA = acquireDomainLock(db, {
          domainKey: f.domainKey,
          repoId: f.repoId,
          domain: f.domain,
          runId: f.runIdA,
          pid: process.pid,
          hostname: hostname(),
        });
        db.prepare(
          "UPDATE runs SET lease_lock_id = ?, status = 'coding' WHERE run_id = ?",
        ).run(lockA.lockId, f.runIdA);
        // Age out A's lease without releasing it.
        db.prepare(
          "UPDATE domain_locks SET expires_at = '1970-01-01T00:00:00Z', heartbeat_at = '1970-01-01T00:00:00Z' WHERE lock_id = ?",
        ).run(lockA.lockId);

        // Phase 10 db doctor SQL: expired-but-not-released
        const expired = db
          .prepare(
            `SELECT lock_id FROM domain_locks
              WHERE released_at IS NULL
                AND expires_at < datetime('now', '-1 minute')`,
          )
          .all() as { lock_id: number }[];
        expect(expired.map((r) => r.lock_id)).toContain(lockA.lockId);

        // Phase 10 db doctor SQL: orphan in-progress run (NOT EXISTS form).
        // A's row claims lease_lock_id = lockA but the lease is no longer
        // released_at IS NULL — wait, the row is still released_at IS NULL
        // (we didn't release it). So this query should NOT report A as orphan
        // until a steal soft-releases the row. Steal it now via another
        // acquire.
        acquireDomainLock(db, {
          domainKey: f.domainKey,
          repoId: f.repoId,
          domain: f.domain,
          runId: f.runIdB,
          pid: process.pid + 1,
          hostname: hostname(),
        });
        const orphans = db
          .prepare(
            `SELECT r.run_id FROM runs r
              WHERE r.status = 'coding'
                AND NOT EXISTS (
                  SELECT 1 FROM domain_locks dl
                  WHERE dl.lock_id = r.lease_lock_id
                    AND dl.released_at IS NULL
                )`,
          )
          .all() as { run_id: string }[];
        expect(orphans.map((r) => r.run_id)).toContain(f.runIdA);
      } finally {
        db.close();
      }
    },
  );

  it("env override HARNESS_LOCK_LEASE_MS shortens lease for tests", async () => {
    const prev = process.env.HARNESS_LOCK_LEASE_MS;
    process.env.HARNESS_LOCK_LEASE_MS = "50";
    try {
      const f = setup();
      const db = openDb(f.dbPath);
      try {
        const lease = acquireDomainLock(db, {
          domainKey: f.domainKey,
          repoId: f.repoId,
          domain: f.domain,
          runId: f.runIdA,
          pid: process.pid,
          hostname: hostname(),
        });
        const row = db
          .prepare(
            "SELECT acquired_at, expires_at FROM domain_locks WHERE lock_id = ?",
          )
          .get(lease.lockId) as { acquired_at: string; expires_at: string };
        const acq = Date.parse(row.acquired_at);
        const exp = Date.parse(row.expires_at);
        expect(exp - acq).toBeLessThanOrEqual(1000); // ≈ 50ms
        expect(exp - acq).toBeGreaterThanOrEqual(0);
      } finally {
        db.close();
      }
    } finally {
      if (prev === undefined) delete process.env.HARNESS_LOCK_LEASE_MS;
      else process.env.HARNESS_LOCK_LEASE_MS = prev;
    }
  });
});
