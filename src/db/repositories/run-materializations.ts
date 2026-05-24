import type Database from "better-sqlite3";

/**
 * `run_materializations` repository (Phase 10-3).
 *
 * Phase 9 left scratch materializations (e.g. `ensureRunMaterialized` /
 * the implicit run-dir created by `runDomainCoding`) implicit. Phase
 * 10-3 makes their lifecycle explicit so `db doctor` can surface leaks
 * (`status='active' AND expires_at < now`).
 *
 * **scope**: Phase 10 reads / writes only `purpose='scratch'` rows.
 * `purpose='compat-export'` is reserved in the schema for Phase 15 but
 * never materialized by this Phase. Callers must always pass
 * `purpose='scratch'`.
 */

export interface RecordScratchInput {
  runId: string;
  path: string;
  reason: string;
  /** Optional TTL in milliseconds. Omitted → no `expires_at` set. */
  ttlMs?: number;
  metadata?: Record<string, unknown>;
  /** Override `now` for deterministic tests. */
  now?: Date;
}

export interface ScratchRow {
  materializationId: number;
  runId: string;
  path: string;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
  cleanedAt: string | null;
  status: "active" | "cleaned" | "failed";
  errorMessage: string | null;
  metadataJson: string;
}

/**
 * Insert a new scratch row in `status='active'`. Returns the
 * `materialization_id`.
 */
export function recordScratchMaterialization(
  db: Database.Database,
  input: RecordScratchInput,
): number {
  const now = (input.now ?? new Date()).toISOString();
  const expiresAt =
    input.ttlMs !== undefined
      ? new Date(
          (input.now ?? new Date()).getTime() + input.ttlMs,
        ).toISOString()
      : null;
  const info = db
    .prepare(
      `INSERT INTO run_materializations (
         run_id, purpose, path, reason, created_at, expires_at,
         status, metadata_json
       ) VALUES (?, 'scratch', ?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      input.runId,
      input.path,
      input.reason,
      now,
      expiresAt,
      JSON.stringify(input.metadata ?? {}),
    );
  return Number(info.lastInsertRowid);
}

/** Flip an `active` row to `cleaned` (idempotent). */
export function markScratchCleaned(
  db: Database.Database,
  materializationId: number,
  now: Date = new Date(),
): void {
  db.prepare(
    `UPDATE run_materializations
        SET status = 'cleaned', cleaned_at = ?
      WHERE materialization_id = ? AND status = 'active'`,
  ).run(now.toISOString(), materializationId);
}

/** Flip an `active` row to `failed` with an error message. */
export function markScratchFailed(
  db: Database.Database,
  materializationId: number,
  errorMessage: string,
  now: Date = new Date(),
): void {
  db.prepare(
    `UPDATE run_materializations
        SET status = 'failed', cleaned_at = ?, error_message = ?
      WHERE materialization_id = ? AND status = 'active'`,
  ).run(now.toISOString(), errorMessage, materializationId);
}

/** All currently-active scratch rows for a run, newest first. */
export function listActiveScratchForRun(
  db: Database.Database,
  runId: string,
): ScratchRow[] {
  const rows = db
    .prepare(
      `SELECT materialization_id, run_id, path, reason, created_at,
              expires_at, cleaned_at, status, error_message, metadata_json
         FROM run_materializations
        WHERE run_id = ? AND purpose = 'scratch' AND status = 'active'
        ORDER BY created_at DESC`,
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(toRow);
}

/** All `status='active'` rows whose `expires_at < now` (== TTL expired). */
export function listExpiredActiveScratch(
  db: Database.Database,
  now: Date = new Date(),
): ScratchRow[] {
  const rows = db
    .prepare(
      `SELECT materialization_id, run_id, path, reason, created_at,
              expires_at, cleaned_at, status, error_message, metadata_json
         FROM run_materializations
        WHERE purpose = 'scratch'
          AND status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at < ?
        ORDER BY expires_at ASC`,
    )
    .all(now.toISOString()) as Record<string, unknown>[];
  return rows.map(toRow);
}

function toRow(r: Record<string, unknown>): ScratchRow {
  return {
    materializationId: r.materialization_id as number,
    runId: r.run_id as string,
    path: r.path as string,
    reason: r.reason as string,
    createdAt: r.created_at as string,
    expiresAt: (r.expires_at as string | null) ?? null,
    cleanedAt: (r.cleaned_at as string | null) ?? null,
    status: r.status as "active" | "cleaned" | "failed",
    errorMessage: (r.error_message as string | null) ?? null,
    metadataJson: r.metadata_json as string,
  };
}
