import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { openManagedDb } from "../db/managed-connection.js";
import type { Route } from "../dashboard/server/server.js";
import { writeError, writeJson } from "../dashboard/server/server.js";
import {
  runOperation,
  OperationInFlightError,
  OperationReplayedFailureError,
} from "./operation-runner.js";

const RUN_ID_SHAPE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function validRunId(s: string): boolean {
  return RUN_ID_SHAPE.test(s);
}

/**
 * Cap JSON body size so a runaway POST cannot exhaust server memory. 1 MiB is
 * generous for the mutation API (its bodies are short JSON). Returns
 * `"oversize"` so the route handler can map to 413; returns `null` for parse /
 * shape errors.
 */
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | null | "oversize"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversize = false;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_JSON_BODY_BYTES) {
        // Stop accumulating but keep draining the stream so the client can
        // finish sending and receive a clean 413 instead of EPIPE.
        oversize = true;
        return;
      }
      if (!oversize) chunks.push(c);
    });
    req.on("end", () => {
      if (oversize) {
        resolve("oversize");
        return;
      }
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object") {
          resolve(null);
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** Operation mutation routes served by `harness operations serve`. */
export function mutationRoutes(): Route[] {
  return [
    {
      method: "POST",
      pattern: "/api/runs/:runId/review",
      handler: async ({ req, res, ctx, params }) => {
        const runId = params.runId!;
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const body = await readJsonBody(req);
        if (body === "oversize") {
          writeError(
            res,
            413,
            "payload_too_large",
            `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
          );
          return;
        }
        if (body === null) {
          writeError(res, 400, "bad_request", "invalid JSON body");
          return;
        }
        const decision = String(body.decision ?? "");
        if (
          decision !== "approved" &&
          decision !== "changes_requested" &&
          decision !== "rejected"
        ) {
          writeError(
            res,
            400,
            "bad_request",
            "decision must be approved | changes_requested | rejected",
          );
          return;
        }
        const dryRun = body.dryRun === true;
        const idempotencyKey =
          typeof req.headers["idempotency-key"] === "string"
            ? (req.headers["idempotency-key"] as string)
            : undefined;
        const actor = `http:${req.socket.remoteAddress ?? "?"}`;
        const handle = openManagedDb({ dbPath: ctx.config.dbPath });
        try {
          const outcome = await runOperation(
            handle.db,
            {
              operationType: "review.apply",
              target: { type: "run", id: runId },
              actor,
              ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
              dryRun,
              input: body,
            },
            async () => {
              if (dryRun) {
                return { dryRun: true, plannedDecision: decision };
              }
              // Delegate to the same core path as the CLI so status, replay,
              // and guard behavior stay aligned.
              const { processReviewDecision } = await import(
                "../core/review-processor.js"
              );
              const { harnessPaths } = await import("../config/paths.js");
              const paths = harnessPaths(dirname(dirname(ctx.config.dbPath)));
              const override = body.override as
                | {
                    actorReviewerId?: string;
                    reason?: string;
                  }
                | undefined;
              const r = await processReviewDecision({
                runsDir: paths.runsDir,
                locksDir: paths.locksDir,
                dbPath: paths.dbPath,
                runId,
                ...(override !== undefined && override.reason !== undefined
                  ? {
                      override: {
                        decision: decision as
                          | "approved"
                          | "changes_requested"
                          | "rejected",
                        reason: override.reason,
                        ...(override.actorReviewerId !== undefined
                          ? { actorReviewerId: override.actorReviewerId }
                          : {}),
                      },
                    }
                  : {}),
              });
              return r;
            },
          );
          writeJson(res, 200, {
            operationId: outcome.operation.operationId,
            status: outcome.operation.status,
            result: outcome.result,
            replayed: outcome.replayed,
          });
        } catch (e) {
          if (e instanceof OperationInFlightError) {
            writeError(res, 409, "conflict", e.message);
            return;
          }
          if (e instanceof OperationReplayedFailureError) {
            writeError(res, 409, "idempotency_replayed_failure", e.message, {
              operationId: e.operationId,
              priorStatus: e.priorStatus,
              priorErrorCode: e.priorErrorCode,
              priorErrorMessage: e.priorErrorMessage,
            });
            return;
          }
          writeError(res, 500, "internal_error", (e as Error).message);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/runs/:runId/cleanup",
      handler: async ({ req, res, ctx, params }) => {
        const runId = params.runId!;
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const body = await readJsonBody(req);
        if (body === "oversize") {
          writeError(
            res,
            413,
            "payload_too_large",
            `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
          );
          return;
        }
        if (body === null) {
          writeError(res, 400, "bad_request", "invalid JSON body");
          return;
        }
        const dryRun = body.dryRun === true;
        if (!dryRun && body.confirm !== "cleanup") {
          writeError(
            res,
            400,
            "bad_request",
            "real cleanup requires confirm: 'cleanup'",
          );
          return;
        }
        const idempotencyKey =
          typeof req.headers["idempotency-key"] === "string"
            ? (req.headers["idempotency-key"] as string)
            : undefined;
        const actor = `http:${req.socket.remoteAddress ?? "?"}`;
        const handle = openManagedDb({ dbPath: ctx.config.dbPath });
        try {
          const outcome = await runOperation(
            handle.db,
            {
              operationType: "run.cleanup",
              target: { type: "run", id: runId },
              actor,
              ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
              dryRun,
              input: body,
            },
            async () => {
              if (dryRun) {
                return {
                  dryRun: true,
                  plannedAction: "cleanup",
                  scope: body.scope ?? "workspace",
                };
              }
              const { cleanupRun } = await import("../core/cleanup.js");
              const { harnessPaths } = await import("../config/paths.js");
              const paths = harnessPaths(dirname(dirname(ctx.config.dbPath)));
              const scope =
                body.scope === "run" || body.scope === "all"
                  ? body.scope
                  : "workspace";
              return await cleanupRun({
                runsDir: paths.runsDir,
                workspacesDir: paths.workspacesDir,
                locksDir: paths.locksDir,
                dbPath: paths.dbPath,
                runId,
                scope,
                force: body.force === true,
              });
            },
          );
          writeJson(res, 200, {
            operationId: outcome.operation.operationId,
            status: outcome.operation.status,
            result: outcome.result,
            replayed: outcome.replayed,
          });
        } catch (e) {
          if (e instanceof OperationInFlightError) {
            writeError(res, 409, "conflict", e.message);
            return;
          }
          if (e instanceof OperationReplayedFailureError) {
            writeError(res, 409, "idempotency_replayed_failure", e.message, {
              operationId: e.operationId,
              priorStatus: e.priorStatus,
              priorErrorCode: e.priorErrorCode,
              priorErrorMessage: e.priorErrorMessage,
            });
            return;
          }
          writeError(res, 500, "internal_error", (e as Error).message);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/runs/:runId/pr",
      handler: async ({ req, res, ctx, params }) => {
        const runId = params.runId!;
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const body = await readJsonBody(req);
        if (body === "oversize") {
          writeError(
            res,
            413,
            "payload_too_large",
            `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
          );
          return;
        }
        if (body === null) {
          writeError(res, 400, "bad_request", "invalid JSON body");
          return;
        }
        const dryRun = body.dryRun === true;
        if (!dryRun && body.confirm !== "create-pr") {
          writeError(
            res,
            400,
            "bad_request",
            "real pr create requires confirm: 'create-pr'",
          );
          return;
        }
        const idempotencyKey =
          typeof req.headers["idempotency-key"] === "string"
            ? (req.headers["idempotency-key"] as string)
            : undefined;
        const actor = `http:${req.socket.remoteAddress ?? "?"}`;
        const handle = openManagedDb({ dbPath: ctx.config.dbPath });
        try {
          const outcome = await runOperation(
            handle.db,
            {
              operationType: "run.pr_create",
              target: { type: "run", id: runId },
              actor,
              ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
              dryRun,
              input: body,
              pendingExternalExecutor: !dryRun,
            },
            async () => {
              if (dryRun) {
                return { dryRun: true, plannedAction: "pr-create" };
              }
              return {
                accepted: true,
                executed: false,
                note: "pr create execution is deferred to a CLI runner; operation will remain status=pending until a worker completes it",
              };
            },
          );
          writeJson(res, 202, {
            operationId: outcome.operation.operationId,
            status: outcome.operation.status,
            result: outcome.result,
            replayed: outcome.replayed,
          });
        } catch (e) {
          if (e instanceof OperationInFlightError) {
            writeError(res, 409, "conflict", e.message);
            return;
          }
          if (e instanceof OperationReplayedFailureError) {
            writeError(res, 409, "idempotency_replayed_failure", e.message, {
              operationId: e.operationId,
              priorStatus: e.priorStatus,
              priorErrorCode: e.priorErrorCode,
              priorErrorMessage: e.priorErrorMessage,
            });
            return;
          }
          writeError(res, 500, "internal_error", (e as Error).message);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/backlog/:itemId/run",
      handler: async ({ req, res, ctx, params }) => {
        const itemId = params.itemId!;
        const body = await readJsonBody(req);
        if (body === "oversize") {
          writeError(
            res,
            413,
            "payload_too_large",
            `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
          );
          return;
        }
        if (body === null) {
          writeError(res, 400, "bad_request", "invalid JSON body");
          return;
        }
        const idempotencyKey =
          typeof req.headers["idempotency-key"] === "string"
            ? (req.headers["idempotency-key"] as string)
            : undefined;
        const actor = `http:${req.socket.remoteAddress ?? "?"}`;
        const handle = openManagedDb({ dbPath: ctx.config.dbPath });
        try {
          const dryRun = body.dryRun === true;
          const outcome = await runOperation(
            handle.db,
            {
              operationType: "backlog.run",
              target: { type: "backlog_item", id: itemId },
              actor,
              ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
              dryRun,
              input: body,
              pendingExternalExecutor: !dryRun,
            },
            async () => {
              return {
                accepted: true,
                executed: false,
                note: "backlog run execution is deferred to a CLI runner; operation will remain status=pending until a worker completes it",
              };
            },
          );
          writeJson(res, 202, {
            operationId: outcome.operation.operationId,
            status: outcome.operation.status,
            result: outcome.result,
            replayed: outcome.replayed,
          });
        } catch (e) {
          if (e instanceof OperationInFlightError) {
            writeError(res, 409, "conflict", e.message);
            return;
          }
          if (e instanceof OperationReplayedFailureError) {
            writeError(res, 409, "idempotency_replayed_failure", e.message, {
              operationId: e.operationId,
              priorStatus: e.priorStatus,
              priorErrorCode: e.priorErrorCode,
              priorErrorMessage: e.priorErrorMessage,
            });
            return;
          }
          writeError(res, 500, "internal_error", (e as Error).message);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/runs/:runId/rerun",
      handler: async ({ req, res, ctx, params }) => {
        const runId = params.runId!;
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const body = await readJsonBody(req);
        if (body === "oversize") {
          writeError(
            res,
            413,
            "payload_too_large",
            `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
          );
          return;
        }
        if (body === null) {
          writeError(res, 400, "bad_request", "invalid JSON body");
          return;
        }
        const dryRun = body.dryRun === true;
        const idempotencyKey =
          typeof req.headers["idempotency-key"] === "string"
            ? (req.headers["idempotency-key"] as string)
            : undefined;
        const actor = `http:${req.socket.remoteAddress ?? "?"}`;
        const handle = openManagedDb({ dbPath: ctx.config.dbPath });
        try {
          const outcome = await runOperation(
            handle.db,
            {
              operationType: "run.rerun",
              target: { type: "run", id: runId },
              actor,
              ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
              dryRun,
              input: body,
              pendingExternalExecutor: !dryRun,
            },
            async () => {
              if (dryRun) {
                return {
                  dryRun: true,
                  plannedAction: "rerun-from-review",
                  reason: body.reason ?? null,
                };
              }
              return {
                accepted: true,
                executed: false,
                note: "rerun execution is deferred to a CLI runner; operation will remain status=pending until a worker completes it",
              };
            },
          );
          writeJson(res, 202, {
            operationId: outcome.operation.operationId,
            status: outcome.operation.status,
            result: outcome.result,
            replayed: outcome.replayed,
          });
        } catch (e) {
          if (e instanceof OperationInFlightError) {
            writeError(res, 409, "conflict", e.message);
            return;
          }
          if (e instanceof OperationReplayedFailureError) {
            writeError(res, 409, "idempotency_replayed_failure", e.message, {
              operationId: e.operationId,
              priorStatus: e.priorStatus,
              priorErrorCode: e.priorErrorCode,
              priorErrorMessage: e.priorErrorMessage,
            });
            return;
          }
          writeError(res, 500, "internal_error", (e as Error).message);
        } finally {
          handle.close();
        }
      },
    },
  ];
}
