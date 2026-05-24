import type Database from "better-sqlite3";

/**
 * `asset_exports` repository (Phase 14-5).
 *
 * Tracks which compat-export file currently mirrors which revision +
 * sha. `computeAssetStatus()` compares the on-disk sha vs the
 * exported sha and the current revision to derive synced / dirty file
 * / dirty DB / conflict / removed / missing.
 */

export type AssetType =
  | "project_profile"
  | "policy_template"
  | "effective_policy"
  | "knowledge_entry";

export type AssetExportStatus = "synced" | "dirty" | "removed";

export type AssetStatus =
  | "synced"
  | "dirty-file"
  | "dirty-db"
  | "conflict"
  | "removed"
  | "missing";

export interface AssetExportRow {
  exportId: number;
  assetType: AssetType;
  assetId: string;
  revisionId: number;
  relativePath: string;
  sha256: string;
  exportedAt: string;
  status: AssetExportStatus;
}

export function recordAssetExport(
  db: Database.Database,
  input: {
    assetType: AssetType;
    assetId: string;
    revisionId: number;
    relativePath: string;
    sha256: string;
    now?: Date;
  },
): AssetExportRow {
  const now = (input.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO asset_exports
       (asset_type, asset_id, revision_id, relative_path, sha256,
        exported_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(asset_type, asset_id, relative_path) DO UPDATE SET
       revision_id = excluded.revision_id,
       sha256 = excluded.sha256,
       exported_at = excluded.exported_at,
       status = 'synced'`,
  ).run(
    input.assetType,
    input.assetId,
    input.revisionId,
    input.relativePath,
    input.sha256,
    now,
  );
  return findAssetExport(
    db,
    input.assetType,
    input.assetId,
    input.relativePath,
  ) as AssetExportRow;
}

export function findAssetExport(
  db: Database.Database,
  assetType: AssetType,
  assetId: string,
  relativePath: string,
): AssetExportRow | null {
  const row = db
    .prepare(
      `SELECT export_id, asset_type, asset_id, revision_id, relative_path,
              sha256, exported_at, status
         FROM asset_exports
        WHERE asset_type = ? AND asset_id = ? AND relative_path = ?`,
    )
    .get(assetType, assetId, relativePath) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : toRow(row);
}

export function listAssetExports(
  db: Database.Database,
  filter: { assetType?: AssetType } = {},
): AssetExportRow[] {
  const rows = filter.assetType !== undefined
    ? (db
        .prepare(
          `SELECT * FROM asset_exports WHERE asset_type = ?
            ORDER BY asset_type, asset_id`,
        )
        .all(filter.assetType) as Record<string, unknown>[])
    : (db
        .prepare(`SELECT * FROM asset_exports ORDER BY asset_type, asset_id`)
        .all() as Record<string, unknown>[]);
  return rows.map(toRow);
}

/**
 * Compute the asset status given:
 *   - fileSha: sha256 of the file on disk, or null if file is absent
 *   - currentRevSha: sha256 of the asset's current DB revision body,
 *                    or null if the asset has no current revision
 *
 * Combined with the `asset_exports` row (if any), the truth table
 * resolves to one of the six AssetStatus values.
 */
export function computeAssetStatus(input: {
  exportRow: AssetExportRow | null;
  fileSha: string | null;
  currentRevSha: string | null;
}): AssetStatus {
  const { exportRow, fileSha, currentRevSha } = input;
  // Phase 14 post-close fix (codex P1.2): "no DB row => missing" must
  // come first. Without this, exportRow != null && currentRevSha == null
  // (a deleted/never-created DB revision with leftover export rows)
  // would fall through into the dirty-db / conflict branch and lie.
  if (currentRevSha === null) return "missing";
  if (exportRow === null) {
    // DB has a current revision but no export yet — missing export.
    return "missing";
  }
  if (fileSha === null) return "removed";
  const fileMatchesExported = fileSha === exportRow.sha256;
  const dbUnchanged = currentRevSha === exportRow.sha256;
  if (fileMatchesExported && dbUnchanged) return "synced";
  if (!fileMatchesExported && dbUnchanged) return "dirty-file";
  if (fileMatchesExported && !dbUnchanged) return "dirty-db";
  return "conflict";
}

function toRow(r: Record<string, unknown>): AssetExportRow {
  return {
    exportId: r.export_id as number,
    assetType: r.asset_type as AssetType,
    assetId: r.asset_id as string,
    revisionId: r.revision_id as number,
    relativePath: r.relative_path as string,
    sha256: r.sha256 as string,
    exportedAt: r.exported_at as string,
    status: r.status as AssetExportStatus,
  };
}
