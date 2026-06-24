import process from "node:process";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { openDb, openDbReadonly } from "../../db/connection.js";
import { runMigrations } from "../../db/migrations.js";
import { registerBlobStore, listBlobStores } from "../../db/blob-stores.js";
import {
  migrateBlobsToExternal,
  verifyExternalBlobs,
  gcExternalBlobs,
} from "../../storage/blob-migration.js";
import { getHarnessRoot, withLock, withLockAsync } from "./shared.js";
import {
  defaultLocalStoreId,
  localStoreFromDb,
  migrateExternalBlobsToDb,
} from "./blob-helpers.js";

/**
 * `harness db` blob-store / 外部 blob migration コマンド（#125 A15: cli/db.ts から
 * behaviour-zero 分割）。blob-store(add local / list) / migrate-blobs / verify-blobs /
 * gc-blobs。registration 順は golden で凍結。
 */
export function registerDbBlobCommands(dbCmd: Command): void {
  const blobStoreCmd = dbCmd
    .command("blob-store")
    .description("manage configured blob stores");
  const blobStoreAdd = blobStoreCmd.command("add").description("add a blob store");
  blobStoreAdd
    .command("local")
    .description("add/update a local filesystem blob store")
    .requiredOption("--id <store-id>", "blob store id")
    .requiredOption("--path <path>", "local object root")
    .option("--json", "print JSON", false)
    .action((raw: Record<string, unknown>) => {
      withLock("exclusive", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        const db = openDb(dbPath);
        try {
          runMigrations(db);
          const row = registerBlobStore(db, {
            storeId: String(raw.id),
            storeType: "local",
            config: { root: String(raw.path) },
          });
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(row, null, 2)}\n`
              : `blob-store local: ${row.storeId} root=${String(raw.path)}\n`,
          );
        } finally {
          db.close();
        }
      });
    });
  blobStoreCmd
    .command("list")
    .description("list blob stores")
    .option("--json", "print JSON", false)
    .action((raw: Record<string, unknown>) => {
      withLock("shared", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        const db = openDbReadonly(dbPath);
        try {
          const rows = listBlobStores(db);
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(rows, null, 2)}\n`
              : rows.map((r) => `${r.storeId}\t${r.storeType}\t${r.status}\n`).join(""),
          );
        } finally {
          db.close();
        }
      });
    });

  dbCmd
    .command("migrate-blobs")
    .description("migrate artifact blobs between DB and external local store")
    .requiredOption("--to <target>", "external | db")
    .option("--store <store-id>", "blob store id")
    .option("--limit <n>", "max rows for DB→external", "50")
    .option("--dry-run", "plan without writes", false)
    .option("--json", "print JSON", false)
    .action(async (raw: Record<string, unknown>) => {
      await withLockAsync("exclusive", raw, async () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        const db = openDb(dbPath);
        try {
          runMigrations(db);
          const target = String(raw.to);
          if (target !== "external" && target !== "db") {
            process.stderr.write("harness error: --to must be external | db\n");
            process.exit(1);
          }
          const storeId =
            raw.store !== undefined
              ? String(raw.store)
              : defaultLocalStoreId(db);
          const store = localStoreFromDb(db, storeId);
          if (target === "external") {
            const result = await migrateBlobsToExternal(db, store, {
              storeId,
              limit: Number(raw.limit),
              dryRun: raw.dryRun === true,
            });
            let flipped = 0;
            if (raw.dryRun !== true) {
              flipped = db
                .prepare(
                  `UPDATE artifacts
                      SET storage = 'external',
                          body_status = CASE
                            WHEN body_status = 'truncated'
                            THEN 'truncated'
                            ELSE 'external_available'
                          END
                    WHERE storage = 'db'
                      AND blob_sha256 IN (
                        SELECT sha256 FROM external_artifact_blobs
                        WHERE store_id = ? AND status = 'available'
                      )`,
                )
                .run(storeId).changes;
            }
            const out = { ...result, flippedArtifacts: flipped };
            process.stdout.write(
              raw.json === true
                ? `${JSON.stringify(out, null, 2)}\n`
                : `migrate-blobs: uploaded=${result.uploadedCount} skipped=${result.skippedCount} failed=${result.failedCount} flipped=${flipped}\n`,
            );
          } else {
            const result = await migrateExternalBlobsToDb(db, store, {
              storeId,
              dryRun: raw.dryRun === true,
            });
            process.stdout.write(
              raw.json === true
                ? `${JSON.stringify(result, null, 2)}\n`
                : `migrate-blobs: restored=${result.restored} failed=${result.failed}\n`,
            );
          }
        } finally {
          db.close();
        }
      });
    });

  dbCmd
    .command("verify-blobs")
    .description("verify external artifact blobs")
    .option("--store <store-id>", "blob store id")
    .option("--deep", "read and hash object bodies", false)
    .option("--json", "print JSON", false)
    .action(async (raw: Record<string, unknown>) => {
      await withLockAsync("shared", raw, async () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        const db = openDb(dbPath);
        try {
          runMigrations(db);
          const storeId =
            raw.store !== undefined
              ? String(raw.store)
              : defaultLocalStoreId(db);
          const result = await verifyExternalBlobs(
            db,
            localStoreFromDb(db, storeId),
            { storeId, deep: raw.deep === true },
          );
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(result, null, 2)}\n`
              : `verify-blobs: checked=${result.checkedCount} ok=${result.okCount} missing=${result.missingCount} corrupt=${result.corruptCount}\n`,
          );
          if (result.missingCount + result.corruptCount > 0) process.exitCode = 1;
        } finally {
          db.close();
        }
      });
    });

  dbCmd
    .command("gc-blobs")
    .description("garbage-collect unreferenced external blob rows")
    .option("--store <store-id>", "blob store id")
    .option("--dry-run", "plan only", false)
    .option("--apply", "delete DB rows", false)
    .option("--delete-objects", "also delete objects from the store", false)
    .option("--json", "print JSON", false)
    .action(async (raw: Record<string, unknown>) => {
      await withLockAsync(raw.apply === true ? "exclusive" : "shared", raw, async () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        const db = openDb(dbPath);
        try {
          runMigrations(db);
          const storeId =
            raw.store !== undefined
              ? String(raw.store)
              : defaultLocalStoreId(db);
          const result = await gcExternalBlobs(db, localStoreFromDb(db, storeId), {
            apply: raw.apply === true,
            deleteObjects: raw.deleteObjects === true,
            storeId,
          });
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(result, null, 2)}\n`
              : `gc-blobs: candidates=${result.candidates.length} removed=${result.removed.length} dryRun=${result.dryRun}\n`,
          );
        } finally {
          db.close();
        }
      });
    });
}
