import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { RunRepository } from "../../src/db/repositories/runs.js";
import { hostname } from "node:os";
import {
  acquireDomainLock,
  assertActiveLease,
  LeaseGuardFailedError,
} from "../../src/workspace/db-domain-lock.js";

/**
 * Phase 9 post-close (second review) P1-6 — when a lease is stolen
 * mid-run, `RunLog.finalize` can no longer flip the run row through the
 * fencing guard. `RunRepository.forceFailFinalize` is the recovery path:
 * it bypasses `assertActiveLease` and uses an expected-status guard so
 * a lease-lost run still reaches `failed-internal-error` rather than
 * rotting at `running`.
 */

function setupRun(): {
  dbPath: string;
  runId: string;
  domainKey: string;
} {
  const root = mkdtempSync(join(tmpdir(), "harness-leasefin-"));
  const dbPath = join(root, ".harness", "harness.sqlite");
  const runId = "run-20260523-apps-user-lease1";
  const domainKey = "t::apps/user";
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, started_at,
         updated_at, meta_json)
       VALUES (?, 't', 'apps/user', 'domain-coding', 'main',
         'running', 'db-first', 1, 'disabled', ?, ?, ?)`,
    ).run(
      runId,
      "2026-05-23T00:00:00Z",
      "2026-05-23T00:00:00Z",
      JSON.stringify({ runId, status: "running" }),
    );
  } finally {
    db.close();
  }
  return { dbPath, runId, domainKey };
}

describe("lease stolen → clean finalize (Phase 9 post-close P1-6)", () => {
  it(
    "forceFailFinalize flips a 'running' run to failed-internal-error " +
      "without the lease guard",
    () => {
      const { dbPath, runId } = setupRun();
      const db = openDb(dbPath);
      try {
        const r = new RunRepository(db).forceFailFinalize({
          runId,
          finishedAt: "2026-05-23T01:00:00Z",
          reason: "lease_lost",
          errorMessage: "lease stolen by pid 999",
        });
        expect(r.changed).toBe(true);
        const row = db
          .prepare("SELECT status FROM runs WHERE run_id = ?")
          .get(runId) as { status: string };
        expect(row.status).toBe("failed-internal-error");
        // a lease_lost event was appended for the audit log
        const ev = db
          .prepare(
            "SELECT type FROM run_events WHERE run_id = ? ORDER BY seq",
          )
          .all(runId) as { type: string }[];
        expect(ev.some((e) => e.type === "lease_lost")).toBe(true);
      } finally {
        db.close();
      }
    },
  );

  it("forceFailFinalize is a no-op on an already-terminal run", () => {
    const { dbPath, runId } = setupRun();
    const db = openDb(dbPath);
    try {
      // flip to a terminal status manually
      db.prepare(
        "UPDATE runs SET status = 'approved' WHERE run_id = ?",
      ).run(runId);
      const r = new RunRepository(db).forceFailFinalize({
        runId,
        finishedAt: "2026-05-23T01:00:00Z",
        reason: "lease_lost",
        errorMessage: "boom",
      });
      expect(r.changed).toBe(false);
      const row = db
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(runId) as { status: string };
      expect(row.status).toBe("approved");
    } finally {
      db.close();
    }
  });

  it(
    "assertActiveLease throws after another acquire steals the lease — " +
      "and forceFailFinalize is the only working write path",
    () => {
      const { dbPath, runId, domainKey } = setupRun();
      const db = openDb(dbPath);
      try {
        // original holder
        const first = acquireDomainLock(db, {
          domainKey,
          repoId: "t",
          domain: "apps/user",
          runId,
          pid: 100,
          hostname: hostname(),
        });
        // stamp the run with the original fencing token
        db.prepare(
          `UPDATE runs SET lease_lock_id = ?, lease_token = ?,
             lease_domain_key = ?
           WHERE run_id = ?`,
        ).run(first.lockId, first.fencingToken, domainKey, runId);
        // simulate lease theft: force-release + re-acquire under a different
        // runId. The original holder's lease_lock_id no longer matches
        // any active domain_locks row, so assertActiveLease for it throws.
        first.release({ reason: "stolen", releasedBy: "test" });
        const thief = acquireDomainLock(db, {
          domainKey,
          repoId: "t",
          domain: "apps/user",
          runId: "run-thief",
          pid: 200,
          hostname: hostname(),
        });
        expect(thief.fencingToken).not.toBe(first.fencingToken);
        // assertActiveLease must now reject writes from the original run
        expect(() => assertActiveLease(db, runId)).toThrow(
          LeaseGuardFailedError,
        );
        // but forceFailFinalize still flips the row — that's the recovery
        const r = new RunRepository(db).forceFailFinalize({
          runId,
          finishedAt: "2026-05-23T02:00:00Z",
          reason: "lease_lost",
          errorMessage: "lease stolen",
        });
        expect(r.changed).toBe(true);
        const row = db
          .prepare("SELECT status FROM runs WHERE run_id = ?")
          .get(runId) as { status: string };
        expect(row.status).toBe("failed-internal-error");
        thief.release({ reason: "test", releasedBy: "test" });
      } finally {
        db.close();
      }
    },
  );
});
