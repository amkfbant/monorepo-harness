import type Database from "better-sqlite3";

/**
 * `archive_catalog` repository (Phase 15-5).
 *
 * Archive DB は古い runs / blobs / operations を別 SQLite file に移す
 * mechanism。Phase 15-5 minimum はその catalog 管理のみ — 実 archive
 * build (copy-only / move) は post-Phase-15 (or 別 sub-phase) で
 * 統合する。catalog があれば read-time fallback (Phase 16+ で query
 * include-archives) と dashboard 表示が成立する。
 */

export type ArchiveStatus = "attached" | "detached" | "missing";

export interface ArchiveRow {
  archiveId: string;
  path: string;
  createdAt: string;
  rangeStart: string | null;
  rangeEnd: string | null;
  schemaVersion: number;
  sha256: string | null;
  status: ArchiveStatus;
  metadataJson: string;
}

export function recordArchive(
  db: Database.Database,
  input: {
    archiveId: string;
    path: string;
    rangeStart?: string;
    rangeEnd?: string;
    schemaVersion: number;
    sha256?: string;
    metadata?: Record<string, unknown>;
    status?: ArchiveStatus;
    now?: Date;
  },
): ArchiveRow {
  const now = (input.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO archive_catalog
       (archive_id, path, created_at, range_start, range_end,
        schema_version, sha256, status, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.archiveId,
    input.path,
    now,
    input.rangeStart ?? null,
    input.rangeEnd ?? null,
    input.schemaVersion,
    input.sha256 ?? null,
    input.status ?? "attached",
    JSON.stringify(input.metadata ?? {}),
  );
  return findArchive(db, input.archiveId) as ArchiveRow;
}

export function findArchive(
  db: Database.Database,
  archiveId: string,
): ArchiveRow | null {
  const row = db
    .prepare(
      `SELECT archive_id, path, created_at, range_start, range_end,
              schema_version, sha256, status, metadata_json
         FROM archive_catalog
        WHERE archive_id = ?`,
    )
    .get(archiveId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toRow(row);
}

export function listArchives(
  db: Database.Database,
  opts: { status?: ArchiveStatus } = {},
): ArchiveRow[] {
  const sql = opts.status !== undefined
    ? `SELECT * FROM archive_catalog WHERE status = ?
        ORDER BY created_at DESC`
    : `SELECT * FROM archive_catalog ORDER BY created_at DESC`;
  const rows =
    opts.status !== undefined
      ? (db.prepare(sql).all(opts.status) as Record<string, unknown>[])
      : (db.prepare(sql).all() as Record<string, unknown>[]);
  return rows.map(toRow);
}

export function setArchiveStatus(
  db: Database.Database,
  archiveId: string,
  status: ArchiveStatus,
): boolean {
  const info = db
    .prepare(
      `UPDATE archive_catalog SET status = ? WHERE archive_id = ?`,
    )
    .run(status, archiveId);
  return info.changes > 0;
}

function toRow(r: Record<string, unknown>): ArchiveRow {
  return {
    archiveId: r.archive_id as string,
    path: r.path as string,
    createdAt: r.created_at as string,
    rangeStart: (r.range_start as string | null) ?? null,
    rangeEnd: (r.range_end as string | null) ?? null,
    schemaVersion: r.schema_version as number,
    sha256: (r.sha256 as string | null) ?? null,
    status: r.status as ArchiveStatus,
    metadataJson: r.metadata_json as string,
  };
}
