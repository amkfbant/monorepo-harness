import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { storeArtifactBlob } from "../../../src/db/artifact-blobs.js";
import { LocalBlobStore } from "../../../src/storage/local-blob-store.js";
import {
  registerBlobStore,
  findExternalBlob,
  listExternalBlobs,
} from "../../../src/db/blob-stores.js";
import {
  migrateBlobsToExternal,
  verifyExternalBlobs,
  gcExternalBlobs,
} from "../../../src/storage/blob-migration.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-blobmig-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, root };
}

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

describe("blob migration + verify + GC (Phase 16-3..16-5)", () => {
  it("registerBlobStore + migrateBlobsToExternal uploads DB blobs to local store", async () => {
    const { db, root } = freshDb();
    try {
      registerBlobStore(db, {
        storeId: "local-default",
        storeType: "local",
        config: { root: join(root, "blob-store") },
      });
      // seed 2 DB blobs
      const b1 = Buffer.from("hello");
      const b2 = Buffer.from("world world world");
      storeArtifactBlob(db, b1, "identity");
      storeArtifactBlob(db, b2, "identity");

      const store = new LocalBlobStore({ root: join(root, "blob-store") });
      const r = await migrateBlobsToExternal(db, store, {
        storeId: "local-default",
      });
      expect(r.candidatesCount).toBe(2);
      expect(r.uploadedCount).toBe(2);
      expect(r.failedCount).toBe(0);

      // 2 external_artifact_blobs rows recorded as 'available'
      const ext = listExternalBlobs(db, { storeId: "local-default" });
      expect(ext).toHaveLength(2);
      expect(ext.every((e) => e.status === "available")).toBe(true);

      // re-migrating is idempotent
      const r2 = await migrateBlobsToExternal(db, store, {
        storeId: "local-default",
      });
      expect(r2.candidatesCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("verifyExternalBlobs: detects missing object as 'missing'", async () => {
    const { db, root } = freshDb();
    try {
      registerBlobStore(db, {
        storeId: "local-default",
        storeType: "local",
        config: { root: join(root, "blob-store") },
      });
      const b = Buffer.from("data");
      storeArtifactBlob(db, b, "identity");
      const store = new LocalBlobStore({ root: join(root, "blob-store") });
      await migrateBlobsToExternal(db, store, { storeId: "local-default" });
      const s = sha(b);
      // delete the object behind the catalog
      await store.delete({ sha256: s, uri: "" });
      const v = await verifyExternalBlobs(db, store, {
        storeId: "local-default",
      });
      expect(v.missingCount).toBe(1);
      expect(findExternalBlob(db, s)?.status).toBe("missing");
    } finally {
      db.close();
    }
  });

  it("gcExternalBlobs: dry-run lists unreferenced; --apply deletes", async () => {
    const { db, root } = freshDb();
    try {
      registerBlobStore(db, {
        storeId: "local-default",
        storeType: "local",
        config: { root: join(root, "blob-store") },
      });
      const b = Buffer.from("orphan");
      const s = sha(b);
      const store = new LocalBlobStore({ root: join(root, "blob-store") });
      // put external blob + catalog row WITHOUT any artifacts referencing it
      await store.put({ sha256: s, body: b, contentEncoding: "identity" });
      db.prepare(
        `INSERT INTO external_artifact_blobs
           (sha256, store_id, uri, bytes, stored_bytes, content_encoding,
            chunking, uploaded_at, status)
         VALUES (?, 'local-default', 'file://x', ?, ?, 'identity', 'none',
                 '2026-05-24T13:00:00Z', 'available')`,
      ).run(s, b.length, b.length);

      const dry = await gcExternalBlobs(db, store);
      expect(dry.dryRun).toBe(true);
      expect(dry.candidates).toContain(s);
      expect(dry.removed).toHaveLength(0);

      const apply = await gcExternalBlobs(db, store, {
        apply: true,
        deleteObjects: true,
      });
      expect(apply.removed).toContain(s);
      expect(findExternalBlob(db, s)).toBeNull();
    } finally {
      db.close();
    }
  });
});
