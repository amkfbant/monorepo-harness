import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { runDoctor } from "../../../src/db/doctor.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-doctor-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("runDoctor (Phase 15-2)", () => {
  it("clean DB → status='ok' + only ok findings per check", () => {
    const db = freshDb();
    try {
      const r = runDoctor(db);
      expect(r.status).toBe("ok");
      expect(r.totals.flagged).toBe(0);
      expect(r.findings.every((f) => f.status === "ok")).toBe(true);
      // also: doctor_runs row was persisted
      const drCount = db
        .prepare("SELECT COUNT(*) AS n FROM doctor_runs")
        .get() as { n: number };
      expect(drCount.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("expired domain_lock + scratch active → status='warn' + flagged findings", () => {
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
      // seed a run so run_materializations FK is satisfiable.
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

      const r = runDoctor(db);
      expect(r.status).toBe("warn");
      const checkIds = r.findings
        .filter((f) => f.status === "flagged")
        .map((f) => f.checkId);
      expect(checkIds).toContain("lock.expired_active");
      expect(checkIds).toContain("scratch.expired");
    } finally {
      db.close();
    }
  });

  it("category filter restricts check set", () => {
    const db = freshDb();
    try {
      const r = runDoctor(db, { category: "locks" });
      // only one check in 'locks' category
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]?.checkId).toBe("lock.expired_active");
    } finally {
      db.close();
    }
  });

  it("dirty asset_export → flagged 'assets.dirty_export'", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO asset_exports
           (asset_type, asset_id, revision_id, relative_path, sha256,
            exported_at, status)
         VALUES ('project_profile', 'mini', 1, 'projects/mini.yaml',
                 'sha-x', '2025-01-01T00:00:00Z', 'dirty')`,
      ).run();
      const r = runDoctor(db);
      const ids = r.findings.filter((f) => f.status === "flagged").map((f) => f.checkId);
      expect(ids).toContain("assets.dirty_export");
    } finally {
      db.close();
    }
  });
});
