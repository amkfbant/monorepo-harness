import process from "node:process";
import type { Command } from "commander";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openDb } from "../../db/connection.js";
import { runMigrations } from "../../db/migrations.js";
import { runDoctor, type DoctorFinding } from "../../db/doctor.js";
import { runRepair } from "../../db/repair.js";
import { runUpgradeCheck } from "../../db/upgrade-check.js";
import { getHarnessRoot, withLock, withLockAsync } from "./shared.js";
import { verifyLocalStoresDeep } from "./blob-helpers.js";

/**
 * `harness db` doctor / repair / upgrade-check コマンド（#125 A15: cli/db.ts から
 * behaviour-zero 分割）。doctor は deep verify で blob-helpers を使う。registration
 * 順は golden で凍結。format* は db.ts 由来の表示ヘルパー。
 */
export function registerDbDoctorCommands(dbCmd: Command): void {
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
