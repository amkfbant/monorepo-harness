import process from "node:process";
import { existsSync, statSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openDb, openDbReadonly, DbError } from "../db/connection.js";
import { runMigrations, readSchemaVersion } from "../db/migrations.js";
import { runFullImport, formatImportReport } from "../db/import-files.js";
import {
  checkConsistency,
  formatConsistencyReport,
} from "../db/consistency.js";
import {
  exportFiles,
  formatBulkExport,
  type ExportScope,
} from "../db/export-bulk.js";
import {
  migrateArtifacts,
  formatMigrateArtifacts,
} from "../db/migrate-artifacts.js";
import { migrateLegacy, formatMigrateLegacy } from "../db/migrate-legacy.js";
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
} from "../db/maintenance.js";
import {
  withMaintenanceLock,
  withMaintenanceLockAsync,
  MaintenanceLockBusyError,
  type LockMode,
} from "../db/maintenance-lock.js";

function getHarnessRoot(): string {
  return process.env.HARNESS_ROOT ?? process.cwd();
}

function dbError(e: unknown): never {
  if (e instanceof DbError) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  if (e instanceof MaintenanceLockBusyError) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

/**
 * Resolve the maintenance lock timeout from `--wait` / `--timeout <ms>`.
 * `--wait` (no value) waits up to one hour; `--timeout <ms>` overrides.
 * Without either, the default in `acquire()` (30s) is used.
 */
function lockTimeoutMs(raw: Record<string, unknown>): number | undefined {
  if (raw.timeout !== undefined) {
    const n = Number(raw.timeout);
    if (!Number.isFinite(n) || n < 0) {
      process.stderr.write(
        `harness error: --timeout must be a non-negative number of milliseconds\n`,
      );
      process.exit(1);
    }
    return n;
  }
  if (raw.wait === true) return 60 * 60 * 1000; // 1 hour — effectively wait
  return undefined;
}

function lockPathFor(root: string): string {
  return harnessPaths(root).dbLockPath;
}

/** Wrap a synchronous db CLI action with the maintenance lock. */
function withLock(
  mode: LockMode,
  raw: Record<string, unknown>,
  fn: () => void,
): void {
  const root = getHarnessRoot();
  withMaintenanceLock(
    { path: lockPathFor(root), mode, ...(lockTimeoutMs(raw) !== undefined
      ? { timeoutMs: lockTimeoutMs(raw) as number } : {}) },
    fn,
  );
}

/** Async variant for actions that await. */
function withLockAsync(
  mode: LockMode,
  raw: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const root = getHarnessRoot();
  return withMaintenanceLockAsync(
    { path: lockPathFor(root), mode, ...(lockTimeoutMs(raw) !== undefined
      ? { timeoutMs: lockTimeoutMs(raw) as number } : {}) },
    fn,
  );
}

/**
 * Register the `harness db ...` command group.
 *
 * Phase 6 added init / migrate / status / import / check-consistency
 * (read model). Phase 7 added export-files (DB-first write path). Phase 8
 * added migrate-artifacts / migrate-legacy and the operational commands
 * backup / restore / checkpoint / vacuum / stats (runtime DB complete).
 */
export function registerDbCommands(program: Command): void {
  const dbCmd = program
    .command("db")
    .description(
      "harness DB — runtime-canonical store + read model (.harness/harness.sqlite)",
    );

  dbCmd
    .command("init")
    .description("create .harness/harness.sqlite and apply the schema")
    .option("--wait", "wait for the maintenance lock instead of failing fast")
    .option("--timeout <ms>", "override the maintenance lock wait (ms)")
    .action((raw: Record<string, unknown>) => {
      withLock("exclusive", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        try {
          const db = openDb(dbPath);
          try {
            const r = runMigrations(db);
            process.stdout.write(
              `db init: ${dbPath}\n` +
                `schema version: ${r.version}` +
                (r.applied.length > 0
                  ? ` (applied ${r.applied.join(", ")})\n`
                  : " (already current)\n"),
            );
          } finally {
            db.close();
          }
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("migrate")
    .description("apply any pending schema migrations")
    .option("--wait", "wait for the maintenance lock instead of failing fast")
    .option("--timeout <ms>", "override the maintenance lock wait (ms)")
    .action((raw: Record<string, unknown>) => {
      withLock("exclusive", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        try {
          const db = openDb(dbPath);
          try {
            const r = runMigrations(db);
            process.stdout.write(
              r.applied.length > 0
                ? `db migrate: applied ${r.applied.join(", ")} → schema version ${r.version}\n`
                : `db migrate: already at schema version ${r.version}\n`,
            );
          } finally {
            db.close();
          }
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("import")
    .description("build the DB read model from harness files")
    .option(
      "--from-files",
      "import from runs/ projects/ policies/ backlog/ docs/knowledge",
    )
    .option("--reset", "empty every data table before importing")
    .option(
      "--force-legacy-reconcile",
      "overwrite DB-first rows from files (disaster recovery only)",
    )
    .option("--json", "print the import report as JSON")
    .option("--wait", "wait for the maintenance lock instead of failing fast")
    .option("--timeout <ms>", "override the maintenance lock wait (ms)")
    .action((raw: Record<string, unknown>) => {
      if (raw.fromFiles !== true) {
        process.stderr.write(
          "harness error: 'db import' requires --from-files\n",
        );
        process.exit(1);
      }
      withLock("exclusive", raw, () => {
        const root = getHarnessRoot();
        const { dbPath } = harnessPaths(root);
        try {
          const db = openDb(dbPath);
          try {
            // ensure the schema exists so `db import` works without a
            // separate `db init` step.
            runMigrations(db);
            const report = runFullImport(db, {
              harnessRoot: root,
              reset: raw.reset === true,
              forceLegacyReconcile: raw.forceLegacyReconcile === true,
            });
            process.stdout.write(
              raw.json === true
                ? `${JSON.stringify(report, null, 2)}\n`
                : formatImportReport(report),
            );
          } finally {
            db.close();
          }
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("export-files")
    .description("re-export the compatibility files from DB-canonical rows")
    .option("--scope <scope>", "run | backlog | knowledge (default: all)")
    .option(
      "--id <id>",
      "restrict to one id (requires --scope; run id / item id / " +
        "for knowledge: the run id whose decision sidecar to re-project)",
    )
    .option("--json", "print the export report as JSON")
    .action((raw: Record<string, unknown>) => {
      const scope = raw.scope as string | undefined;
      if (
        scope !== undefined &&
        scope !== "run" &&
        scope !== "backlog" &&
        scope !== "knowledge"
      ) {
        process.stderr.write(
          "harness error: --scope must be run | backlog | knowledge\n",
        );
        process.exit(1);
      }
      if (raw.id !== undefined && scope === undefined) {
        process.stderr.write("harness error: --id requires --scope\n");
        process.exit(1);
      }
      let exitWithFailure = false;
      withLock("shared", raw, () => {
        const root = getHarnessRoot();
        const { dbPath } = harnessPaths(root);
        try {
          const db = openDb(dbPath);
          let results;
          try {
            runMigrations(db);
            results = exportFiles(db, {
              harnessRoot: root,
              ...(scope !== undefined ? { scope: scope as ExportScope } : {}),
              ...(raw.id !== undefined ? { id: String(raw.id) } : {}),
            });
          } finally {
            db.close();
          }
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(results, null, 2)}\n`
              : formatBulkExport(results),
          );
          // a failed export is a non-zero exit so CI can gate on it
          if (results.some((r) => r.failed > 0)) exitWithFailure = true;
        } catch (e) {
          dbError(e);
        }
      });
      if (exitWithFailure) process.exit(1);
    });

  dbCmd
    .command("migrate-artifacts")
    .description("backfill file-backed artifact bodies into the DB (Phase 8)")
    .option("--json", "print the migration report as JSON")
    .option("--wait", "wait for the maintenance lock instead of failing fast")
    .option("--timeout <ms>", "override the maintenance lock wait (ms)")
    .action((raw: Record<string, unknown>) => {
      withLock("exclusive", raw, () => {
        const root = getHarnessRoot();
        const paths = harnessPaths(root);
        try {
          const db = openDb(paths.dbPath);
          let report;
          try {
            runMigrations(db);
            report = migrateArtifacts(db, { runsDir: paths.runsDir });
          } finally {
            db.close();
          }
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(report, null, 2)}\n`
              : formatMigrateArtifacts(report),
          );
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("migrate-legacy")
    .description(
      "convert legacy-file runtime rows to db-first (Phase 8 migration)",
    )
    .option("--json", "print the migration report as JSON")
    .option("--wait", "wait for the maintenance lock instead of failing fast")
    .option("--timeout <ms>", "override the maintenance lock wait (ms)")
    .action((raw: Record<string, unknown>) => {
      withLock("exclusive", raw, () => {
        const root = getHarnessRoot();
        const paths = harnessPaths(root);
        try {
          const db = openDb(paths.dbPath);
          let report;
          try {
            runMigrations(db);
            report = migrateLegacy(db, { runsDir: paths.runsDir });
          } finally {
            db.close();
          }
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(report, null, 2)}\n`
              : formatMigrateLegacy(report),
          );
        } catch (e) {
          dbError(e);
        }
      });
    });

  dbCmd
    .command("check-consistency")
    .description("report where the DB has drifted from harness files")
    .option("--json", "print the consistency report as JSON")
    .action((raw: Record<string, unknown>) => {
      let exitWithFailure = false;
      withLock("shared", raw, () => {
        const root = getHarnessRoot();
        const { dbPath } = harnessPaths(root);
        if (!existsSync(dbPath)) {
          process.stderr.write(
            "harness error: DB not initialized — run 'harness db import --from-files'\n",
          );
          process.exit(1);
        }
        try {
          const db = openDbReadonly(dbPath);
          let report;
          try {
            report = checkConsistency({ db, harnessRoot: root });
          } finally {
            db.close();
          }
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(report, null, 2)}\n`
              : formatConsistencyReport(report),
          );
          // non-zero exit on drift/missing so CI can gate on it
          if (report.status !== "ok") exitWithFailure = true;
        } catch (e) {
          dbError(e);
        }
      });
      if (exitWithFailure) process.exit(1);
    });

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
