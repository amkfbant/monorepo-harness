import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";
import type { McpConfig } from "../security/config.js";
import type { McpToolKind } from "../security/permissions.js";
import { redactMcpAuditValue, redactMcpJsonText } from "./redaction.js";

export interface McpSessionAuditInput {
  harnessRoot: string;
  sessionId: string;
  clientName: string;
  clientVersion?: string;
  reportedClientName?: string;
  reportedClientVersion?: string;
  transport: string;
  config: McpConfig;
}

export interface McpInvocationStartInput {
  harnessRoot: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  startedAt?: Date;
}

export interface McpInvocationCompleteInput {
  harnessRoot: string;
  invocationId: string;
  resultStatus: string;
  operationId?: string;
  confirmationId?: string;
  errorMessage?: string;
  completedAt?: Date;
}

export function shouldAuditMcpTool(kind: McpToolKind, config: McpConfig): boolean {
  if (kind === "mutation" || kind === "dangerous") return true;
  if (kind === "dry-run") return config.audit.recordDryRuns;
  return config.audit.recordReadTools;
}

export function recordMcpSessionStart(input: McpSessionAuditInput): boolean {
  const recorded = withAuditDb(input.harnessRoot, (db) => {
    db.prepare(
      `INSERT INTO mcp_sessions
         (session_id, client_name, client_version, transport, started_at,
          permission_snapshot_json, reported_client_name, reported_client_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         client_name = excluded.client_name,
         client_version = excluded.client_version,
         permission_snapshot_json = excluded.permission_snapshot_json,
         reported_client_name = excluded.reported_client_name,
         reported_client_version = excluded.reported_client_version`,
    ).run(
      input.sessionId,
      input.clientName,
      input.clientVersion ?? null,
      input.transport,
      new Date().toISOString(),
      JSON.stringify(redactConfig(input.config)),
      input.reportedClientName ?? null,
      input.reportedClientVersion ?? null,
    );
    return true;
  });
  return recorded === true;
}

export function recordMcpSessionEnd(input: {
  harnessRoot: string;
  sessionId: string;
  endedAt?: Date;
}): void {
  withAuditDb(input.harnessRoot, (db) => {
    db.prepare(
      `UPDATE mcp_sessions
          SET ended_at = ?
        WHERE session_id = ?`,
    ).run((input.endedAt ?? new Date()).toISOString(), input.sessionId);
  });
}

export function startMcpToolInvocation(
  input: McpInvocationStartInput,
): string {
  const invocationId = `mcpinv-${randomUUID()}`;
  const argsJson = stableJson(input.args ?? {});
  withAuditDb(input.harnessRoot, (db) => {
    db.prepare(
      `INSERT INTO mcp_tool_invocations
         (invocation_id, session_id, tool_name, arguments_sha256,
          arguments_redacted_json, result_status, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      invocationId,
      input.sessionId,
      input.toolName,
      sha256(argsJson),
      JSON.stringify(redactMcpAuditValue(input.args ?? {})),
      (input.startedAt ?? new Date()).toISOString(),
    );
  });
  return invocationId;
}

export function completeMcpToolInvocation(
  input: McpInvocationCompleteInput,
): void {
  const errorMessage =
    input.errorMessage === undefined
      ? null
      : String(redactMcpAuditValue(input.errorMessage));
  withAuditDb(input.harnessRoot, (db) => {
    db.prepare(
      `UPDATE mcp_tool_invocations
          SET result_status = ?,
              operation_id = ?,
              confirmation_id = ?,
              completed_at = ?,
              error_message = ?
        WHERE invocation_id = ?`,
    ).run(
      input.resultStatus,
      input.operationId ?? null,
      input.confirmationId ?? null,
      (input.completedAt ?? new Date()).toISOString(),
      errorMessage,
      input.invocationId,
    );
  });
}

export function listMcpSessions(
  harnessRoot: string,
  limit: number,
): Array<Record<string, unknown>> {
  return withAuditDb(harnessRoot, (db) =>
    db
      .prepare(
        `SELECT session_id, client_name, client_version, transport,
                started_at, ended_at, reported_client_name,
                reported_client_version
           FROM mcp_sessions
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>,
  ) ?? [];
}

export function listMcpInvocations(
  harnessRoot: string,
  input: { sessionId?: string; limit: number },
): Array<Record<string, unknown>> {
  return withAuditDb(harnessRoot, (db) => {
    const params: unknown[] = [];
    let sql =
      `SELECT invocation_id, session_id, tool_name, arguments_sha256,
              arguments_redacted_json, result_status, operation_id,
              confirmation_id, started_at, completed_at, error_message
         FROM mcp_tool_invocations`;
    if (input.sessionId !== undefined) {
      sql += " WHERE session_id = ?";
      params.push(input.sessionId);
    }
    sql += " ORDER BY started_at DESC LIMIT ?";
    params.push(input.limit);
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      typeof row.arguments_redacted_json === "string"
        ? {
            ...row,
            arguments_redacted_json: redactMcpJsonText(row.arguments_redacted_json),
          }
        : row,
    );
  }) ?? [];
}

function withAuditDb<T>(
  harnessRoot: string,
  fn: (db: Database.Database) => T,
): T | undefined {
  const paths = harnessPaths(harnessRoot);
  if (!existsSync(paths.dbPath)) return undefined;
  const handle = openManagedDb({ dbPath: paths.dbPath, lockPath: paths.dbLockPath });
  try {
    runMigrations(handle.db);
    return fn(handle.db);
  } finally {
    handle.close();
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortJson(v)]),
  );
}

function redactConfig(config: McpConfig): McpConfig {
  return {
    ...config,
    clients: config.clients.map((c) => ({ ...c })),
  };
}
