import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordStatsSnapshot,
  listStatsSnapshots,
  getStatsSnapshot,
  computeStatsDelta,
} from "../../../src/db/stats-snapshots.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-stats-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("db_stats_snapshots repository (Phase 15-6)", () => {
  it("recordStatsSnapshot + getStatsSnapshot round-trip", () => {
    const db = freshDb();
    try {
      const r = recordStatsSnapshot(
        db,
        { runs: 100, blobs: 500 },
        new Date("2026-05-24T13:00:00Z"),
      );
      expect(r.snapshotId).toBeGreaterThan(0);
      const back = getStatsSnapshot(db, r.snapshotId);
      expect(JSON.parse(back!.statsJson)).toEqual({ runs: 100, blobs: 500 });
    } finally {
      db.close();
    }
  });

  it("listStatsSnapshots newest first + since filter", () => {
    const db = freshDb();
    try {
      recordStatsSnapshot(db, { n: 1 }, new Date("2026-05-20T00:00:00Z"));
      recordStatsSnapshot(db, { n: 2 }, new Date("2026-05-22T00:00:00Z"));
      recordStatsSnapshot(db, { n: 3 }, new Date("2026-05-24T00:00:00Z"));
      const all = listStatsSnapshots(db);
      expect(all.map((s) => JSON.parse(s.statsJson).n)).toEqual([3, 2, 1]);
      const since = listStatsSnapshots(db, {
        since: new Date("2026-05-21T00:00:00Z"),
      });
      expect(since.map((s) => JSON.parse(s.statsJson).n)).toEqual([3, 2]);
    } finally {
      db.close();
    }
  });

  it("computeStatsDelta: numeric fields differ, skip non-numeric", () => {
    const older = {
      snapshotId: 1,
      createdAt: "t1",
      statsJson: JSON.stringify({ runs: 100, blobs: 500, label: "a" }),
    };
    const newer = {
      snapshotId: 2,
      createdAt: "t2",
      statsJson: JSON.stringify({ runs: 150, blobs: 600, label: "b" }),
    };
    const d = computeStatsDelta(older, newer);
    expect(d).toEqual({ runs: 50, blobs: 100 });
  });
});
