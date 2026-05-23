import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { storeArtifactBlob } from "./artifact-blobs.js";
import { sha256 } from "./import/common.js";
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
  /** artifacts whose file could not be read (permission, is a dir, …). */
  unreadable: number;
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
    unreadable: 0,
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
           bytes = ?, original_bytes = ?, original_sha256 = ?
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
    // read the file inside try/catch — a since-deleted file (ENOENT), a
    // path that became a directory, or a permission error is reported per
    // artifact and the backfill continues with the rest (P1).
    let raw: Buffer;
    try {
      raw = readFileSync(abs);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        report.missing += 1;
        report.issues.push({
          artifactId: row.artifact_id,
          reason: `backing file is gone: ${row.relative_path}`,
        });
        markMissing.run(row.artifact_id);
      } else {
        report.unreadable += 1;
        report.issues.push({
          artifactId: row.artifact_id,
          reason: `cannot read ${row.relative_path}: ${err.message}`,
        });
      }
      continue;
    }
    // `artifacts.sha256` is the hash of the RAW file (consistent with
    // `ingestRunArtifacts`); `blob_sha256` is the stored body's address.
    const rawSha = sha256(raw);
    db.transaction(() => {
      const blob = storeArtifactBlob(db, raw);
      promote.run(
        blob.sha256,
        blob.truncated ? "truncated" : "db_available",
        rawSha,
        blob.bytes,
        // Phase 9-9: record the pre-truncation size + sha for audit; both
        // are NULL when the body was not truncated.
        blob.truncated ? raw.length : null,
        blob.truncated ? rawSha : null,
        row.artifact_id,
      );
      // the recorded sha was stale (the file changed since the manifest
      // was written) — surface it, but the current file content wins.
      if (rawSha !== row.sha256) {
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
    `  considered:   ${r.total}`,
    `  migrated:     ${r.migrated}`,
    `  missing:      ${r.missing}`,
    `  unreadable:   ${r.unreadable}`,
    `  unresolvable: ${r.unresolvable}`,
  ];
  for (const i of r.issues) lines.push(`  - ${i.artifactId}: ${i.reason}`);
  return `${lines.join("\n")}\n`;
}
