import type Database from "better-sqlite3";
import type { McpConfig } from "./config.js";

export interface LimitDecision {
  allowed: boolean;
  reason: string;
  limit?: string;
  max?: number;
  resetAt?: string;
  remainingToolCallsThisMinute?: number;
  remainingRunsThisHour?: number;
  remainingMutationOperationsThisHour?: number;
}

export class McpMutationBudgetExceededError extends Error {
  constructor(public readonly decision: LimitDecision) {
    super(`MCP rate limit exceeded: ${decision.reason}`);
    this.name = "McpMutationBudgetExceededError";
  }
}

interface Bucket {
  windowStartedAt: number;
  count: number;
}

export class McpRateLimiter {
  private readonly toolBuckets = new Map<string, Bucket>();

  checkToolCall(config: McpConfig, clientName: string, now = Date.now()): LimitDecision {
    const max = config.limits.maxToolCallsPerMinute;
    const bucket = this.toolBuckets.get(clientName);
    const minuteMs = 60_000;
    if (bucket === undefined || now - bucket.windowStartedAt >= minuteMs) {
      this.toolBuckets.set(clientName, { windowStartedAt: now, count: 1 });
      return {
        allowed: true,
        reason: "ok",
        remainingToolCallsThisMinute: Math.max(0, max - 1),
      };
    }
    if (bucket.count >= max) {
      return {
        allowed: false,
        reason: "maxToolCallsPerMinute",
        resetAt: new Date(bucket.windowStartedAt + minuteMs).toISOString(),
        remainingToolCallsThisMinute: 0,
      };
    }
    bucket.count += 1;
    return {
      allowed: true,
      reason: "ok",
      remainingToolCallsThisMinute: Math.max(0, max - bucket.count),
    };
  }
}

const RUN_BUDGET_OPERATIONS = [
  "run.start",
  "review.auto",
  "rerun.start",
  "backlog.run",
] as const;

export function checkMutationBudget(
  db: Database.Database,
  config: McpConfig,
  input: {
    clientName: string;
    operationType: string;
    targetId: string;
    idempotencyKey: string;
    now?: Date;
  },
): LimitDecision {
  if (existingOperation(db, input)) {
    return { allowed: true, reason: "idempotency_replay" };
  }

  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const actor = `mcp:${input.clientName}`;
  const mutationCount = countOperationsSince(db, {
    actor,
    since,
  });
  if (mutationCount >= config.limits.maxMutationOperationsPerHour) {
    return denied(
      "maxMutationOperationsPerHour",
      config.limits.maxMutationOperationsPerHour,
      resetAtForOldest(db, { actor, since }),
    );
  }

  if (RUN_BUDGET_OPERATIONS.includes(input.operationType as RunBudgetOperation)) {
    const runCount = countOperationsSince(db, {
      actor,
      since,
      operationTypes: RUN_BUDGET_OPERATIONS,
    });
    if (runCount >= config.limits.maxRunsPerHour) {
      return denied(
        "maxRunsPerHour",
        config.limits.maxRunsPerHour,
        resetAtForOldest(db, { actor, since, operationTypes: RUN_BUDGET_OPERATIONS }),
      );
    }

    const concurrent = countConcurrentRuns(db, actor);
    if (concurrent >= config.limits.maxConcurrentRuns) {
      return denied("maxConcurrentRuns", config.limits.maxConcurrentRuns);
    }

    return {
      allowed: true,
      reason: "ok",
      remainingRunsThisHour: Math.max(0, config.limits.maxRunsPerHour - runCount - 1),
      remainingMutationOperationsThisHour: Math.max(
        0,
        config.limits.maxMutationOperationsPerHour - mutationCount - 1,
      ),
    };
  }

  return {
    allowed: true,
    reason: "ok",
    remainingMutationOperationsThisHour: Math.max(
      0,
      config.limits.maxMutationOperationsPerHour - mutationCount - 1,
    ),
  };
}

export function assertMutationBudget(
  db: Database.Database,
  config: McpConfig,
  input: {
    clientName: string;
    operationType: string;
    targetId: string;
    idempotencyKey: string;
    now?: Date;
  },
): void {
  const decision = checkMutationBudget(db, config, input);
  if (!decision.allowed) {
    throw new McpMutationBudgetExceededError(decision);
  }
}

type RunBudgetOperation = (typeof RUN_BUDGET_OPERATIONS)[number];

function existingOperation(
  db: Database.Database,
  input: { operationType: string; targetId: string; idempotencyKey: string },
): boolean {
  return (
    db
      .prepare(
        `SELECT 1
           FROM operations
          WHERE operation_type = ?
            AND target_id = ?
            AND idempotency_key = ?
          LIMIT 1`,
      )
      .get(input.operationType, input.targetId, input.idempotencyKey) !== undefined
  );
}

function countOperationsSince(
  db: Database.Database,
  input: {
    actor: string;
    since: string;
    operationTypes?: readonly string[];
  },
): number {
  const params: unknown[] = [input.actor, input.since];
  let sql =
    `SELECT count(*) AS n
       FROM operations
      WHERE actor = ?
        AND dry_run = 0
        AND created_at >= ?`;
  if (input.operationTypes !== undefined) {
    sql += ` AND operation_type IN (${input.operationTypes.map(() => "?").join(", ")})`;
    params.push(...input.operationTypes);
  }
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

function countConcurrentRuns(db: Database.Database, actor: string): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS n
           FROM operations
          WHERE actor = ?
            AND dry_run = 0
            AND status IN ('pending', 'running')
            AND operation_type IN (${RUN_BUDGET_OPERATIONS.map(() => "?").join(", ")})`,
      )
      .get(actor, ...RUN_BUDGET_OPERATIONS) as { n: number }
  ).n;
}

function resetAtForOldest(
  db: Database.Database,
  input: {
    actor: string;
    since: string;
    operationTypes?: readonly string[];
  },
): string | undefined {
  const params: unknown[] = [input.actor, input.since];
  let sql =
    `SELECT created_at
       FROM operations
      WHERE actor = ?
        AND dry_run = 0
        AND created_at >= ?`;
  if (input.operationTypes !== undefined) {
    sql += ` AND operation_type IN (${input.operationTypes.map(() => "?").join(", ")})`;
    params.push(...input.operationTypes);
  }
  sql += " ORDER BY created_at ASC LIMIT 1";
  const row = db.prepare(sql).get(...params) as { created_at: string } | undefined;
  if (row === undefined) return undefined;
  return new Date(Date.parse(row.created_at) + 60 * 60 * 1000).toISOString();
}

function denied(limit: string, max: number, resetAt?: string): LimitDecision {
  return {
    allowed: false,
    reason: limit,
    limit,
    max,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}
