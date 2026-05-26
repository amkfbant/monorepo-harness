import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { runDoctor } from "../../../src/db/doctor.js";
import { runRepair, findRepairFor } from "../../../src/db/repair.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-repair-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("runRepair (Phase 15-3)", () => {
  it("dry-run for lock.release_expired: no DB change + repair_actions row recorded", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO domain_locks
           (domain_key, repo_id, domain, holder_run_id, holder_pid,
            holder_hostname, acquired_at, expires_at, heartbeat_at)
         VALUES ('r::d', 'r', 'd', 'run-x', 1, 'h',
                 '2025-01-01T00:00:00Z',
                 '1970-01-01T00:00:00Z',
                 '2025-01-01T00:00:00Z')`,
      ).run();
      const dr = runDoctor(db);
      const lockFinding = dr.findings.find(
        (f) => f.checkId === "lock.expired_active" && f.status === "flagged",
      );
      expect(lockFinding).toBeTruthy();
      const r = runRepair(db, lockFinding!, { dryRun: true });
      expect(r.dryRun).toBe(true);
      expect(r.status).toBe("succeeded");
      const stillActive = db
        .prepare(
          "SELECT released_at FROM domain_locks WHERE released_at IS NULL",
        )
        .all() as { released_at: string | null }[];
      expect(stillActive).toHaveLength(1); // dry-run did NOT release
      const audit = db
        .prepare("SELECT * FROM repair_actions WHERE dry_run = 1")
        .all();
      expect(audit).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("apply for lock.release_expired: releases lock + repair_actions row dry_run=0", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO domain_locks
           (domain_key, repo_id, domain, holder_run_id, holder_pid,
            holder_hostname, acquired_at, expires_at, heartbeat_at)
         VALUES ('r::d', 'r', 'd', 'run-x', 1, 'h',
                 '2025-01-01T00:00:00Z',
                 '1970-01-01T00:00:00Z',
                 '2025-01-01T00:00:00Z')`,
      ).run();
      const dr = runDoctor(db);
      const lockFinding = dr.findings.find(
        (f) => f.checkId === "lock.expired_active" && f.status === "flagged",
      )!;
      const r = runRepair(db, lockFinding, {
        dryRun: false,
        now: new Date("2026-05-24T13:00:00Z"),
      });
      expect(r.dryRun).toBe(false);
      expect(r.status).toBe("succeeded");
      const released = db
        .prepare(
          "SELECT released_at, release_reason FROM domain_locks WHERE lock_id = ?",
        )
        .get((lockFinding.details!.lock_id as number)) as {
        released_at: string;
        release_reason: string;
      };
      expect(released.released_at).toBe("2026-05-24T13:00:00.000Z");
      expect(released.release_reason).toBe("expired-by-repair");
    } finally {
      db.close();
    }
  });

  it("findRepairFor returns null for non-repairable finding", () => {
    expect(
      findRepairFor({
        checkId: "artifact.blob.missing",
        severity: "error",
        status: "flagged",
        message: "x",
        repairable: false,
      }),
    ).toBeNull();
  });

  it("apply for scratch.cleanup_expired marks scratch as failed", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, started_at,
           updated_at, meta_json)
         VALUES ('run-x', 'r', 'd', 'domain-coding', 'main',
           'running', 'db-first', 1, 'disabled',
           '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO run_materializations
           (run_id, purpose, path, reason, created_at, expires_at, status)
         VALUES ('run-x', 'scratch', '/tmp/x', 'test',
                 '2025-01-01T00:00:00Z', '1970-01-01T00:00:00Z', 'active')`,
      ).run();
      const dr = runDoctor(db);
      const f = dr.findings.find(
        (x) => x.checkId === "scratch.expired" && x.status === "flagged",
      )!;
      const r = runRepair(db, f, { dryRun: false });
      expect(r.status).toBe("succeeded");
      const row = db
        .prepare(
          "SELECT status, error_message FROM run_materializations WHERE materialization_id = ?",
        )
        .get(f.details!.materialization_id as number) as {
        status: string;
        error_message: string;
      };
      expect(row.status).toBe("failed");
      expect(row.error_message).toContain("doctor repair");
    } finally {
      db.close();
    }
  });

  it("apply for operations.mark_stale_failed marks stale operation as failed", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO operations
           (operation_id, command, scope_type, scope_id, created_at,
            operation_type, target_type, target_id, actor, dry_run,
            status, started_at, metadata_json)
         VALUES ('op-stale', 'knowledge.edit', 'knowledge_entry', 'k1',
                 '2025-01-01T00:00:00Z',
                 'knowledge.edit', 'knowledge_entry', 'k1', 'test', 0,
                 'running', '2025-01-01T00:00:00Z', '{}')`,
      ).run();
      const dr = runDoctor(db, { category: "operations" });
      const f = dr.findings.find(
        (x) =>
          x.checkId === "operations.stale_running" && x.status === "flagged",
      )!;
      const r = runRepair(db, f, {
        dryRun: false,
        now: new Date("2026-05-24T13:00:00Z"),
      });
      expect(r.status).toBe("succeeded");
      const row = db
        .prepare(
          "SELECT status, error_code, completed_at FROM operations WHERE operation_id = 'op-stale'",
        )
        .get() as {
        status: string;
        error_code: string;
        completed_at: string;
      };
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("stale-operation");
      expect(row.completed_at).toBe("2026-05-24T13:00:00.000Z");
      const eventCount = db
        .prepare(
          "SELECT COUNT(*) AS n FROM operation_events WHERE operation_id = 'op-stale'",
        )
        .get() as { n: number };
      expect(eventCount.n).toBe(1);
    } finally {
      db.close();
    }
  });

  // Phase 15 post-close fix (codex P1.2): a stale doctor finding must not
  // release a lock that was renewed between doctor and repair. The
  // repair UPDATE now revalidates expires_at < now.
  it("apply for lock.release_expired: skips when lease was renewed after doctor", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO domain_locks
           (domain_key, repo_id, domain, holder_run_id, holder_pid,
            holder_hostname, acquired_at, expires_at, heartbeat_at)
         VALUES ('r::d', 'r', 'd', 'run-x', 1, 'h',
                 '2025-01-01T00:00:00Z',
                 '1970-01-01T00:00:00Z',
                 '2025-01-01T00:00:00Z')`,
      ).run();
      const dr = runDoctor(db);
      const lockFinding = dr.findings.find(
        (f) => f.checkId === "lock.expired_active" && f.status === "flagged",
      )!;

      // Simulate a holder renewal: a healthy holder bumped expires_at
      // far into the future, between doctor and repair.
      db.prepare(
        `UPDATE domain_locks SET expires_at = '9999-01-01T00:00:00.000Z'`,
      ).run();

      const r = runRepair(db, lockFinding, {
        dryRun: false,
        now: new Date("2026-05-24T13:00:00Z"),
      });
      expect(r.status).toBe("failed");
      expect(r.message).toMatch(/renewed/i);
      const released = db
        .prepare("SELECT released_at FROM domain_locks")
        .all() as { released_at: string | null }[];
      expect(released.every((row) => row.released_at === null)).toBe(true);
    } finally {
      db.close();
    }
  });
});
