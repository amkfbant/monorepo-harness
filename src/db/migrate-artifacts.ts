import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { storeArtifactBlob } from "./artifact-blobs.js";
import { DB_RECONSTRUCTED } from "./run-artifacts.js";

/**
 * Artifact body backfill (Phase 8-3) — `harness db migrate-artifacts`.
 *
 * Phase 8-2 stores new runs' artifact bodies in the DB. This brings the
 * *existing* file-backed artifact bodies (Phase 7 runs, `storage='file'`)
 * into `artifact_blobs` so a DB-only deployment can read them.
 *
 * It is idempotent (a `storage='db'` row is never re-processed) and
 * resumable (each artifact is migrated in its own transaction, so a crash
 * leaves the already-migrated rows done). `meta.json` / `events.jsonl` /
 * `review-decision.yaml` are skipped — their body is reconstructed from
 * the canonical `runs` / `run_events` / `review_decisions` rows.
 *
 * Artifacts whose file is gone are marked `body_status='missing'` and
 * reported; the file IO never aborts the whole backfill.
 */

export interface MigrateArtifactsReport {
  /** `storage='file'` artifacts considered (excludes DB-reconstructed). */
  total: number;
  /** bodies successfully ingested into `artifact_blobs`. */
  migrated: number;
  /** artifacts whose backing file is gone (marked `missing`). */
  missing: number;
  /** artifacts with a null run_id / relative_path (cannot resolve a path). */
  unresolvable: number;
  /** per-artifact notes (missing files, hash mismatches). */
  issues: { artifactId: string; reason: string }[];
}

export function migrateArtifacts(
  db: Database.Database,
  opts: { runsDir: string },
): MigrateArtifactsReport {
  const report: MigrateArtifactsReport = {
    total: 0,
    migrated: 0,
    missing: 0,
    unresolvable: 0,
    issues: [],
  };
  const rows = db
    .prepare(
      `SELECT artifact_id, run_id, relative_path, sha256
       FROM artifacts WHERE storage = 'file'`,
    )
    .all() as {
    artifact_id: string;
    run_id: string | null;
    relative_path: string | null;
    sha256: string;
  }[];

  const markMissing = db.prepare(
    "UPDATE artifacts SET body_status = 'missing' WHERE artifact_id = ?",
  );
  const promote = db.prepare(
    `UPDATE artifacts
       SET storage = 'db', blob_sha256 = ?, body_status = ?, sha256 = ?,
           bytes = ?
     WHERE artifact_id = ?`,
  );

  for (const row of rows) {
    // `meta.json` / `events.jsonl` / `review-decision.yaml` are exported
    // from other DB tables — never blob-backed.
    if (
      row.relative_path !== null &&
      DB_RECONSTRUCTED.has(row.relative_path)
    ) {
      continue;
    }
    report.total += 1;
    if (row.run_id === null || row.relative_path === null) {
      report.unresolvable += 1;
      report.issues.push({
        artifactId: row.artifact_id,
        reason: "null run_id or relative_path — cannot resolve a file",
      });
      continue;
    }
    const abs = join(opts.runsDir, row.run_id, row.relative_path);
    if (!existsSync(abs)) {
      report.missing += 1;
      report.issues.push({
        artifactId: row.artifact_id,
        reason: `backing file is gone: ${row.relative_path}`,
      });
      markMissing.run(row.artifact_id);
      continue;
    }
    const raw = readFileSync(abs);
    db.transaction(() => {
      const blob = storeArtifactBlob(db, raw);
      promote.run(
        blob.sha256,
        blob.truncated ? "truncated" : "db_available",
        blob.sha256,
        blob.bytes,
        row.artifact_id,
      );
      // the recorded sha was stale (the file changed since the manifest
      // was written) — surface it, but the current file content wins.
      if (blob.sha256 !== row.sha256) {
        report.issues.push({
          artifactId: row.artifact_id,
          reason: "file content changed since the manifest was recorded",
        });
      }
    })();
    report.migrated += 1;
  }
  return report;
}

/** Render a `MigrateArtifactsReport` as a human-readable block. */
export function formatMigrateArtifacts(r: MigrateArtifactsReport): string {
  const lines = [
    "db migrate-artifacts:",
    `  considered: ${r.total}`,
    `  migrated:   ${r.migrated}`,
    `  missing:    ${r.missing}`,
    `  unresolvable: ${r.unresolvable}`,
  ];
  for (const i of r.issues) lines.push(`  - ${i.artifactId}: ${i.reason}`);
  return `${lines.join("\n")}\n`;
}
