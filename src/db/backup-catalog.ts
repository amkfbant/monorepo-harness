import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

/**
 * `backup_catalog` repository (Phase 15-4).
 *
 * Records DB backup snapshot metadata (manifest + sha256 + counts).
 * Pairs with existing `harness db backup` (Phase 6) to give backups a
 * proper queryable catalog. Verify / restore are integrated in
 * Phase 15-8 CLI minimum.
 */

export type BackupStatus = "available" | "missing" | "failed";

export interface BackupManifest {
  backupId: string;
  createdAt: string;
  schemaVersion: number;
  sourceDbPath: string;
  sqliteSha256: string;
  sizeBytes: number;
  counts: Record<string, number>;
}

export interface BackupRow {
  backupId: string;
  path: string;
  createdAt: string;
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
  verifiedAt: string | null;
  status: BackupStatus;
  manifestJson: string;
}

export function recordBackup(
  db: Database.Database,
  input: {
    backupId: string;
    path: string;
    schemaVersion: number;
    sizeBytes: number;
    sha256: string;
    manifest: BackupManifest;
    now?: Date;
  },
): BackupRow {
  const now = (input.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO backup_catalog
       (backup_id, path, created_at, schema_version, size_bytes,
        sha256, verified_at, status, manifest_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'available', ?)`,
  ).run(
    input.backupId,
    input.path,
    now,
    input.schemaVersion,
    input.sizeBytes,
    input.sha256,
    JSON.stringify(input.manifest),
  );
  return findBackup(db, input.backupId) as BackupRow;
}

export function findBackup(
  db: Database.Database,
  backupId: string,
): BackupRow | null {
  const row = db
    .prepare(
      `SELECT backup_id, path, created_at, schema_version, size_bytes,
              sha256, verified_at, status, manifest_json
         FROM backup_catalog
        WHERE backup_id = ?`,
    )
    .get(backupId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toRow(row);
}

export function listBackups(
  db: Database.Database,
  opts: { limit?: number } = {},
): BackupRow[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const rows = db
    .prepare(
      `SELECT * FROM backup_catalog
        ORDER BY created_at DESC LIMIT ${limit}`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toRow);
}

/**
 * Stamp `verified_at` directly. Phase 15 post-close fix (codex P1.3):
 * `markBackupVerified` no longer takes a backup row that has not been
 * checked at the filesystem level. Use `verifyBackup` for the full
 * check; this raw stamp remains exported for tests / callers that have
 * already performed verification out-of-band.
 */
export function markBackupVerified(
  db: Database.Database,
  backupId: string,
  now: Date = new Date(),
): boolean {
  const info = db
    .prepare(
      `UPDATE backup_catalog SET verified_at = ? WHERE backup_id = ?`,
    )
    .run(now.toISOString(), backupId);
  return info.changes > 0;
}

export type BackupVerifyOutcome =
  | { status: "verified"; verifiedAt: string; sizeBytes: number; sha256: string }
  | {
      status: "missing";
      reason: "no_catalog_row" | "file_absent";
    }
  | {
      status: "failed";
      reason: "size_mismatch" | "sha_mismatch";
      expected: { sizeBytes: number; sha256: string };
      actual: { sizeBytes: number; sha256: string };
    };

/**
 * Phase 15 post-close fix (codex P1.3): actually verify the backup file
 * before stamping `verified_at`. Re-hashes the file, compares against
 * the catalog row's `sha256` + `size_bytes`, and only writes
 * `verified_at` on a clean match. On size/sha mismatch, the catalog row
 * is marked status='failed' so `upgrade-check` can no longer treat the
 * backup as ready. On a missing file, status='missing'.
 *
 * The earlier `markBackupVerified` blindly stamped `verified_at` with no
 * checks, which let `upgrade-check` declare readiness on a corrupted or
 * absent backup.
 */
export async function verifyBackup(
  db: Database.Database,
  backupId: string,
  now: Date = new Date(),
): Promise<BackupVerifyOutcome> {
  const row = findBackup(db, backupId);
  if (row === null) {
    return { status: "missing", reason: "no_catalog_row" };
  }
  let actualSize: number;
  try {
    const s = await stat(row.path);
    actualSize = s.size;
  } catch {
    markBackupStatus(db, backupId, "missing");
    return { status: "missing", reason: "file_absent" };
  }
  if (actualSize !== row.sizeBytes) {
    markBackupStatus(db, backupId, "failed");
    return {
      status: "failed",
      reason: "size_mismatch",
      expected: { sizeBytes: row.sizeBytes, sha256: row.sha256 },
      actual: { sizeBytes: actualSize, sha256: "" },
    };
  }
  const body = await readFile(row.path);
  const actualSha = createHash("sha256").update(body).digest("hex");
  if (actualSha !== row.sha256) {
    markBackupStatus(db, backupId, "failed");
    return {
      status: "failed",
      reason: "sha_mismatch",
      expected: { sizeBytes: row.sizeBytes, sha256: row.sha256 },
      actual: { sizeBytes: actualSize, sha256: actualSha },
    };
  }
  const verifiedAt = now.toISOString();
  db.prepare(
    `UPDATE backup_catalog SET verified_at = ?, status = 'available' WHERE backup_id = ?`,
  ).run(verifiedAt, backupId);
  return { status: "verified", verifiedAt, sizeBytes: actualSize, sha256: actualSha };
}

export function markBackupStatus(
  db: Database.Database,
  backupId: string,
  status: BackupStatus,
): boolean {
  const info = db
    .prepare(`UPDATE backup_catalog SET status = ? WHERE backup_id = ?`)
    .run(status, backupId);
  return info.changes > 0;
}

/**
 * Rotate backups: keep the N most recent `available` rows, mark older
 * ones `missing` (so the CLI/operator can delete the file later). The
 * file deletion itself is not done here — the catalog acts as the
 * authoritative state.
 */
export function rotateBackups(
  db: Database.Database,
  keepN: number,
): { rotated: string[] } {
  const rows = db
    .prepare(
      `SELECT backup_id FROM backup_catalog
        WHERE status = 'available'
        ORDER BY created_at DESC`,
    )
    .all() as { backup_id: string }[];
  const rotated: string[] = [];
  for (let i = keepN; i < rows.length; i++) {
    const id = rows[i]!.backup_id;
    db.prepare(`UPDATE backup_catalog SET status = 'missing' WHERE backup_id = ?`).run(
      id,
    );
    rotated.push(id);
  }
  return { rotated };
}

function toRow(r: Record<string, unknown>): BackupRow {
  return {
    backupId: r.backup_id as string,
    path: r.path as string,
    createdAt: r.created_at as string,
    schemaVersion: r.schema_version as number,
    sizeBytes: r.size_bytes as number,
    sha256: r.sha256 as string,
    verifiedAt: (r.verified_at as string | null) ?? null,
    status: r.status as BackupStatus,
    manifestJson: r.manifest_json as string,
  };
}
