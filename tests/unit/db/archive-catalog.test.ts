import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordArchive,
  findArchive,
  listArchives,
  setArchiveStatus,
} from "../../../src/db/archive-catalog.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-ar-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("archive_catalog repository (Phase 15-5)", () => {
  it("record + find round-trip", () => {
    const db = freshDb();
    try {
      const r = recordArchive(db, {
        archiveId: "ar-2026q1",
        path: ".harness/archives/2026q1.sqlite",
        rangeStart: "2025-10-01T00:00:00Z",
        rangeEnd: "2025-12-31T23:59:59Z",
        schemaVersion: 10,
        sha256: "x",
        metadata: { runs: 100 },
      });
      expect(r.status).toBe("attached");
      expect(findArchive(db, "ar-2026q1")?.rangeStart).toBe(
        "2025-10-01T00:00:00Z",
      );
    } finally {
      db.close();
    }
  });

  it("listArchives newest first + status filter", () => {
    const db = freshDb();
    try {
      recordArchive(db, {
        archiveId: "ar-a",
        path: "x",
        schemaVersion: 10,
        now: new Date("2025-01-01T00:00:00Z"),
      });
      recordArchive(db, {
        archiveId: "ar-b",
        path: "y",
        schemaVersion: 10,
        now: new Date("2026-01-01T00:00:00Z"),
        status: "detached",
      });
      const all = listArchives(db);
      expect(all[0]?.archiveId).toBe("ar-b");
      const detached = listArchives(db, { status: "detached" });
      expect(detached).toHaveLength(1);
      expect(detached[0]?.archiveId).toBe("ar-b");
    } finally {
      db.close();
    }
  });

  it("setArchiveStatus updates", () => {
    const db = freshDb();
    try {
      recordArchive(db, {
        archiveId: "ar-x",
        path: "x",
        schemaVersion: 10,
      });
      expect(setArchiveStatus(db, "ar-x", "missing")).toBe(true);
      expect(findArchive(db, "ar-x")?.status).toBe("missing");
    } finally {
      db.close();
    }
  });
});
