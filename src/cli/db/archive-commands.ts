import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { openDb, openDbReadonly } from "../../db/connection.js";
import { runMigrations, readSchemaVersion } from "../../db/migrations.js";
import { backupDb } from "../../db/maintenance.js";
import { listArchives, recordArchive } from "../../db/archive-catalog.js";
import { getHarnessRoot, dbError, withLock, withLockAsync } from "./shared.js";

/**
 * `harness db` archive snapshot コマンド（#125 A15: cli/db.ts から behaviour-zero
 * 分割）。archive(+list) / attach-archive。registration 順は golden で凍結。
 * fileSha256 は archive 内専用の crypto ヘルパー。
 */
export function registerDbArchiveCommands(dbCmd: Command): void {
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
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
