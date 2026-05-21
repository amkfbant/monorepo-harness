import process from "node:process";
import { existsSync, statSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openDb, openDbReadonly, DbError } from "../db/connection.js";
import { runMigrations, readSchemaVersion } from "../db/migrations.js";
import { runFullImport, formatImportReport } from "../db/import-files.js";

function getHarnessRoot(): string {
  return process.env.HARNESS_ROOT ?? process.cwd();
}

function dbError(e: unknown): never {
  if (e instanceof DbError) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

/**
 * Register the `harness db ...` command group (Phase 6).
 *
 * 6-2 adds init / migrate / status. Later sub-phases add `import` (6-3)
 * and `check-consistency` (6-4) here.
 */
export function registerDbCommands(program: Command): void {
  const dbCmd = program
    .command("db")
    .description("harness DB (read model built from files — Phase 6)");

  dbCmd
    .command("init")
    .description("create .harness/harness.sqlite and apply the schema")
    .action(() => {
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

  dbCmd
    .command("migrate")
    .description("apply any pending schema migrations")
    .action(() => {
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

  dbCmd
    .command("import")
    .description("build the DB read model from harness files")
    .option(
      "--from-files",
      "import from runs/ projects/ policies/ backlog/ docs/knowledge",
    )
    .option("--reset", "empty every data table before importing")
    .option("--json", "print the import report as JSON")
    .action((raw: Record<string, unknown>) => {
      if (raw.fromFiles !== true) {
        process.stderr.write(
          "harness error: 'db import' requires --from-files\n",
        );
        process.exit(1);
      }
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
