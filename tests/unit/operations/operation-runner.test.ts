import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  runOperation,
  OperationInFlightError,
} from "../../../src/operations/operation-runner.js";
import {
  listOperations,
  listOperationEvents,
  startOperation,
} from "../../../src/db/repositories/operations.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-op-run-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  return db;
}

describe("OperationRunner (Phase 13-2)", () => {
  it("runs the work fn, records succeeded + events, returns result", async () => {
    const db = freshDb();
    try {
      const r = await runOperation<{ x: number }>(
        db,
        {
          operationType: "test.echo",
          target: { type: "run", id: "run-test" },
          actor: "cli:1",
          dryRun: false,
          input: { x: 1 },
        },
        async () => ({ x: 42 }),
      );
      expect(r.replayed).toBe(false);
      expect(r.result).toEqual({ x: 42 });
      expect(r.operation.status).toBe("succeeded");
      expect(JSON.parse(r.operation.resultJson!)).toEqual({ x: 42 });
      const events = listOperationEvents(db, r.operation.operationId);
      expect(events.map((e) => e.eventType)).toEqual(["started", "succeeded"]);
    } finally {
      db.close();
    }
  });

  it("idempotency replay: same key + succeeded → returns prior result", async () => {
    const db = freshDb();
    try {
      const first = await runOperation<{ n: number }>(
        db,
        {
          operationType: "test.idempotent",
          target: { type: "run", id: "run-1" },
          actor: "http:127.0.0.1",
          idempotencyKey: "key-A",
          dryRun: false,
          input: { n: 1 },
        },
        async () => ({ n: 100 }),
      );
      const second = await runOperation<{ n: number }>(
        db,
        {
          operationType: "test.idempotent",
          target: { type: "run", id: "run-1" },
          actor: "http:127.0.0.1",
          idempotencyKey: "key-A",
          dryRun: false,
          input: { n: 1 },
        },
        async () => ({ n: 999 }), // should NOT be called
      );
      expect(second.replayed).toBe(true);
      expect(second.result).toEqual({ n: 100 });
      expect(second.operation.operationId).toBe(first.operation.operationId);
    } finally {
      db.close();
    }
  });

  it("idempotency in-flight: running prior → OperationInFlightError", async () => {
    const db = freshDb();
    try {
      // Pre-seed a running operation with the key.
      startOperation(db, {
        operationId: "op-stuck",
        operationType: "test.busy",
        targetType: "run",
        targetId: "run-busy",
        actor: "cli:1",
        idempotencyKey: "key-busy",
        dryRun: false,
        input: {},
      });
      await expect(
        runOperation(
          db,
          {
            operationType: "test.busy",
            target: { type: "run", id: "run-busy" },
            actor: "cli:1",
            idempotencyKey: "key-busy",
            dryRun: false,
            input: {},
          },
          async () => ({}),
        ),
      ).rejects.toThrow(OperationInFlightError);
    } finally {
      db.close();
    }
  });

  it("work throws → operation marked failed with error_code + failed event", async () => {
    const db = freshDb();
    try {
      const boom = new Error("kaboom");
      await expect(
        runOperation(
          db,
          {
            operationType: "test.boom",
            target: { type: "run", id: "run-boom" },
            actor: "cli:1",
            dryRun: false,
            input: {},
          },
          async () => {
            throw boom;
          },
        ),
      ).rejects.toThrow("kaboom");
      const ops = listOperations(db, {
        targetType: "run",
        targetId: "run-boom",
      });
      expect(ops).toHaveLength(1);
      expect(ops[0]?.status).toBe("failed");
      expect(ops[0]?.errorMessage).toBe("kaboom");
      const events = listOperationEvents(db, ops[0]!.operationId);
      expect(events.map((e) => e.eventType)).toEqual(["started", "failed"]);
    } finally {
      db.close();
    }
  });
});
