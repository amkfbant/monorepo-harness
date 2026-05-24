import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  verifyBackup,
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

  // Phase 15 post-close fix (codex P1.3): verifyBackup actually checks
  // the file (size + sha) and only stamps verified_at on a clean match.
  // A missing file → status=missing. A sha/size mismatch → status=failed
  // (so upgrade-check cannot read it as ready).
  describe("verifyBackup (post-close)", () => {
    it("status=verified when file exists with matching sha + size", async () => {
      const db = freshDb();
      const root = mkdtempSync(join(tmpdir(), "harness-bk-ver-"));
      try {
        const body = Buffer.from("hello backup");
        const path = join(root, "bk.sqlite");
        writeFileSync(path, body);
        const sha = createHash("sha256").update(body).digest("hex");
        recordBackup(db, {
          backupId: "bk-ok",
          path,
          schemaVersion: 10,
          sizeBytes: body.length,
          sha256: sha,
          manifest: manifest("bk-ok"),
        });
        const out = await verifyBackup(
          db,
          "bk-ok",
          new Date("2026-05-24T14:00:00Z"),
        );
        expect(out.status).toBe("verified");
        expect(findBackup(db, "bk-ok")?.verifiedAt).toBe(
          "2026-05-24T14:00:00.000Z",
        );
      } finally {
        db.close();
      }
    });

    it("status=failed (sha_mismatch) when file body diverges → catalog status='failed'", async () => {
      const db = freshDb();
      const root = mkdtempSync(join(tmpdir(), "harness-bk-ver-"));
      try {
        const path = join(root, "bk.sqlite");
        writeFileSync(path, Buffer.from("real body"));
        recordBackup(db, {
          backupId: "bk-bad",
          path,
          schemaVersion: 10,
          sizeBytes: "real body".length,
          sha256: "0".repeat(64), // wrong sha
          manifest: manifest("bk-bad"),
        });
        const out = await verifyBackup(db, "bk-bad");
        expect(out.status).toBe("failed");
        if (out.status === "failed") {
          expect(out.reason).toBe("sha_mismatch");
        }
        expect(findBackup(db, "bk-bad")?.status).toBe("failed");
        expect(findBackup(db, "bk-bad")?.verifiedAt).toBeNull();
      } finally {
        db.close();
      }
    });

    it("status=missing when file is gone → catalog status='missing'", async () => {
      const db = freshDb();
      try {
        recordBackup(db, {
          backupId: "bk-gone",
          path: "/nonexistent/path/bk.sqlite",
          schemaVersion: 10,
          sizeBytes: 1,
          sha256: "0".repeat(64),
          manifest: manifest("bk-gone"),
        });
        const out = await verifyBackup(db, "bk-gone");
        expect(out.status).toBe("missing");
        expect(findBackup(db, "bk-gone")?.status).toBe("missing");
      } finally {
        db.close();
      }
    });
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
