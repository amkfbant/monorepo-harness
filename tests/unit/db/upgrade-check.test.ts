import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { SCHEMA_VERSION } from "../../../src/db/schema.js";
import { runUpgradeCheck } from "../../../src/db/upgrade-check.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-up-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("runUpgradeCheck (Phase 15-7)", () => {
  it("clean DB → overall 'ready' + 9 checks all ready or info", () => {
    const db = freshDb();
    try {
      const r = runUpgradeCheck(db, "phase16");
      expect(r.target).toBe("phase16");
      expect(r.currentSchemaVersion).toBe(SCHEMA_VERSION);
      expect(r.expectedSchemaVersion).toBe(SCHEMA_VERSION);
      expect(r.overall).toBe("ready");
      expect(r.checks.length).toBeGreaterThanOrEqual(9);
      const blocked = r.checks.filter((c) => c.status === "blocked");
      expect(blocked).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("dirty asset_exports → 'assets.conflicts' warn → overall='warn'", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO asset_exports
           (asset_type, asset_id, revision_id, relative_path, sha256,
            exported_at, status)
         VALUES ('project_profile', 'mini', 1, 'projects/mini.yaml',
                 's', '2026-05-24T13:00:00Z', 'dirty')`,
      ).run();
      const r = runUpgradeCheck(db, "phase16");
      expect(r.overall).toBe("warn");
      const c = r.checks.find((x) => x.id === "assets.conflicts");
      expect(c?.status).toBe("warn");
    } finally {
      db.close();
    }
  });

  it("legacy-file runs → 'legacy.runtime_rows' blocked → overall='blocked'", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, started_at,
           updated_at)
         VALUES ('run-leg', 'r', 'd', 'domain-coding', 'main',
           'needs_review', 'legacy-file', 1, 'disabled',
           '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')`,
      ).run();
      const r = runUpgradeCheck(db, "phase16");
      expect(r.overall).toBe("blocked");
      const c = r.checks.find((x) => x.id === "legacy.runtime_rows");
      expect(c?.status).toBe("blocked");
    } finally {
      db.close();
    }
  });
});
