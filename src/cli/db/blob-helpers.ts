import process from "node:process";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  findBlobStore,
  listBlobStores,
} from "../../db/blob-stores.js";
import { verifyExternalBlobs } from "../../storage/blob-migration.js";
import { LocalBlobStore } from "../../storage/local-blob-store.js";
import { storeArtifactBlob } from "../../db/artifact-blobs.js";

/**
 * `harness db` blob-store ヘルパー（#125 A15: cli/db.ts から behaviour-zero 分割）。
 * blob-commands と doctor-commands（deep verify）が共有。挙動は db.ts 由来で不変。
 */
export function defaultLocalStoreId(db: Database.Database): string {
  const row = listBlobStores(db).find(
    (s) => s.storeType === "local" && s.status === "active",
  );
  if (row === undefined) {
    process.stderr.write(
      "harness error: no active local blob store; run 'harness db blob-store add local --id <id> --path <path>'\n",
    );
    process.exit(1);
  }
  return row.storeId;
}

export function localStoreFromDb(
  db: Database.Database,
  storeId: string,
): LocalBlobStore {
  const row = findBlobStore(db, storeId);
  if (row === null) {
    process.stderr.write(`harness error: unknown blob store ${storeId}\n`);
    process.exit(1);
  }
  if (row.storeType !== "local") {
    process.stderr.write(`harness error: blob store ${storeId} is ${row.storeType}, expected local\n`);
    process.exit(1);
  }
  const config = JSON.parse(row.configJson) as { root?: unknown };
  if (typeof config.root !== "string") {
    process.stderr.write(`harness error: blob store ${storeId} has no local root\n`);
    process.exit(1);
  }
  return new LocalBlobStore({ root: config.root });
}

export async function verifyLocalStoresDeep(
  db: Database.Database,
): Promise<unknown[]> {
  const rows = listBlobStores(db).filter(
    (s) => s.storeType === "local" && s.status === "active",
  );
  const results: unknown[] = [];
  for (const row of rows) {
    results.push(
      await verifyExternalBlobs(db, localStoreFromDb(db, row.storeId), {
        storeId: row.storeId,
        deep: true,
      }),
    );
  }
  return results;
}

export async function migrateExternalBlobsToDb(
  db: Database.Database,
  store: LocalBlobStore,
  opts: { storeId: string; dryRun: boolean },
): Promise<{ storeId: string; restored: number; failed: number; details: unknown[] }> {
  const rows = db
    .prepare(
      `SELECT a.artifact_id, a.blob_sha256, e.uri
         FROM artifacts a
         INNER JOIN external_artifact_blobs e ON e.sha256 = a.blob_sha256
        WHERE a.storage = 'external'
          AND e.store_id = ?
          AND e.status = 'available'
          AND a.blob_sha256 IS NOT NULL`,
    )
    .all(opts.storeId) as { artifact_id: string; blob_sha256: string; uri: string }[];
  let restored = 0;
  let failed = 0;
  const details: unknown[] = [];
  for (const row of rows) {
    try {
      if (!opts.dryRun) {
        const body = await store.get({ sha256: row.blob_sha256, uri: row.uri });
        const actualSha = createHash("sha256").update(body).digest("hex");
        if (actualSha !== row.blob_sha256) {
          throw new Error(
            `external blob content mismatch: expected ${row.blob_sha256}, got ${actualSha}`,
          );
        }
        storeArtifactBlob(db, body);
        db.prepare(
          `UPDATE artifacts
              SET storage = 'db',
                  body_status = CASE
                    WHEN body_status = 'truncated'
                    THEN 'truncated'
                    ELSE 'db_available'
                  END
            WHERE artifact_id = ?`,
        ).run(row.artifact_id);
      }
      restored++;
      details.push({ artifactId: row.artifact_id, status: "restored" });
    } catch (e) {
      failed++;
      details.push({
        artifactId: row.artifact_id,
        status: "failed",
        error: (e as Error).message,
      });
    }
  }
  return { storeId: opts.storeId, restored, failed, details };
}
