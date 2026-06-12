import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";
import {
  OperationInFlightError,
  OperationReplayedFailureError,
  runOperation,
} from "../../operations/operation-runner.js";
import { redactMcpAuditValue } from "../audit/redaction.js";
import { errorResult, permissionDenied, type HarnessMcpToolResult } from "../schemas/outputs.js";
import { assertMutationBudget, McpMutationBudgetExceededError } from "../security/limits.js";
import type { McpToolContext } from "../registry/tool-registry.js";

interface MutationBaseArgs {
  idempotencyKey: string;
  actorNote?: string;
}

/**
 * Adapter for mutation tools that still pass their full args object.
 * The shared implementation lives in runMcpOperation below.
 */
export async function runMcpMutationOperation<T>(
  context: McpToolContext,
  opts: {
    operationType: string;
    target: { type: string; id: string };
    args: MutationBaseArgs;
    metadata: Record<string, unknown>;
    workWithDb: (db: Database.Database, operationId: string) => Promise<T> | T;
  },
): Promise<HarnessMcpToolResult> {
  return runMcpOperation(context, {
    operationType: opts.operationType,
    target: opts.target,
    idempotencyKey: opts.args.idempotencyKey,
    input: opts.args,
    metadata: opts.metadata,
    workWithDb: opts.workWithDb,
  });
}

export async function runMcpOperation<T>(
  context: McpToolContext,
  opts: {
    operationType: string;
    target: { type: string; id: string };
    idempotencyKey: string;
    input: unknown;
    metadata: Record<string, unknown>;
    workWithDb: (db: Database.Database, operationId: string) => Promise<T> | T;
  },
): Promise<HarnessMcpToolResult> {
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    return errorResult("harness DB is not initialized", { dbPath: paths.dbPath });
  }
  const operationId = `op-${randomUUID()}`;
  const handle = openManagedDb({
    dbPath: paths.dbPath,
    lockPath: paths.dbLockPath,
  });
  try {
    runMigrations(handle.db);
    const outcome = await runOperation(
      handle.db,
      {
        operationId,
        operationType: opts.operationType,
        target: opts.target,
        actor: `mcp:${context.clientName}`,
        idempotencyKey: opts.idempotencyKey,
        dryRun: false,
        input: redactMcpAuditValue(opts.input),
        metadata: redactMcpAuditValue(opts.metadata) as Record<string, unknown>,
        beforeStart: (db) => {
          assertMutationBudget(db, context.config, {
            clientName: context.clientName,
            operationType: opts.operationType,
            targetId: opts.target.id,
            idempotencyKey: opts.idempotencyKey,
          });
        },
      },
      async (opId) => opts.workWithDb(handle.db, opId),
    );
    return {
      status: "operation_started",
      summary: `${opts.operationType} ${outcome.replayed ? "replayed" : "started"}`,
      operationId: outcome.operation.operationId,
      data: {
        operation: {
          operationId: outcome.operation.operationId,
          operationType: outcome.operation.operationType,
          targetType: outcome.operation.targetType,
          targetId: outcome.operation.targetId,
          status: outcome.operation.status,
        },
        result: outcome.result,
        replayed: outcome.replayed,
      },
      resourceLinks: [
        {
          uri: `harness://operation/${outcome.operation.operationId}`,
          name: `operation ${outcome.operation.operationId}`,
          mimeType: "application/json",
        },
      ],
    };
  } catch (e) {
    if (e instanceof McpMutationBudgetExceededError) {
      const budget = e.decision;
      return permissionDenied(e.message, {
        limit: budget.limit ?? budget.reason,
        max: budget.max ?? null,
        resetAt: budget.resetAt ?? null,
      });
    }
    if (e instanceof OperationInFlightError) {
      return errorResult(e.message, {
        operationId: e.operationId,
        reason: "operation_in_flight",
      });
    }
    if (e instanceof OperationReplayedFailureError) {
      return errorResult(e.message, {
        operationId: e.operationId,
        reason: "idempotency_replayed_failure",
        priorStatus: e.priorStatus,
        priorErrorCode: e.priorErrorCode,
        priorErrorMessage: e.priorErrorMessage,
      });
    }
    return errorResult((e as Error).message, { operationId });
  } finally {
    handle.close();
  }
}
