import type Database from "better-sqlite3";
import { SCHEMA_VERSION } from "./schema.js";
import { readSchemaVersion } from "./migrations.js";
import { evaluateSchemaCompatibility } from "./schema-compat.js";
import { runDoctor } from "./doctor.js";
import { listBackups } from "./backup-catalog.js";
import { listArchives } from "./archive-catalog.js";

/**
 * Phase 15-7 upgrade-check — produce a readiness report for the next
 * phase's migration / operational impact.
 *
 * Returns a deterministic JSON-friendly object so CLI (`harness db
 * upgrade-check --target phaseNN`) or dashboard can render it the
 * same way.
 */

export type UpgradeStatus = "ready" | "warn" | "blocked";

export interface UpgradeCheck {
  id: string;
  status: UpgradeStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface UpgradeReport {
  generatedAt: string;
  target: string;
  currentSchemaVersion: number;
  expectedSchemaVersion: number;
  overall: UpgradeStatus;
  checks: UpgradeCheck[];
}

/**
 * Run the upgrade-check fixture set. `target` is the human-readable
 * label of the next phase (e.g. `'phase16'`); it does not yet drive
 * any version-specific decisions — Phase 15 minimum produces the
 * same checks regardless of target.
 */
export function runUpgradeCheck(
  db: Database.Database,
  target: string,
  now: Date = new Date(),
): UpgradeReport {
  const checks: UpgradeCheck[] = [];

  // 1. schema version — NON-mutating diagnostic. Read the on-disk version with
  // `readSchemaVersion` (returns 0 on a table-less/fresh DB without throwing).
  const currentVersion = readSchemaVersion(db);
  // Directional skew classification (#271): distinguish a DB newer than this
  // harness (upgrade the harness) from an older DB (run `harness db migrate`)
  // instead of an undifferentiated 'blocked'.
  const compat = evaluateSchemaCompatibility(currentVersion, SCHEMA_VERSION);
  if (compat.kind !== "ok") {
    // Skewed EITHER direction: the subsequent latest-schema table / phase
    // readiness checks are misleading (and may throw) against an unmigrated or
    // too-new schema, so short-circuit with only the directional verdict.
    checks.push({
      id: "schema.version",
      status: "blocked",
      message:
        compat.kind === "db-newer-than-harness"
          ? `schema at v${currentVersion}, newer than this harness supports (v${SCHEMA_VERSION}) — upgrade the harness (DB is newer than this driver)`
          : `schema at v${currentVersion}, expected v${SCHEMA_VERSION} — run \`harness db migrate\``,
      details: {
        current: currentVersion,
        expected: SCHEMA_VERSION,
        skewKind: compat.kind,
        note: "further checks skipped pending schema alignment",
      },
    });
    return {
      generatedAt: now.toISOString(),
      target,
      currentSchemaVersion: currentVersion,
      expectedSchemaVersion: SCHEMA_VERSION,
      overall: "blocked",
      checks,
    };
  }
  checks.push({
    id: "schema.version",
    status: "ready",
    message: `schema at v${SCHEMA_VERSION}`,
    details: {
      current: currentVersion,
      expected: SCHEMA_VERSION,
      skewKind: compat.kind,
    },
  });

  // 2. doctor findings
  const dr = runDoctor(db, { now });
  checks.push({
    id: "doctor.findings",
    status:
      dr.totals.flagged === 0
        ? "ready"
        : dr.status === "critical" || dr.status === "error"
          ? "blocked"
          : "warn",
    message:
      dr.totals.flagged === 0
        ? "doctor: no findings"
        : `doctor: ${dr.totals.flagged} flagged (worst: ${dr.status})`,
    details: { totals: dr.totals, doctorRunId: dr.doctorRunId },
  });

  // 3. legacy-file runtime rows
  const legacyRuns = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE source_mode = 'legacy-file'`,
      )
      .get() as { n: number }
  ).n;
  const legacyBacklog = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM backlog_items WHERE source_mode = 'legacy-file'`,
      )
      .get() as { n: number }
  ).n;
  checks.push({
    id: "legacy.runtime_rows",
    status: legacyRuns + legacyBacklog === 0 ? "ready" : "blocked",
    message:
      legacyRuns + legacyBacklog === 0
        ? "no legacy-file runtime rows"
        : `${legacyRuns} legacy runs + ${legacyBacklog} legacy backlog items — run migrate-legacy first`,
  });

  // 4. dirty exports — count runs whose export_status indicates drift
  // (the per-row state lives on `runs.export_status`; `exported_files`
  // is the per-file ledger that the scope row references).
  const dirtyExports = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs
          WHERE export_status IN ('dirty', 'failed', 'removed')`,
      )
      .get() as { n: number }
  ).n;
  checks.push({
    id: "exports.dirty",
    status: dirtyExports === 0 ? "ready" : "warn",
    message:
      dirtyExports === 0
        ? "no dirty exports"
        : `${dirtyExports} runs with dirty export_status — consider \`harness db export-files --all\``,
  });

  // 5. unverified backups
  const backups = listBackups(db, { limit: 50 });
  const unverified = backups.filter(
    (b) => b.status === "available" && b.verifiedAt === null,
  );
  checks.push({
    id: "backups.unverified",
    status: unverified.length === 0 ? "ready" : "warn",
    message:
      unverified.length === 0
        ? `${backups.length} backup(s) verified`
        : `${unverified.length} unverified backup(s) — run \`harness db backup verify\``,
  });

  // 6. archive candidate volume
  const oneEighty = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const archiveCandidates = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs
          WHERE finished_at IS NOT NULL
            AND finished_at < ?`,
      )
      .get(oneEighty.toISOString()) as { n: number }
  ).n;
  checks.push({
    id: "archive.candidates",
    status: archiveCandidates < 1000 ? "ready" : "warn",
    message: `${archiveCandidates} runs eligible for archive (older than 180d)`,
  });

  // 7. open operations (still running)
  const openOps = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM operations WHERE status = 'running'`,
      )
      .get() as { n: number }
  ).n;
  checks.push({
    id: "operations.open",
    status: openOps === 0 ? "ready" : "warn",
    message:
      openOps === 0
        ? "no in-flight operations"
        : `${openOps} operation(s) still in 'running' status — verify before upgrade`,
  });

  // 8. asset conflicts (Phase 14)
  const assetConflicts = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM asset_exports WHERE status = 'dirty'`,
      )
      .get() as { n: number }
  ).n;
  checks.push({
    id: "assets.conflicts",
    status: assetConflicts === 0 ? "ready" : "warn",
    message:
      assetConflicts === 0
        ? "no asset_exports.dirty entries"
        : `${assetConflicts} dirty asset_exports — run \`harness assets reconcile\``,
  });

  // 9. attached archives
  const attached = listArchives(db, { status: "attached" });
  checks.push({
    id: "archives.attached",
    status: "ready",
    message: `${attached.length} archive(s) attached`,
  });

  const overall: UpgradeStatus = checks.some((c) => c.status === "blocked")
    ? "blocked"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ready";

  return {
    generatedAt: now.toISOString(),
    target,
    currentSchemaVersion: currentVersion,
    expectedSchemaVersion: SCHEMA_VERSION,
    overall,
    checks,
  };
}
