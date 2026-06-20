import process from "node:process";
import { existsSync, statSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { openDbReadonly } from "../../db/connection.js";
import { readSchemaVersion } from "../../db/migrations.js";
import {
  backupDb,
  restoreDb,
  checkpointDb,
  vacuumDb,
  dbStats,
  formatBackup,
  formatRestore,
  formatCheckpoint,
  formatVacuum,
  formatStats,
} from "../../db/maintenance.js";
import { getHarnessRoot, dbError, withLock, withLockAsync } from "./shared.js";

/**
 * `harness db` maintenance/info コマンド（#125 A15: cli/db.ts から behaviour-zero
 * 分割）。backup / restore / checkpoint / vacuum / stats / status。registration 順は
 * golden で凍結。
 */
export function registerDbMaintenanceCommands(dbCmd: Command): void {
  dbCmd
    .command("backup")
    .description("write a consistent standalone copy of the DB")
    .requiredOption("--out <path>", "destination file (must not exist)")
    .option("--json", "print the backup result as JSON")
    .action(async (raw: Record<string, unknown>) => {
      await withLockAsync("shared", raw, async () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        try {
          const r = await backupDb({ dbPath, outPath: String(raw.out) });
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(r, null, 2)}\n`
              : formatBackup(r),
          );
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("restore")
    .description("replace the live DB with a backup (destructive)")
    .requiredOption("--from <path>", "backup file to restore")
    .option(
      "--force",
      "required to overwrite an existing DB — restore is destructive",
    )
    .option("--json", "print the restore result as JSON")
    .option("--wait", "wait for the maintenance lock instead of failing fast")
    .option("--timeout <ms>", "override the maintenance lock wait (ms)")
    .action(async (raw: Record<string, unknown>) => {
      const { dbPath } = harnessPaths(getHarnessRoot());
      // restore replaces the live DB — refuse to clobber an existing one
      // unless --force makes the destructive intent explicit. This check
      // runs BEFORE we acquire the exclusive lock so a wrong invocation
      // never blocks anyone.
      if (existsSync(dbPath) && raw.force !== true) {
        process.stderr.write(
          `harness error: ${dbPath} already exists; 'db restore' overwrites it — ` +
            "pass --force to confirm (back it up first with 'db backup')\n",
        );
        process.exit(1);
      }
      // restore takes the exclusive lock BEFORE opening the DB so any
      // concurrent connection sees the file swap cleanly (§3 A3 of the
      // Phase 9 design).
      await withLockAsync("exclusive", raw, async () => {
        try {
          const r = await restoreDb({ dbPath, fromPath: String(raw.from) });
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(r, null, 2)}\n`
              : formatRestore(r),
          );
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("checkpoint")
    .description("checkpoint the WAL into the main DB and truncate it")
    .option("--json", "print the checkpoint result as JSON")
    .option("--wait", "wait for the maintenance lock instead of failing fast")
    .option("--timeout <ms>", "override the maintenance lock wait (ms)")
    .action((raw: Record<string, unknown>) => {
      // current checkpoint always uses TRUNCATE — requires writer
      // serialization, so exclusive (§3 A3 of the Phase 9 design).
      withLock("exclusive", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        try {
          const r = checkpointDb(dbPath);
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(r, null, 2)}\n`
              : formatCheckpoint(r),
          );
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("vacuum")
    .description("rebuild the DB file, reclaiming freed space")
    .option("--json", "print the vacuum result as JSON")
    .option("--wait", "wait for the maintenance lock instead of failing fast")
    .option("--timeout <ms>", "override the maintenance lock wait (ms)")
    .action((raw: Record<string, unknown>) => {
      withLock("exclusive", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        try {
          const r = vacuumDb(dbPath);
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(r, null, 2)}\n`
              : formatVacuum(r),
          );
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("stats")
    .description("show table row counts, blob totals and on-disk sizes")
    .option("--json", "print the stats as JSON")
    .action((raw: Record<string, unknown>) => {
      withLock("shared", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        try {
          const s = dbStats(dbPath);
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(s, null, 2)}\n`
              : formatStats(s),
          );
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("status")
    .description("show schema version, table count, path and size")
    .action(() => {
      const { dbPath } = harnessPaths(getHarnessRoot());
      if (!existsSync(dbPath)) {
        process.stdout.write(
          `db status: not initialized (${dbPath})\n` +
            `run 'harness db init' to create it\n`,
        );
        return;
      }
      try {
        // read-only: `status` must never create tables or WAL side files.
        const db = openDbReadonly(dbPath);
        let version: number;
        let tables: number;
        try {
          version = readSchemaVersion(db);
          tables = (
            db
              .prepare(
                "SELECT count(*) AS n FROM sqlite_master " +
                  "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
              )
              .get() as { n: number }
          ).n;
        } finally {
          db.close();
        }
        const bytes = statSync(dbPath).size;
        process.stdout.write(
          `db status: ${dbPath}\n` +
            `schema version: ${version}\n` +
            `tables: ${tables}\n` +
            `size: ${bytes} bytes\n`,
        );
      } catch (e) {
        dbError(e);
      }
    });
}
