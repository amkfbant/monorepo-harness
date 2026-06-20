import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  recordAgentUsage,
  type AgentUsageTurnInput,
} from "../../../src/db/repositories/agent-usage.js";

export function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-agent-usage-helpers-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

/**
 * Write a claude external invocation (tool='claude', role='external').
 * onError throws so test failures are loud — production path is fail-open.
 */
export function writeClaudeExternal(
  db: Database.Database,
  a: {
    sessionId: string;
    agentId: string;
    agentType?: string;
    model?: string;
    turns: AgentUsageTurnInput[];
  },
): void {
  recordAgentUsage({
    db,
    tool: "claude",
    role: "external",
    usageSource: "parsed_log",
    sessionId: a.sessionId,
    agentId: a.agentId,
    agentType: a.agentType,
    externalLabel: "ops-subagent",
    model: a.model,
    turns: a.turns,
    onError: (e) => {
      throw e;
    },
  });
}

/**
 * Write a claude internal invocation (tool='claude', role=coder|reviewer|evaluator).
 * onError throws so test failures are loud.
 */
export function writeClaudeInternal(
  db: Database.Database,
  a: {
    runId: string;
    role: "coder" | "reviewer" | "evaluator";
    model?: string;
    turns: AgentUsageTurnInput[];
  },
): void {
  recordAgentUsage({
    db,
    tool: "claude",
    role: a.role,
    usageSource: "exact",
    runId: a.runId,
    model: a.model,
    turns: a.turns,
    onError: (e) => {
      throw e;
    },
  });
}

export function countInvocations(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM agent_invocation").get() as {
      n: number;
    }
  ).n;
}

export function countTurns(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM agent_usage_turn").get() as {
      n: number;
    }
  ).n;
}
