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
