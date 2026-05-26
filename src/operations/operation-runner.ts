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
  OperationReplayedFailureError,
  type OperationFullRecord,
} from "../db/repositories/operations.js";

/**
 * Phase 13-2 OperationRunner — the single entry point for mutation
 * operations. Wraps an async `work` function with audit + idempotency.
 *
 * Phase 13 post-close fix (external review P1-3): the idempotency key
 * is a permanent operation identity, not a per-attempt token. The
 * schema enforces a UNIQUE (operation_type, target_id, idempotency_key)
 * index that cannot accept a second row with the same triple, so the
 * earlier "failed → new attempt" branch would crash on INSERT. Option A
 * from the external review: a repeated key returns the prior outcome
 * regardless of status; callers that want to retry after a failure must
 * mint a new idempotency key (the well-known REST contract).
 *
 *   - existing 'succeeded' with same key   → return stored result (replay)
 *   - existing 'pending'                   → return prior record (audit-only)
 *   - existing 'running'                   → OperationInFlightError
 *   - existing 'failed' / 'cancelled'      → return prior record (replay)
 *                                            with the failure shape so the
 *                                            caller sees the same response
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
  /**
   * Optional synchronous guard that runs in the same BEGIN IMMEDIATE
   * transaction as the operation reservation. It must not perform async work.
   */
  beforeStart?: (db: Database.Database) => void;
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
  const operationId = opts.operationId ?? `op-${randomUUID()}`;
  const reservation = db.transaction(():
    | { type: "replay"; outcome: OperationRunOutcome<T> }
    | { type: "started"; operationId: string } => {
    // 1. idempotency lookup — Phase 13 post-close fix (external review
    // P1-3). Same key = same operation, regardless of outcome. The
    // schema's UNIQUE index on (operation_type, target_id, key) makes a
    // second INSERT impossible anyway.
    if (opts.idempotencyKey !== undefined) {
      const prior = findOperationByIdempotency(
        db,
        opts.operationType,
        opts.target.id,
        opts.idempotencyKey,
      );
      if (prior !== null) {
        if (prior.status === "running") {
          throw new OperationInFlightError(prior.operationId);
        }
        if (prior.status === "failed" || prior.status === "cancelled") {
          // Throw a replay-failure so callers cannot accidentally treat
          // this as a fresh attempt. They must mint a new key to retry.
          throw new OperationReplayedFailureError(
            prior.operationId,
            prior.status,
            prior.errorCode,
            prior.errorMessage,
          );
        }
        // 'succeeded' or 'pending' (audit-only) — replay the prior outcome.
        return {
          type: "replay",
          outcome: {
            operation: prior,
            result:
              prior.resultJson === null
                ? null
                : (JSON.parse(prior.resultJson) as T),
            replayed: true,
          },
        };
      }
    }

    opts.beforeStart?.(db);

    // 2. INSERT 'running' while still holding the immediate write transaction.
    startOperation(db, {
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
    return { type: "started", operationId };
  }).immediate();

  if (reservation.type === "replay") {
    return reservation.outcome;
  }

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

export { OperationInFlightError, OperationReplayedFailureError };
