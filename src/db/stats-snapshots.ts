import type Database from "better-sqlite3";

/**
 * `db_stats_snapshots` repository (Phase 15-6).
 *
 * Phase 6 で `dbStats()` (src/db/maintenance.ts) が live DB stats を
 * 返すが、point-in-time 比較 (`stats delta --since 7d`) には history が
 * 必要。Phase 15-6 はこの snapshot ledger を land する。
 */

export interface DbStatsSnapshot {
  snapshotId: number;
  createdAt: string;
  statsJson: string;
}

export function recordStatsSnapshot(
  db: Database.Database,
  stats: Record<string, unknown>,
  now: Date = new Date(),
): DbStatsSnapshot {
  const info = db
    .prepare(
      `INSERT INTO db_stats_snapshots (created_at, stats_json)
       VALUES (?, ?)`,
    )
    .run(now.toISOString(), JSON.stringify(stats));
  return {
    snapshotId: Number(info.lastInsertRowid),
    createdAt: now.toISOString(),
    statsJson: JSON.stringify(stats),
  };
}

export function listStatsSnapshots(
  db: Database.Database,
  opts: { limit?: number; since?: Date } = {},
): DbStatsSnapshot[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  if (opts.since !== undefined) {
    const rows = db
      .prepare(
        `SELECT snapshot_id, created_at, stats_json
           FROM db_stats_snapshots
          WHERE created_at >= ?
          ORDER BY created_at DESC LIMIT ${limit}`,
      )
      .all(opts.since.toISOString()) as Record<string, unknown>[];
    return rows.map(toSnapshot);
  }
  const rows = db
    .prepare(
      `SELECT snapshot_id, created_at, stats_json
         FROM db_stats_snapshots
        ORDER BY created_at DESC LIMIT ${limit}`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toSnapshot);
}

export function getStatsSnapshot(
  db: Database.Database,
  snapshotId: number,
): DbStatsSnapshot | null {
  const row = db
    .prepare(
      `SELECT snapshot_id, created_at, stats_json
         FROM db_stats_snapshots
        WHERE snapshot_id = ?`,
    )
    .get(snapshotId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toSnapshot(row);
}

/**
 * Compute a numeric-fields delta between two snapshots. Non-numeric or
 * missing fields are skipped. Returns the difference (newer - older).
 */
export function computeStatsDelta(
  older: DbStatsSnapshot,
  newer: DbStatsSnapshot,
): Record<string, number> {
  const olderObj = JSON.parse(older.statsJson) as Record<string, unknown>;
  const newerObj = JSON.parse(newer.statsJson) as Record<string, unknown>;
  const delta: Record<string, number> = {};
  for (const k of Object.keys(newerObj)) {
    const a = newerObj[k];
    const b = olderObj[k];
    if (typeof a === "number" && typeof b === "number") {
      delta[k] = a - b;
    }
  }
  return delta;
}

function toSnapshot(r: Record<string, unknown>): DbStatsSnapshot {
  return {
    snapshotId: r.snapshot_id as number,
    createdAt: r.created_at as string,
    statsJson: r.stats_json as string,
  };
}
