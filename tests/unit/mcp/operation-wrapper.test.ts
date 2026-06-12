import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  failOperation,
  startOperation,
} from "../../../src/db/repositories/operations.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../../src/mcp/security/config.js";
import type { McpToolContext } from "../../../src/mcp/registry/tool-registry.js";
import {
  runMcpMutationOperation,
  runMcpOperation,
} from "../../../src/mcp/tools/operation-wrapper.js";

function freshRoot(seed: (db: Database.Database) => void = () => {}): string {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-wrapper-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    seed(db);
  } finally {
    db.close();
  }
  return root;
}

function context(root: string, config: McpConfig = DEFAULT_MCP_CONFIG): McpToolContext {
  return {
    harnessRoot: root,
    config,
    clientName: "unit-test",
    sessionId: "mcpsess_wrapper",
  };
}

function startPriorOperation(
  db: Database.Database,
  input: {
    operationId: string;
    operationType: string;
    targetId: string;
    idempotencyKey: string;
  },
): void {
  startOperation(db, {
    operationId: input.operationId,
    operationType: input.operationType,
    targetType: "unit",
    targetId: input.targetId,
    actor: "mcp:unit-test",
    idempotencyKey: input.idempotencyKey,
    dryRun: false,
    input: {},
    metadata: {},
    now: new Date("2026-06-12T00:00:00Z"),
  });
}

describe("runMcpMutationOperation adapter error responses", () => {
  it("redacts operation metadata while preserving non-sensitive structure keys", async () => {
    const root = freshRoot();
    const result = await runMcpOperation(context(root), {
      operationType: "unit.mutation",
      target: { type: "unit", id: "target-redact" },
      idempotencyKey: "wrapper-redact-key",
      input: {
        idempotencyKey: "wrapper-redact-key",
        actorNote: `contains ${"sk-" + "f".repeat(40)}`,
      },
      metadata: {
        source: "mcp",
        clientName: "unit-test",
        toolName: "harness.hitch.start",
        hitchId: "hitch-wrapper",
        hitch_id: "hitch-wrapper",
        idempotencyKey: "wrapper-redact-key",
        actorNote: `contains ${"sk-" + "f".repeat(40)}`,
      },
      workWithDb: () => ({ ok: true }),
    });

    expect(result.status).toBe("operation_started");
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      const row = db
        .prepare("SELECT input_json, metadata_json, idempotency_key FROM operations WHERE operation_id = ?")
        .get(result.operationId) as {
        input_json: string;
        metadata_json: string;
        idempotency_key: string;
      };
      expect(row.idempotency_key).toBe("wrapper-redact-key");
      expect(row.input_json).not.toContain("wrapper-redact-key");
      expect(row.metadata_json).not.toContain("wrapper-redact-key");
      const input = JSON.parse(row.input_json) as Record<string, unknown>;
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      expect(input.idempotencyKey).toBe("[redacted]");
      expect(input.actorNote).toBe("[redacted]");
      expect(metadata).toMatchObject({
        source: "mcp",
        clientName: "unit-test",
        toolName: "harness.hitch.start",
        hitchId: "hitch-wrapper",
        hitch_id: "hitch-wrapper",
        idempotencyKey: "[redacted]",
        actorNote: "[redacted]",
      });
    } finally {
      db.close();
    }
  });

  it("keeps the budget-exceeded response shape", async () => {
    const root = freshRoot();
    const result = await runMcpMutationOperation(context(root, {
      ...DEFAULT_MCP_CONFIG,
      limits: {
        ...DEFAULT_MCP_CONFIG.limits,
        maxMutationOperationsPerHour: 0,
      },
    }), {
      operationType: "unit.mutation",
      target: { type: "unit", id: "target-budget" },
      args: { idempotencyKey: "budget-key" },
      metadata: {},
      workWithDb: () => ({ ok: true }),
    });

    expect(result).toEqual({
      status: "permission_denied",
      summary: "MCP rate limit exceeded: maxMutationOperationsPerHour",
      data: {
        limit: "maxMutationOperationsPerHour",
        max: 0,
        resetAt: null,
      },
    });
  });

  it("keeps the in-flight response shape", async () => {
    const operationType = "unit.mutation";
    const targetId = "target-in-flight";
    const idempotencyKey = "same-key";
    const root = freshRoot((db) => {
      startPriorOperation(db, {
        operationId: "op-running",
        operationType,
        targetId,
        idempotencyKey,
      });
    });

    const result = await runMcpMutationOperation(context(root), {
      operationType,
      target: { type: "unit", id: targetId },
      args: { idempotencyKey },
      metadata: {},
      workWithDb: () => ({ ok: true }),
    });

    expect(result.status).toBe("error");
    expect(result.summary).toContain("operation op-running is currently running");
    expect(result.data).toEqual({
      operationId: "op-running",
      reason: "operation_in_flight",
    });
  });

  it("keeps the replayed-failure response shape", async () => {
    const operationType = "unit.mutation";
    const targetId = "target-failed";
    const idempotencyKey = "failed-key";
    const root = freshRoot((db) => {
      startPriorOperation(db, {
        operationId: "op-failed",
        operationType,
        targetId,
        idempotencyKey,
      });
      failOperation(
        db,
        "op-failed",
        "unit_error",
        "prior failure",
        new Date("2026-06-12T00:00:01Z"),
      );
    });

    const result = await runMcpMutationOperation(context(root), {
      operationType,
      target: { type: "unit", id: targetId },
      args: { idempotencyKey },
      metadata: {},
      workWithDb: () => ({ ok: true }),
    });

    expect(result.status).toBe("error");
    expect(result.summary).toContain(
      "operation op-failed previously ended as failed: prior failure",
    );
    expect(result.summary).toContain("mint a new idempotency key to retry");
    expect(result.data).toEqual({
      operationId: "op-failed",
      reason: "idempotency_replayed_failure",
      priorStatus: "failed",
      priorErrorCode: "unit_error",
      priorErrorMessage: "prior failure",
    });
  });
});
