import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { migrateArtifacts } from "../../../src/db/migrate-artifacts.js";
import { readArtifactBlob } from "../../../src/db/artifact-blobs.js";

/** Phase 8-3 — file-backed artifact body backfill. */

function setup(): { root: string; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), "harness-mig-art-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { root, db };
}

/** Seed a file-backed `artifacts` row (Phase 7 style) + its run-dir file. */
function seedFileArtifact(
  root: string,
  db: Database.Database,
  runId: string,
  name: string,
  body: string,
): void {
  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, name), body);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
       content_type, bytes, sha256, storage, body_status)
     VALUES (?, ?, 'other', ?, 'text/plain', ?, ?, 'file', 'legacy_file')`,
  ).run(`${runId}:${name}`, runId, name, body.length, "stale-sha");
}

describe("migrateArtifacts", () => {
  it("backfills a file-backed artifact body into the DB", () => {
    const { root, db } = setup();
    seedFileArtifact(root, db, "run-x", "codex-output.log", "codex ran\n");

    const report = migrateArtifacts(db, { runsDir: join(root, "runs") });
    expect(report.migrated).toBe(1);
    expect(report.missing).toBe(0);

    const row = db
      .prepare(
        "SELECT storage, blob_sha256, body_status FROM artifacts WHERE artifact_id = ?",
      )
      .get("run-x:codex-output.log") as {
      storage: string;
      blob_sha256: string;
      body_status: string;
    };
    expect(row.storage).toBe("db");
    expect(row.body_status).toBe("db_available");
    expect(readArtifactBlob(db, row.blob_sha256)?.toString()).toBe(
      "codex ran\n",
    );
    db.close();
  });

  it("is idempotent — a second run migrates nothing", () => {
    const { root, db } = setup();
    seedFileArtifact(root, db, "run-x", "summary.md", "# s\n");
    migrateArtifacts(db, { runsDir: join(root, "runs") });
    const again = migrateArtifacts(db, { runsDir: join(root, "runs") });
    expect(again.total).toBe(0);
    expect(again.migrated).toBe(0);
    db.close();
  });

  it("marks an artifact whose file is gone as missing", () => {
    const { root, db } = setup();
    seedFileArtifact(root, db, "run-x", "codex-output.log", "x\n");
    rmSync(join(root, "runs", "run-x", "codex-output.log"));
    const report = migrateArtifacts(db, { runsDir: join(root, "runs") });
    expect(report.missing).toBe(1);
    expect(report.migrated).toBe(0);
    const row = db
      .prepare("SELECT body_status FROM artifacts WHERE artifact_id = ?")
      .get("run-x:codex-output.log") as { body_status: string };
    expect(row.body_status).toBe("missing");
    db.close();
  });

  it("skips meta.json / events.jsonl (reconstructed from other tables)", () => {
    const { root, db } = setup();
    seedFileArtifact(root, db, "run-x", "meta.json", '{"runId":"run-x"}\n');
    const report = migrateArtifacts(db, { runsDir: join(root, "runs") });
    // meta.json is DB-reconstructed — not counted, not blob-backed
    expect(report.total).toBe(0);
    const row = db
      .prepare("SELECT storage FROM artifacts WHERE artifact_id = ?")
      .get("run-x:meta.json") as { storage: string };
    expect(row.storage).toBe("file");
    db.close();
  });

  it("reports a stale recorded sha as a content-changed issue", () => {
    const { root, db } = setup();
    // seedFileArtifact records sha256='stale-sha' which won't match the file
    seedFileArtifact(root, db, "run-x", "final-diff.patch", "diff body\n");
    const report = migrateArtifacts(db, { runsDir: join(root, "runs") });
    expect(report.migrated).toBe(1);
    expect(
      report.issues.some((i) => i.reason.includes("content changed")),
    ).toBe(true);
    db.close();
  });
});
