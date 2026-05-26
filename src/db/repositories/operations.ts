import type Database from "better-sqlite3";

/**
 * Operation-id idempotency ledger (Phase 7).
 *
 * A DB-first command that may be retried (a crashed `pr create`, a
 * re-issued `rerun`) carries an `operation_id`. Before doing externally
 * visible work it records the operation here; a second run with the same
 * id finds the prior record and becomes an idempotent no-op instead of
 * creating a duplicate.
 *
 * The ledger only remembers that an operation ran and its recorded
 * result. Enforcing idempotency — checking `findOperation` first — is the
 * caller's job; this module is just storage.
 */

export interface OperationRecord {
  operationId: string;
  command: string;
  scopeType: string;
  scopeId: string;
  /** parsed `result_json`, or `null` when none was recorded */
  result: unknown;
  createdAt: string;
}

export interface RecordOperationInput {
  operationId: string;
  command: string;
  scopeType: string;
  scopeId: string;
  result?: unknown;
}

/** The recorded operation, or `undefined` when this id has not run. */
export function findOperation(
  db: Database.Database,
  operationId: string,
): OperationRecord | undefined {
  const row = db
    .prepare(
      `SELECT operation_id, command, scope_type, scope_id, result_json,
              created_at
       FROM operations WHERE operation_id = ?`,
    )
    .get(operationId) as
    | {
        operation_id: string;
        command: string;
        scope_type: string;
        scope_id: string;
        result_json: string | null;
        created_at: string;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    operationId: row.operation_id,
    command: row.command,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    result: row.result_json === null ? null : safeJson(row.result_json),
    createdAt: row.created_at,
  };
}

/**
 * Record an operation. Throws if the id is already recorded — callers
 * must `findOperation` first, inside the same transaction, so a duplicate
 * surfaces as their idempotent path rather than a constraint error.
 */
export function recordOperation(
  db: Database.Database,
  input: RecordOperationInput,
): void {
  db.prepare(
    `INSERT INTO operations
       (operation_id, command, scope_type, scope_id, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.operationId,
    input.command,
    input.scopeType,
    input.scopeId,
    input.result === undefined ? null : JSON.stringify(input.result),
    new Date().toISOString(),
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// =============================================================================
// Phase 13-2: OperationRunner audit ledger
// =============================================================================
//
// schema v8 で operations table を audit ledger shape に拡張した。
// Phase 7-12 互換の findOperation/recordOperation は legacy として
// 残しつつ、Phase 13 mutation API が呼ぶ richer な runner を別関数群
// として export する。

export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface OperationFullRecord {
  operationId: string;
  operationType: string | null;
  targetType: string | null;
  targetId: string | null;
  actor: string | null;
  idempotencyKey: string | null;
  dryRun: boolean;
  status: OperationStatus;
  inputJson: string | null;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  metadataJson: string;
}

export interface OperationEventRow {
  eventId: number;
  operationId: string;
  seq: number;
  eventType: string;
  message: string | null;
  dataJson: string;
  createdAt: string;
}

export class OperationInFlightError extends Error {
  constructor(public readonly operationId: string) {
    super(
      `operation ${operationId} is currently running — refusing to retry`,
    );
    this.name = "OperationInFlightError";
  }
}

/**
 * Phase 13 post-close fix (external review P1-3): thrown by
 * `runOperation` when an idempotency key resolves to an existing
 * failed/cancelled operation. The schema cannot accept a second row
 * with the same key, and silently retrying would let the caller skip
 * the prior failure. Carries the prior outcome so callers can either
 * surface the same error or mint a new idempotency key.
 */
export class OperationReplayedFailureError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly priorStatus: OperationStatus,
    public readonly priorErrorCode: string | null,
    public readonly priorErrorMessage: string | null,
  ) {
    super(
      `operation ${operationId} previously ended as ${priorStatus}` +
        (priorErrorMessage !== null ? `: ${priorErrorMessage}` : "") +
        ` — mint a new idempotency key to retry`,
    );
    this.name = "OperationReplayedFailureError";
  }
}

/**
 * Find a prior operation by idempotency key (the Phase 13 lookup).
 * Returns the latest record for (operation_type, target_id, key).
 */
export function findOperationByIdempotency(
  db: Database.Database,
  operationType: string,
  targetId: string,
  idempotencyKey: string,
): OperationFullRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM operations
        WHERE operation_type = ?
          AND target_id = ?
          AND idempotency_key = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(operationType, targetId, idempotencyKey) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : toFullRecord(row);
}

export function getOperation(
  db: Database.Database,
  operationId: string,
): OperationFullRecord | null {
  const row = db
    .prepare(`SELECT * FROM operations WHERE operation_id = ?`)
    .get(operationId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toFullRecord(row);
}

export interface ListOperationsFilter {
  targetType?: string;
  targetId?: string;
  status?: OperationStatus;
  limit?: number;
}

export function listOperations(
  db: Database.Database,
  filter: ListOperationsFilter = {},
): OperationFullRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.targetType !== undefined) {
    where.push("target_type = ?");
    params.push(filter.targetType);
  }
  if (filter.targetId !== undefined) {
    where.push("target_id = ?");
    params.push(filter.targetId);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
  const sql =
    `SELECT * FROM operations` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY created_at DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(toFullRecord);
}

export interface StartOperationInput {
  operationId: string;
  operationType: string;
  targetType: string;
  targetId: string;
  actor: string;
  idempotencyKey?: string;
  dryRun: boolean;
  input: unknown;
  metadata?: Record<string, unknown>;
  now?: Date;
}

/**
 * Begin a new operation. INSERT a row with status='running'. Returns
 * the inserted record.
 *
 * The caller must first call `findOperationByIdempotency` if an
 * idempotency_key is in play; this function does NOT do the lookup
 * (Phase 7 ledger keeps the same caller-driven contract).
 */
export function startOperation(
  db: Database.Database,
  input: StartOperationInput,
): OperationFullRecord {
  const now = (input.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO operations
       (operation_id, command, scope_type, scope_id, created_at,
        operation_type, target_type, target_id, actor, idempotency_key,
        dry_run, status, input_json, started_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
  ).run(
    input.operationId,
    input.operationType,
    input.targetType,
    input.targetId,
    now,
    input.operationType,
    input.targetType,
    input.targetId,
    input.actor,
    input.idempotencyKey ?? null,
    input.dryRun ? 1 : 0,
    JSON.stringify(input.input ?? {}),
    now,
    JSON.stringify(input.metadata ?? {}),
  );
  return getOperation(db, input.operationId) as OperationFullRecord;
}

export function succeedOperation(
  db: Database.Database,
  operationId: string,
  result: unknown,
  now: Date = new Date(),
): void {
  db.prepare(
    `UPDATE operations
        SET status = 'succeeded',
            result_json = ?,
            completed_at = ?
      WHERE operation_id = ?`,
  ).run(JSON.stringify(result ?? {}), now.toISOString(), operationId);
}

/**
 * Phase 13 post-close (codex P1.1): finalize an operation as `pending`,
 * signalling "audit recorded but execution is deferred to an external
 * worker". The HTTP `202 Accepted` endpoints (pr / rerun / backlog) use
 * this so `GET /api/operations/:id` does not falsely report `succeeded`
 * for work that never ran.
 */
export function markOperationPending(
  db: Database.Database,
  operationId: string,
  result: unknown,
  now: Date = new Date(),
): void {
  db.prepare(
    `UPDATE operations
        SET status = 'pending',
            result_json = ?,
            completed_at = ?
      WHERE operation_id = ?`,
  ).run(JSON.stringify(result ?? {}), now.toISOString(), operationId);
}

export function failOperation(
  db: Database.Database,
  operationId: string,
  errorCode: string,
  errorMessage: string,
  now: Date = new Date(),
): void {
  db.prepare(
    `UPDATE operations
        SET status = 'failed',
            error_code = ?,
            error_message = ?,
            completed_at = ?
      WHERE operation_id = ?`,
  ).run(errorCode, errorMessage, now.toISOString(), operationId);
}

export function appendOperationEvent(
  db: Database.Database,
  operationId: string,
  eventType: string,
  message?: string,
  data?: Record<string, unknown>,
  now: Date = new Date(),
): void {
  const seq = (
    db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM operation_events
         WHERE operation_id = ?`,
      )
      .get(operationId) as { next: number }
  ).next;
  db.prepare(
    `INSERT INTO operation_events
       (operation_id, seq, event_type, message, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    operationId,
    seq,
    eventType,
    message ?? null,
    JSON.stringify(data ?? {}),
    now.toISOString(),
  );
}

export function listOperationEvents(
  db: Database.Database,
  operationId: string,
): OperationEventRow[] {
  const rows = db
    .prepare(
      `SELECT event_id, operation_id, seq, event_type, message,
              data_json, created_at
         FROM operation_events
        WHERE operation_id = ?
        ORDER BY seq ASC`,
    )
    .all(operationId) as Record<string, unknown>[];
  return rows.map((r) => ({
    eventId: r.event_id as number,
    operationId: r.operation_id as string,
    seq: r.seq as number,
    eventType: r.event_type as string,
    message: (r.message as string | null) ?? null,
    dataJson: r.data_json as string,
    createdAt: r.created_at as string,
  }));
}

function toFullRecord(r: Record<string, unknown>): OperationFullRecord {
  return {
    operationId: r.operation_id as string,
    operationType: (r.operation_type as string | null) ?? null,
    targetType: (r.target_type as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    actor: (r.actor as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    dryRun: Boolean(r.dry_run),
    status: (r.status as OperationStatus) ?? "succeeded",
    inputJson: (r.input_json as string | null) ?? null,
    resultJson: (r.result_json as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    metadataJson: (r.metadata_json as string | null) ?? "{}",
  };
}
