import process from "node:process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { openDb, openDbReadonly } from "../../db/connection.js";
import { runMigrations } from "../../db/migrations.js";
import { runFullImport, formatImportReport } from "../../db/import-files.js";
import {
  checkConsistency,
  formatConsistencyReport,
} from "../../db/consistency.js";
import {
  exportFiles,
  formatBulkExport,
  type ExportScope,
} from "../../db/export-bulk.js";
import {
  migrateArtifacts,
  formatMigrateArtifacts,
} from "../../db/migrate-artifacts.js";
import { migrateLegacy, formatMigrateLegacy } from "../../db/migrate-legacy.js";
import { getHarnessRoot, dbError, withLock } from "./shared.js";

/**
 * `harness db` schema/read-model lifecycle コマンド（#125 A15: cli/db.ts から
 * behaviour-zero 分割）。init / migrate / import / export-files / migrate-artifacts /
 * migrate-legacy / check-consistency。registration 順は golden で凍結。
 */
export function registerDbSchemaCommands(dbCmd: Command): void {
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
}
