import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordAssetExport,
  findAssetExport,
  listAssetExports,
  computeAssetStatus,
  type AssetExportRow,
} from "../../../src/db/repositories/asset-exports.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-assets-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("asset_exports repository (Phase 14-5)", () => {
  it("recordAssetExport: insert then update on conflict", () => {
    const db = freshDb();
    try {
      const r1 = recordAssetExport(db, {
        assetType: "project_profile",
        assetId: "mini",
        revisionId: 1,
        relativePath: "projects/mini.yaml",
        sha256: "aaa",
      });
      expect(r1.revisionId).toBe(1);
      expect(r1.status).toBe("synced");

      const r2 = recordAssetExport(db, {
        assetType: "project_profile",
        assetId: "mini",
        revisionId: 2,
        relativePath: "projects/mini.yaml",
        sha256: "bbb",
      });
      expect(r2.revisionId).toBe(2);
      expect(r2.sha256).toBe("bbb");

      // UNIQUE means only 1 row per (asset_type, asset_id, relative_path)
      const all = listAssetExports(db, { assetType: "project_profile" });
      expect(all).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("findAssetExport returns row or null", () => {
    const db = freshDb();
    try {
      expect(
        findAssetExport(db, "project_profile", "mini", "projects/mini.yaml"),
      ).toBeNull();
      recordAssetExport(db, {
        assetType: "project_profile",
        assetId: "mini",
        revisionId: 1,
        relativePath: "projects/mini.yaml",
        sha256: "x",
      });
      const r = findAssetExport(
        db,
        "project_profile",
        "mini",
        "projects/mini.yaml",
      );
      expect(r?.sha256).toBe("x");
    } finally {
      db.close();
    }
  });
});

describe("computeAssetStatus (Phase 14-5)", () => {
  const exp = (sha: string): AssetExportRow => ({
    exportId: 1,
    assetType: "project_profile",
    assetId: "mini",
    revisionId: 1,
    relativePath: "projects/mini.yaml",
    sha256: sha,
    exportedAt: "2026-05-24T12:00:00Z",
    status: "synced",
  });

  it("missing: no export + no current revision", () => {
    expect(
      computeAssetStatus({
        exportRow: null,
        fileSha: null,
        currentRevSha: null,
      }),
    ).toBe("missing");
  });

  it("missing: DB current but no export row", () => {
    expect(
      computeAssetStatus({
        exportRow: null,
        fileSha: "a",
        currentRevSha: "a",
      }),
    ).toBe("missing");
  });

  it("removed: export exists but file is gone", () => {
    expect(
      computeAssetStatus({
        exportRow: exp("a"),
        fileSha: null,
        currentRevSha: "a",
      }),
    ).toBe("removed");
  });

  it("synced: file sha == exported sha == current sha", () => {
    expect(
      computeAssetStatus({
        exportRow: exp("a"),
        fileSha: "a",
        currentRevSha: "a",
      }),
    ).toBe("synced");
  });

  it("dirty-file: file changed, DB unchanged since export", () => {
    expect(
      computeAssetStatus({
        exportRow: exp("a"),
        fileSha: "b",
        currentRevSha: "a",
      }),
    ).toBe("dirty-file");
  });

  it("dirty-db: file unchanged, DB updated since export", () => {
    expect(
      computeAssetStatus({
        exportRow: exp("a"),
        fileSha: "a",
        currentRevSha: "b",
      }),
    ).toBe("dirty-db");
  });

  it("conflict: file changed AND DB updated", () => {
    expect(
      computeAssetStatus({
        exportRow: exp("a"),
        fileSha: "b",
        currentRevSha: "c",
      }),
    ).toBe("conflict");
  });
});
