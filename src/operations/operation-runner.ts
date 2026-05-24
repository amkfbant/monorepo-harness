import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  findOperationByIdempotency,
  startOperation,
  succeedOperation,
  markOperationPending,
  failOperation,
  appendOperationEvent,
  getOperation,
  OperationInFlightError,
  type OperationFullRecord,
} from "../db/repositories/operations.js";

/**
 * Phase 13-2 OperationRunner — the single entry point for mutation
 * operations. Wraps an async `work` function with audit + idempotency.
 *
 * Idempotency contract (design §3.B):
 *   - existing 'succeeded' with same key   → return stored result (no-op)
 *   - existing 'running' with same key     → OperationInFlightError
 *   - existing 'failed' / 'cancelled'      → allow new attempt (new operation_id)
 *   - no existing                          → INSERT 'running' + run + finalize
 */

export interface RunOperationOptions<T> {
  operationType: string;
  target: { type: string; id: string };
  actor: string;
  idempotencyKey?: string;
  dryRun: boolean;
  input: unknown;
  metadata?: Record<string, unknown>;
  /** Caller-supplied operation_id, else server-generated. */
  operationId?: string;
  /**
   * Phase 13 post-close fix (codex P1.1). When true, the work function is
   * treated as "audit-only" — its return value is recorded but the
   * operation is finalized as `pending` rather than `succeeded`. Use this
   * for endpoints that accept the request and delegate execution to an
   * external worker (the 202-Accepted contract). The operations ledger
   * stays honest: a poller sees `pending` until a worker actually runs
   * the work, instead of `succeeded` for nothing.
   */
  pendingExternalExecutor?: boolean;
}

export interface OperationRunOutcome<T> {
  operation: OperationFullRecord;
  result: T | null;
  replayed: boolean;
}

export async function runOperation<T>(
  db: Database.Database,
  opts: RunOperationOptions<T>,
  work: (operationId: string) => Promise<T>,
): Promise<OperationRunOutcome<T>> {
  // 1. idempotency lookup
  if (opts.idempotencyKey !== undefined) {
    const prior = findOperationByIdempotency(
      db,
      opts.operationType,
      opts.target.id,
      opts.idempotencyKey,
    );
    if (prior !== null) {
      if (prior.status === "succeeded") {
        return {
          operation: prior,
          result: prior.resultJson === null
            ? null
            : (JSON.parse(prior.resultJson) as T),
          replayed: true,
        };
      }
      if (prior.status === "running") {
        throw new OperationInFlightError(prior.operationId);
      }
      // failed / cancelled → fall through to new attempt
    }
  }

  // 2. INSERT 'running'
  const operationId = opts.operationId ?? `op-${randomUUID()}`;
  const op = startOperation(db, {
    operationId,
    operationType: opts.operationType,
    targetType: opts.target.type,
    targetId: opts.target.id,
    actor: opts.actor,
    ...(opts.idempotencyKey !== undefined
      ? { idempotencyKey: opts.idempotencyKey }
      : {}),
    dryRun: opts.dryRun,
    input: opts.input,
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  });
  appendOperationEvent(db, operationId, "started", undefined, {
    operationType: opts.operationType,
    dryRun: opts.dryRun,
  });

  // 3. run work + finalize
  try {
    const result = await work(operationId);
    if (opts.pendingExternalExecutor === true) {
      markOperationPending(db, operationId, result);
      appendOperationEvent(db, operationId, "accepted");
    } else {
      succeedOperation(db, operationId, result);
      appendOperationEvent(db, operationId, "succeeded");
    }
    return {
      operation: getOperation(db, operationId) as OperationFullRecord,
      result,
      replayed: false,
    };
  } catch (e) {
    const err = e as Error;
    const code = (err as { code?: string }).code ?? err.name ?? "internal_error";
    failOperation(db, operationId, code, err.message);
    appendOperationEvent(db, operationId, "failed", err.message);
    throw e;
  }
}

export { OperationInFlightError };
