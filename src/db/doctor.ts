import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * DB doctor — Phase 15-2.
 *
 * A check registry with the Phase 15-2 minimum set of fixtures. Each
 * check runs an SQL query against the harness DB and produces zero or
 * more `DoctorFinding`s. `runDoctor()` records the run + findings to
 * `doctor_runs` / `doctor_findings`.
 *
 * Phase 15-3 (repair) walks the same findings — see `repairable`.
 */

export type Severity = "info" | "warn" | "error" | "critical";
export type FindingStatus = "ok" | "flagged" | "resolved";

export interface DoctorFinding {
  checkId: string;
  severity: Severity;
  status: FindingStatus;
  message: string;
  repairable: boolean;
  details?: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  category: "artifacts" | "runtime" | "locks" | "assets" | "scratch" | "review";
  severity: Severity;
  description: string;
  run(db: Database.Database): DoctorFinding[];
}

/** Phase 15-2 minimum check set. */
export const DEFAULT_CHECKS: DoctorCheck[] = [
  {
    id: "artifact.blob.missing",
    category: "artifacts",
    severity: "error",
    description: "artifacts.storage='db' but no matching artifact_blobs row",
    run(db) {
      const rows = db
        .prepare(
          `SELECT a.artifact_id, a.run_id, a.relative_path, a.blob_sha256
             FROM artifacts a
            WHERE a.storage = 'db'
              AND a.blob_sha256 IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM artifact_blobs b
                WHERE b.sha256 = a.blob_sha256
              )
            LIMIT 50`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        checkId: "artifact.blob.missing",
        severity: "error" as const,
        status: "flagged" as const,
        message: `artifact ${r.artifact_id} (${r.relative_path}) references missing blob ${r.blob_sha256}`,
        repairable: false,
        details: {
          artifactId: r.artifact_id,
          runId: r.run_id,
          blobSha256: r.blob_sha256,
        },
      }));
    },
  },
  {
    // Phase 15 post-close fix (codex P1.1a): status='coding' was never a
    // real run status (`RUN_STATUSES` uses 'running'); the prior check
    // would silently match nothing. Compare against the running set.
    id: "runtime.orphan_run",
    category: "runtime",
    severity: "warn",
    description: "runs.status='running' but lease released or absent",
    run(db) {
      const rows = db
        .prepare(
          `SELECT r.run_id, r.lease_lock_id
             FROM runs r
            WHERE r.status = 'running'
              AND r.lease_lock_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM domain_locks dl
                WHERE dl.lock_id = r.lease_lock_id
                  AND dl.released_at IS NULL
              )
            LIMIT 50`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        checkId: "runtime.orphan_run",
        severity: "warn" as const,
        status: "flagged" as const,
        message: `run ${r.run_id} stuck at status='running' but lease released`,
        repairable: false,
        details: { runId: r.run_id, leaseLockId: r.lease_lock_id },
      }));
    },
  },
  {
    // Phase 15 post-close fix (codex P1.1b): SQLite `datetime('now')`
    // renders as `YYYY-MM-DD HH:MM:SS` (space), while expires_at is
    // stored as ISO `YYYY-MM-DDTHH:MM:SS.sssZ` (T + ms + Z) from JS.
    // Lexicographic compare is wrong (T > space) and same-day expiries
    // can be missed. Bind a JS-rendered ISO now and compare apples to
    // apples.
    id: "lock.expired_active",
    category: "locks",
    severity: "warn",
    description: "domain_locks active but expires_at < now",
    run(db) {
      const now = new Date().toISOString();
      const rows = db
        .prepare(
          `SELECT lock_id, domain_key, holder_run_id, expires_at
             FROM domain_locks
            WHERE released_at IS NULL
              AND expires_at < ?
            LIMIT 50`,
        )
        .all(now) as Record<string, unknown>[];
      return rows.map((r) => ({
        checkId: "lock.expired_active",
        severity: "warn" as const,
        status: "flagged" as const,
        message: `domain lock ${r.lock_id} (${r.domain_key}) expired at ${r.expires_at} but not released`,
        repairable: true,
        details: r,
      }));
    },
  },
  {
    id: "scratch.expired",
    category: "scratch",
    severity: "warn",
    description: "run_materializations.status='active' but expires_at < now",
    run(db) {
      // Phase 15 post-close fix (codex P1.1b): same ISO compare issue.
      const now = new Date().toISOString();
      const rows = db
        .prepare(
          `SELECT materialization_id, run_id, path, expires_at
             FROM run_materializations
            WHERE purpose = 'scratch'
              AND status = 'active'
              AND expires_at IS NOT NULL
              AND expires_at < ?
            LIMIT 50`,
        )
        .all(now) as Record<string, unknown>[];
      return rows.map((r) => ({
        checkId: "scratch.expired",
        severity: "warn" as const,
        status: "flagged" as const,
        message: `scratch materialization ${r.materialization_id} for ${r.run_id} expired at ${r.expires_at}`,
        repairable: true,
        details: r,
      }));
    },
  },
  {
    id: "assets.dirty_export",
    category: "assets",
    severity: "warn",
    description: "asset_exports.status != 'synced' (Phase 14)",
    run(db) {
      const rows = db
        .prepare(
          `SELECT asset_type, asset_id, relative_path, status, sha256
             FROM asset_exports
            WHERE status != 'synced'
            LIMIT 50`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        checkId: "assets.dirty_export",
        severity: "warn" as const,
        status: "flagged" as const,
        message: `asset export ${r.asset_type}:${r.asset_id} (${r.relative_path}) status=${r.status}`,
        repairable: false,
        details: r,
      }));
    },
  },
  {
    id: "review.orphan_processed",
    category: "review",
    severity: "warn",
    description: "review_proposals.processed_at set but review_decision_id NULL",
    run(db) {
      const rows = db
        .prepare(
          `SELECT proposal_id, run_id, reviewer
             FROM review_proposals
            WHERE processed_at IS NOT NULL
              AND review_decision_id IS NULL
            LIMIT 50`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        checkId: "review.orphan_processed",
        severity: "warn" as const,
        status: "flagged" as const,
        message: `proposal ${r.proposal_id} (${r.reviewer} / ${r.run_id}) marked processed but no decision linked`,
        repairable: false,
        details: r,
      }));
    },
  },
];

export interface DoctorRunResult {
  doctorRunId: string;
  startedAt: string;
  completedAt: string;
  status: "ok" | "warn" | "error" | "critical";
  totals: { ok: number; flagged: number };
  findings: DoctorFinding[];
}

/** Run all (or category-filtered) checks. Records run + findings. */
export function runDoctor(
  db: Database.Database,
  opts: {
    category?: DoctorCheck["category"];
    checks?: DoctorCheck[];
    now?: Date;
  } = {},
): DoctorRunResult {
  const checks = (opts.checks ?? DEFAULT_CHECKS).filter(
    (c) => opts.category === undefined || c.category === opts.category,
  );
  const doctorRunId = `doctor-${randomUUID()}`;
  const startedAt = (opts.now ?? new Date()).toISOString();
  const allFindings: DoctorFinding[] = [];
  for (const check of checks) {
    const findings = check.run(db);
    if (findings.length === 0) {
      allFindings.push({
        checkId: check.id,
        severity: check.severity,
        status: "ok",
        message: `${check.description} — no findings`,
        repairable: false,
      });
    } else {
      allFindings.push(...findings);
    }
  }
  const flagged = allFindings.filter((f) => f.status === "flagged").length;
  const ok = allFindings.filter((f) => f.status === "ok").length;
  const worst = severityRank(allFindings);
  const completedAt = (opts.now ?? new Date()).toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO doctor_runs
         (doctor_run_id, started_at, completed_at, status, summary_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      doctorRunId,
      startedAt,
      completedAt,
      worst,
      JSON.stringify({ ok, flagged }),
    );
    const insertFinding = db.prepare(
      `INSERT INTO doctor_findings
         (doctor_run_id, check_id, severity, status, message,
          repairable, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of allFindings) {
      insertFinding.run(
        doctorRunId,
        f.checkId,
        f.severity,
        f.status,
        f.message,
        f.repairable ? 1 : 0,
        JSON.stringify(f.details ?? {}),
      );
    }
  });
  tx();

  return {
    doctorRunId,
    startedAt,
    completedAt,
    status: worst,
    totals: { ok, flagged },
    findings: allFindings,
  };
}

function severityRank(
  findings: DoctorFinding[],
): "ok" | "warn" | "error" | "critical" {
  const flagged = findings.filter((f) => f.status === "flagged");
  if (flagged.length === 0) return "ok";
  const order: Severity[] = ["info", "warn", "error", "critical"];
  let max: Severity = "info";
  for (const f of flagged) {
    if (order.indexOf(f.severity) > order.indexOf(max)) {
      max = f.severity;
    }
  }
  return max === "info" ? "ok" : (max as "warn" | "error" | "critical");
}
