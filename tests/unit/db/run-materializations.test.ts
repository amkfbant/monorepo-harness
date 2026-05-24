import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordScratchMaterialization,
  markScratchCleaned,
  markScratchFailed,
  listActiveScratchForRun,
  listExpiredActiveScratch,
} from "../../../src/db/repositories/run-materializations.js";

function freshDb(): { db: ReturnType<typeof openDb>; runId: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-runmat-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  const runId = "run-test-1";
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
    JSON.stringify({ runId }),
  );
  return { db, runId, dbPath };
}

describe("run_materializations repository (Phase 10-3)", () => {
  it("recordScratchMaterialization inserts a status='active' row", () => {
    const f = freshDb();
    try {
      const id = recordScratchMaterialization(f.db, {
        runId: f.runId,
        path: "/tmp/scratch/run-test-1",
        reason: "test",
        ttlMs: 60_000,
        now: new Date("2026-05-24T10:00:00Z"),
      });
      expect(id).toBeGreaterThan(0);
      const rows = listActiveScratchForRun(f.db, f.runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("active");
      expect(rows[0]?.path).toBe("/tmp/scratch/run-test-1");
      expect(rows[0]?.reason).toBe("test");
      expect(rows[0]?.expiresAt).toBe("2026-05-24T10:01:00.000Z");
    } finally {
      f.db.close();
    }
  });

  it("recordScratchMaterialization without ttlMs leaves expires_at NULL", () => {
    const f = freshDb();
    try {
      const id = recordScratchMaterialization(f.db, {
        runId: f.runId,
        path: "/tmp/scratch/run-test-1",
        reason: "no-ttl",
      });
      const rows = listActiveScratchForRun(f.db, f.runId);
      expect(rows[0]?.expiresAt).toBeNull();
      expect(rows[0]?.materializationId).toBe(id);
    } finally {
      f.db.close();
    }
  });

  it("markScratchCleaned flips active → cleaned and is idempotent", () => {
    const f = freshDb();
    try {
      const id = recordScratchMaterialization(f.db, {
        runId: f.runId,
        path: "/tmp/scratch/run-test-1",
        reason: "test",
      });
      markScratchCleaned(f.db, id, new Date("2026-05-24T11:00:00Z"));
      markScratchCleaned(f.db, id, new Date("2026-05-24T12:00:00Z")); // no-op
      const row = f.db
        .prepare(
          "SELECT status, cleaned_at FROM run_materializations WHERE materialization_id = ?",
        )
        .get(id) as { status: string; cleaned_at: string };
      expect(row.status).toBe("cleaned");
      expect(row.cleaned_at).toBe("2026-05-24T11:00:00.000Z");
      expect(listActiveScratchForRun(f.db, f.runId)).toHaveLength(0);
    } finally {
      f.db.close();
    }
  });

  it("markScratchFailed records error_message", () => {
    const f = freshDb();
    try {
      const id = recordScratchMaterialization(f.db, {
        runId: f.runId,
        path: "/tmp/scratch/run-test-1",
        reason: "test",
      });
      markScratchFailed(f.db, id, "rm failed: EBUSY", new Date("2026-05-24T11:30:00Z"));
      const row = f.db
        .prepare(
          "SELECT status, error_message FROM run_materializations WHERE materialization_id = ?",
        )
        .get(id) as { status: string; error_message: string };
      expect(row.status).toBe("failed");
      expect(row.error_message).toBe("rm failed: EBUSY");
    } finally {
      f.db.close();
    }
  });

  it("listExpiredActiveScratch returns only TTL-expired active rows", () => {
    const f = freshDb();
    try {
      const idExpired = recordScratchMaterialization(f.db, {
        runId: f.runId,
        path: "/tmp/scratch/expired",
        reason: "test",
        ttlMs: 1000,
        now: new Date("2026-05-24T10:00:00Z"),
      });
      const idFresh = recordScratchMaterialization(f.db, {
        runId: f.runId,
        path: "/tmp/scratch/fresh",
        reason: "test",
        ttlMs: 60_000,
        now: new Date("2026-05-24T10:00:00Z"),
      });
      const idNoTtl = recordScratchMaterialization(f.db, {
        runId: f.runId,
        path: "/tmp/scratch/no-ttl",
        reason: "test",
      });
      const now = new Date("2026-05-24T10:00:30Z"); // 30s later
      const expired = listExpiredActiveScratch(f.db, now);
      const ids = expired.map((r) => r.materializationId);
      expect(ids).toContain(idExpired);
      expect(ids).not.toContain(idFresh);
      expect(ids).not.toContain(idNoTtl);
    } finally {
      f.db.close();
    }
  });

  it("invariant: scratch insert does not touch exported_files / runs.export_status", () => {
    const f = freshDb();
    try {
      const before = f.db
        .prepare("SELECT export_status FROM runs WHERE run_id = ?")
        .get(f.runId) as { export_status: string };
      expect(before.export_status).toBe("disabled");
      const beforeFiles = f.db
        .prepare("SELECT COUNT(*) AS c FROM exported_files WHERE scope_id = ?")
        .get(f.runId) as { c: number };
      expect(beforeFiles.c).toBe(0);

      recordScratchMaterialization(f.db, {
        runId: f.runId,
        path: "/tmp/scratch/run-test-1",
        reason: "invariant-test",
      });

      const after = f.db
        .prepare("SELECT export_status FROM runs WHERE run_id = ?")
        .get(f.runId) as { export_status: string };
      expect(after.export_status).toBe("disabled");
      const afterFiles = f.db
        .prepare("SELECT COUNT(*) AS c FROM exported_files WHERE scope_id = ?")
        .get(f.runId) as { c: number };
      expect(afterFiles.c).toBe(0);
    } finally {
      f.db.close();
    }
  });
});
