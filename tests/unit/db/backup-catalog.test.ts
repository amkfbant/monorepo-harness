import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordBackup,
  listBackups,
  findBackup,
  markBackupVerified,
  rotateBackups,
} from "../../../src/db/backup-catalog.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-bk-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

const manifest = (id: string) => ({
  backupId: id,
  createdAt: "2026-05-24T13:00:00Z",
  schemaVersion: 10,
  sourceDbPath: ".harness/harness.sqlite",
  sqliteSha256: id + "-sha",
  sizeBytes: 123,
  counts: { runs: 0 },
});

describe("backup_catalog repository (Phase 15-4)", () => {
  it("recordBackup inserts + findBackup retrieves", () => {
    const db = freshDb();
    try {
      const r = recordBackup(db, {
        backupId: "bk-1",
        path: ".harness/backups/bk-1/harness.sqlite",
        schemaVersion: 10,
        sizeBytes: 123,
        sha256: "sha-1",
        manifest: manifest("bk-1"),
      });
      expect(r.backupId).toBe("bk-1");
      expect(r.status).toBe("available");
      expect(findBackup(db, "bk-1")?.sha256).toBe("sha-1");
    } finally {
      db.close();
    }
  });

  it("listBackups returns newest first", () => {
    const db = freshDb();
    try {
      recordBackup(db, {
        backupId: "bk-old",
        path: "p1",
        schemaVersion: 10,
        sizeBytes: 1,
        sha256: "a",
        manifest: manifest("bk-old"),
        now: new Date("2026-05-20T00:00:00Z"),
      });
      recordBackup(db, {
        backupId: "bk-new",
        path: "p2",
        schemaVersion: 10,
        sizeBytes: 2,
        sha256: "b",
        manifest: manifest("bk-new"),
        now: new Date("2026-05-24T00:00:00Z"),
      });
      const all = listBackups(db);
      expect(all[0]?.backupId).toBe("bk-new");
      expect(all[1]?.backupId).toBe("bk-old");
    } finally {
      db.close();
    }
  });

  it("markBackupVerified sets verified_at", () => {
    const db = freshDb();
    try {
      recordBackup(db, {
        backupId: "bk-v",
        path: "x",
        schemaVersion: 10,
        sizeBytes: 1,
        sha256: "z",
        manifest: manifest("bk-v"),
      });
      expect(markBackupVerified(db, "bk-v", new Date("2026-05-24T14:00:00Z")))
        .toBe(true);
      expect(findBackup(db, "bk-v")?.verifiedAt).toBe(
        "2026-05-24T14:00:00.000Z",
      );
    } finally {
      db.close();
    }
  });

  it("rotateBackups keeps N newest, marks the rest missing", () => {
    const db = freshDb();
    try {
      for (let i = 0; i < 5; i++) {
        recordBackup(db, {
          backupId: `bk-${i}`,
          path: `p${i}`,
          schemaVersion: 10,
          sizeBytes: 1,
          sha256: `s${i}`,
          manifest: manifest(`bk-${i}`),
          now: new Date(`2026-05-2${i}T00:00:00Z`),
        });
      }
      const r = rotateBackups(db, 2);
      expect(r.rotated.sort()).toEqual(["bk-0", "bk-1", "bk-2"].sort());
      const remaining = listBackups(db).filter((b) => b.status === "available");
      expect(remaining).toHaveLength(2);
      expect(remaining.map((b) => b.backupId).sort()).toEqual(
        ["bk-3", "bk-4"].sort(),
      );
    } finally {
      db.close();
    }
  });
});
