import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { DoctorFinding } from "./doctor.js";

/**
 * DB repair (Phase 15-3) — whitelist of safe, reversible operations
 * that a doctor finding can be auto-resolved into.
 *
 * Repair is dry-run by default. The CLI / API caller must pass
 * `apply: true` to mutate. Every repair (dry-run or apply) is recorded
 * in `repair_actions` for audit.
 */

export type RepairStatus = "pending" | "running" | "succeeded" | "failed";

export interface RepairResult {
  repairId: string;
  actionType: string;
  status: RepairStatus;
  dryRun: boolean;
  result: Record<string, unknown>;
  message: string;
}

export interface RepairAction {
  id: string;
  description: string;
  /** Which DoctorFinding.checkId this action repairs. */
  appliesTo: string;
  apply(
    db: Database.Database,
    finding: DoctorFinding,
    opts: { dryRun: boolean; now?: Date },
  ): RepairResult;
}

/** Phase 15-3 minimum repair whitelist. */
export const DEFAULT_REPAIRS: RepairAction[] = [
  {
    id: "lock.release_expired",
    description: "release a domain_lock whose expires_at has passed",
    appliesTo: "lock.expired_active",
    apply(db, finding, opts) {
      const lockId = (finding.details?.lock_id as number) ?? -1;
      if (!Number.isInteger(lockId) || lockId <= 0) {
        return makeResult(
          "lock.release_expired",
          false,
          "failed",
          { lockId },
          `invalid lock_id in finding`,
        );
      }
      if (opts.dryRun) {
        return makeResult(
          "lock.release_expired",
          true,
          "succeeded",
          { lockId, plannedReleaseReason: "expired-by-repair" },
          `would release domain_lock ${lockId}`,
        );
      }
      const now = (opts.now ?? new Date()).toISOString();
      // Phase 15 post-close fix (codex P1.2): revalidate `expires_at` in
      // the same UPDATE so a lease that was renewed between the doctor
      // run and this repair is NOT stolen. The CAS makes the repair
      // safe to retry.
      const info = db
        .prepare(
          `UPDATE domain_locks
              SET released_at = ?,
                  release_reason = 'expired-by-repair',
                  released_by = 'doctor-repair'
            WHERE lock_id = ?
              AND released_at IS NULL
              AND expires_at < ?`,
        )
        .run(now, lockId, now);
      return makeResult(
        "lock.release_expired",
        false,
        info.changes > 0 ? "succeeded" : "failed",
        { lockId, changes: info.changes },
        info.changes > 0
          ? `released domain_lock ${lockId}`
          : `domain_lock ${lockId} was already released or has been renewed since doctor flagged it`,
      );
    },
  },
  {
    id: "scratch.cleanup_expired",
    description: "mark an active expired scratch row as failed (rm later)",
    appliesTo: "scratch.expired",
    apply(db, finding, opts) {
      const matId = (finding.details?.materialization_id as number) ?? -1;
      if (!Number.isInteger(matId) || matId <= 0) {
        return makeResult(
          "scratch.cleanup_expired",
          false,
          "failed",
          { materializationId: matId },
          `invalid materialization_id`,
        );
      }
      if (opts.dryRun) {
        return makeResult(
          "scratch.cleanup_expired",
          true,
          "succeeded",
          { materializationId: matId },
          `would mark scratch ${matId} as failed`,
        );
      }
      const now = (opts.now ?? new Date()).toISOString();
      const info = db
        .prepare(
          `UPDATE run_materializations
              SET status = 'failed', cleaned_at = ?,
                  error_message = 'expired - cleaned by doctor repair'
            WHERE materialization_id = ? AND status = 'active'`,
        )
        .run(now, matId);
      return makeResult(
        "scratch.cleanup_expired",
        false,
        info.changes > 0 ? "succeeded" : "failed",
        { materializationId: matId, changes: info.changes },
        info.changes > 0
          ? `marked scratch ${matId} as failed (rm path on next cleanup --expired)`
          : `scratch ${matId} no longer active`,
      );
    },
  },
];

/** Find the registered repair for a finding, or null. */
export function findRepairFor(
  finding: DoctorFinding,
  registry: RepairAction[] = DEFAULT_REPAIRS,
): RepairAction | null {
  return (
    registry.find(
      (r) => r.appliesTo === finding.checkId && finding.repairable,
    ) ?? null
  );
}

/** Apply (or dry-run) a repair. Records the action in `repair_actions`. */
export function runRepair(
  db: Database.Database,
  finding: DoctorFinding,
  opts: { dryRun: boolean; findingId?: number; now?: Date } = { dryRun: true },
): RepairResult {
  const action = findRepairFor(finding);
  if (action === null) {
    return makeResult(
      "unknown",
      opts.dryRun,
      "failed",
      { checkId: finding.checkId },
      `no repair registered for check ${finding.checkId}`,
    );
  }
  const startedAt = (opts.now ?? new Date()).toISOString();
  const result = action.apply(db, finding, opts);
  const completedAt = (opts.now ?? new Date()).toISOString();

  db.prepare(
    `INSERT INTO repair_actions
       (repair_id, finding_id, action_type, dry_run, status,
        result_json, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.repairId,
    opts.findingId ?? null,
    result.actionType,
    result.dryRun ? 1 : 0,
    result.status,
    JSON.stringify(result.result),
    startedAt,
    completedAt,
  );
  return result;
}

function makeResult(
  actionType: string,
  dryRun: boolean,
  status: RepairStatus,
  result: Record<string, unknown>,
  message: string,
): RepairResult {
  return {
    repairId: `rep-${randomUUID()}`,
    actionType,
    status,
    dryRun,
    result,
    message,
  };
}
