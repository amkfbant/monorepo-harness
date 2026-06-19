import process from "node:process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import type Database from "better-sqlite3";
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
import { runDoctor, type DoctorFinding } from "../db/doctor.js";
import { runRepair } from "../db/repair.js";
import { runUpgradeCheck } from "../db/upgrade-check.js";
import { listArchives, recordArchive } from "../db/archive-catalog.js";
import {
  findBlobStore,
  listBlobStores,
  registerBlobStore,
} from "../db/blob-stores.js";
import {
  migrateBlobsToExternal,
  verifyExternalBlobs,
  gcExternalBlobs,
} from "../storage/blob-migration.js";
import { LocalBlobStore } from "../storage/local-blob-store.js";
import { storeArtifactBlob } from "../db/artifact-blobs.js";
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

  const archiveCmd = dbCmd
    .command("archive")
    .description("create or list attached archive DB snapshots")
    .option("--before <date>", "copy live DB to an archive snapshot for rows before date")
    .option("--out <path>", "archive DB path (default: .harness/archives/<id>.sqlite)")
    .option("--json", "print JSON", false)
    .action(async (raw: Record<string, unknown>) => {
      if (raw.before === undefined) {
        process.stderr.write(
          "harness error: 'db archive' requires --before, or use 'db archive list'\n",
        );
        process.exit(1);
      }
      await withLockAsync("shared", raw, async () => {
        const root = getHarnessRoot();
        const paths = harnessPaths(root);
        const archiveId = `archive-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const outPath =
          raw.out !== undefined
            ? String(raw.out)
            : join(root, ".harness", "archives", `${archiveId}.sqlite`);
        try {
          const backup = await backupDb({ dbPath: paths.dbPath, outPath });
          const sha = fileSha256(outPath);
          const db = openDb(paths.dbPath);
          try {
            runMigrations(db);
            const row = recordArchive(db, {
              archiveId,
              path: outPath,
              rangeEnd: String(raw.before),
              schemaVersion: backup.schemaVersion,
              sha256: sha,
              metadata: { mode: "copy-only", bytes: backup.bytes },
            });
            process.stdout.write(
              raw.json === true
                ? `${JSON.stringify(row, null, 2)}\n`
                : `db archive: ${row.archiveId} path=${row.path} rangeEnd=${row.rangeEnd}\n`,
            );
          } finally {
            db.close();
          }
        } catch (e) {
          dbError(e);
        }
      });
    });

  archiveCmd
    .command("list")
    .description("list archive catalog rows")
    .option("--json", "print JSON", false)
    .action((raw: Record<string, unknown>) => {
      withLock("shared", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        const db = openDbReadonly(dbPath);
        try {
          const rows = listArchives(db);
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(rows, null, 2)}\n`
              : rows
                  .map((a) => `${a.archiveId}\t${a.status}\t${a.path}\n`)
                  .join(""),
          );
        } finally {
          db.close();
        }
      });
    });

  dbCmd
    .command("attach-archive")
    .description("attach an existing archive DB to the archive catalog")
    .argument("<path>", "archive DB path")
    .option("--id <archive-id>", "archive id")
    .option("--json", "print JSON", false)
    .action((pathArg: string, raw: Record<string, unknown>) => {
      withLock("exclusive", raw, () => {
        const paths = harnessPaths(getHarnessRoot());
        const archivePath = String(pathArg);
        if (!existsSync(archivePath)) {
          process.stderr.write(`harness error: archive DB not found: ${archivePath}\n`);
          process.exit(1);
        }
        const db = openDb(paths.dbPath);
        const archiveDb = openDbReadonly(archivePath);
        try {
          runMigrations(db);
          const schemaVersion = readSchemaVersion(archiveDb);
          const row = recordArchive(db, {
            archiveId:
              raw.id !== undefined
                ? String(raw.id)
                : `archive-${createHash("sha256").update(archivePath).digest("hex").slice(0, 12)}`,
            path: archivePath,
            schemaVersion,
            sha256: fileSha256(archivePath),
            metadata: { mode: "attached" },
          });
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(row, null, 2)}\n`
              : `db attach-archive: ${row.archiveId} path=${row.path}\n`,
          );
        } finally {
          archiveDb.close();
          db.close();
        }
      });
    });

  dbCmd
    .command("doctor")
    .description("run DB doctor checks and persist findings")
    .option("--deep", "verify local external blob bytes before reporting", false)
    .option("--json", "print JSON", false)
    .action(async (raw: Record<string, unknown>) => {
      await withLockAsync(raw.deep === true ? "exclusive" : "shared", raw, async () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        const db = openDb(dbPath);
        try {
          runMigrations(db);
          const deepVerification =
            raw.deep === true
              ? await verifyLocalStoresDeep(db)
              : [];
          const result = runDoctor(db);
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify({ ...result, deepVerification }, null, 2)}\n`
              : formatDoctor(result),
          );
          if (result.status === "error" || result.status === "critical") {
            process.exitCode = 1;
          }
        } finally {
          db.close();
        }
      });
    });

  dbCmd
    .command("repair")
    .description("dry-run or apply a safe repair for a doctor finding")
    .option("--dry-run", "plan repairs without mutation", false)
    .option("--apply", "apply a repair", false)
    .option("--finding-id <id>", "doctor_findings.finding_id to repair")
    .option("--json", "print JSON", false)
    .action((raw: Record<string, unknown>) => {
      if (raw.apply === true && raw.dryRun === true) {
        process.stderr.write("harness error: --apply and --dry-run are mutually exclusive\n");
        process.exit(1);
      }
      if (raw.apply === true && raw.findingId === undefined) {
        process.stderr.write("harness error: --apply requires --finding-id\n");
        process.exit(1);
      }
      withLock(raw.apply === true ? "exclusive" : "shared", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        const db = openDb(dbPath);
        try {
          runMigrations(db);
          if (raw.findingId !== undefined) {
            const findingId = Number(raw.findingId);
            if (!Number.isInteger(findingId) || findingId <= 0) {
              process.stderr.write("harness error: --finding-id must be a positive integer\n");
              process.exit(1);
            }
            const finding = loadDoctorFinding(db, findingId);
            if (finding === null) {
              process.stderr.write(`harness error: finding ${findingId} not found\n`);
              process.exit(1);
            }
            const result = runRepair(db, finding, {
              dryRun: raw.apply !== true,
              findingId,
            });
            process.stdout.write(
              raw.json === true
                ? `${JSON.stringify(result, null, 2)}\n`
                : `${result.message}\n`,
            );
            if (result.status === "failed") process.exitCode = 1;
            return;
          }
          const doctor = runDoctor(db);
          const repairable = doctor.findings.filter(
            (f) => f.status === "flagged" && f.repairable,
          );
          const results = repairable.map((finding) =>
            runRepair(db, finding, { dryRun: true }),
          );
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify({ doctorRunId: doctor.doctorRunId, results }, null, 2)}\n`
              : formatRepairPlan(results),
          );
        } finally {
          db.close();
        }
      });
    });

  dbCmd
    .command("upgrade-check")
    .description("report readiness for a target phase")
    .requiredOption("--target <phase>", "target label, e.g. phase18")
    .option("--json", "print JSON", false)
    .action((raw: Record<string, unknown>) => {
      withLock("shared", raw, () => {
        const { dbPath } = harnessPaths(getHarnessRoot());
        // #271: upgrade-check is a NON-mutating diagnostic — it must REPORT, not
        // APPLY. Do NOT runMigrations here: migrating an older DB would mask the
        // `harness-newer-than-db` skew (it would read as `ok`), and a newer DB
        // would throw from the backstop before the directional report is built.
        const db = openDb(dbPath);
        try {
          const report = runUpgradeCheck(db, String(raw.target));
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(report, null, 2)}\n`
              : formatUpgradeCheck(report),
          );
          if (report.overall === "blocked") process.exitCode = 1;
        } finally {
          db.close();
        }
      });
    });

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
                          body_status = 'external_available'
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

function formatDoctor(result: ReturnType<typeof runDoctor>): string {
  const lines = [
    `db doctor: ${result.status} (${result.totals.flagged} flagged)`,
  ];
  for (const f of result.findings) {
    if (f.status === "flagged") {
      lines.push(`  [${f.severity}] ${f.checkId}: ${f.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function loadDoctorFinding(
  db: Database.Database,
  findingId: number,
): DoctorFinding | null {
  const row = db
    .prepare(
      `SELECT check_id, severity, status, message, repairable, details_json
         FROM doctor_findings WHERE finding_id = ?`,
    )
    .get(findingId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    checkId: row.check_id as string,
    severity: row.severity as DoctorFinding["severity"],
    status: row.status as DoctorFinding["status"],
    message: row.message as string,
    repairable: row.repairable === 1,
    details: JSON.parse((row.details_json as string | null) ?? "{}") as Record<string, unknown>,
  };
}

function formatRepairPlan(results: Array<ReturnType<typeof runRepair>>): string {
  if (results.length === 0) return "db repair: no repairable findings\n";
  return results.map((r) => `${r.message}\n`).join("");
}

function formatUpgradeCheck(report: ReturnType<typeof runUpgradeCheck>): string {
  const lines = [`db upgrade-check ${report.target}: ${report.overall}`];
  for (const c of report.checks) lines.push(`  [${c.status}] ${c.id}: ${c.message}`);
  lines.push("");
  return lines.join("\n");
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function defaultLocalStoreId(db: Database.Database): string {
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

function localStoreFromDb(
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

async function verifyLocalStoresDeep(
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

async function migrateExternalBlobsToDb(
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
              SET storage = 'db', body_status = 'db_available'
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
