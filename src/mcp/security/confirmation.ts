import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { redactMcpJsonText, redactMcpText } from "../audit/redaction.js";

export type McpConfirmationStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "expired"
  | "consumed";

export interface McpConfirmationRow {
  confirmationId: string;
  clientName: string;
  actor: string;
  toolName: string;
  operationType: string;
  targetType: string | null;
  targetId: string | null;
  inputJson: string;
  previewJson: string;
  permissionSnapshotJson: string;
  status: McpConfirmationStatus;
  createdAt: string;
  expiresAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  consumedOperationId: string | null;
  errorMessage: string | null;
}

export type McpConfirmationListRow = Omit<McpConfirmationRow, "permissionSnapshotJson">;

export interface CreateConfirmationInput {
  context: McpToolContext;
  toolName: string;
  operationType: string;
  target?: { type: string; id: string };
  input: unknown;
  preview: HarnessMcpToolResult;
}

export class McpConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfirmationError";
  }
}

export function createMcpConfirmationRequest(
  input: CreateConfirmationInput,
): McpConfirmationRow {
  const paths = harnessPaths(input.context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    throw new McpConfirmationError("harness DB is not initialized");
  }
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + input.context.config.confirmation.ttlSeconds * 1000,
  );
  const confirmationId = `mcpconf-${randomUUID()}`;
  const handle = openManagedDb({ dbPath: paths.dbPath, lockPath: paths.dbLockPath });
  try {
    runMigrations(handle.db);
    handle.db
      .prepare(
        `INSERT INTO mcp_confirmation_requests
           (confirmation_id, client_name, actor, tool_name, operation_type,
            target_type, target_id, input_json, preview_json,
            permission_snapshot_json, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        confirmationId,
        input.context.clientName,
        `mcp:${input.context.clientName}`,
        input.toolName,
        input.operationType,
        input.target?.type ?? null,
        input.target?.id ?? null,
        JSON.stringify(input.input ?? {}),
        JSON.stringify(input.preview),
        JSON.stringify(input.context.config),
        now.toISOString(),
        expiresAt.toISOString(),
      );
    return getConfirmation(handle.db, confirmationId) as McpConfirmationRow;
  } finally {
    handle.close();
  }
}

export function getMcpConfirmationRequest(
  harnessRoot: string,
  confirmationId: string,
): McpConfirmationRow | null {
  const paths = harnessPaths(harnessRoot);
  if (!existsSync(paths.dbPath)) return null;
  const handle = openManagedDb({
    dbPath: paths.dbPath,
    lockPath: paths.dbLockPath,
    readonly: true,
  });
  try {
    return getConfirmation(handle.db, confirmationId);
  } finally {
    handle.close();
  }
}

export function markMcpConfirmationConfirmed(
  harnessRoot: string,
  confirmationId: string,
  confirmedBy: string,
): McpConfirmationRow {
  return mutateConfirmation(harnessRoot, confirmationId, (db, row) => {
    assertPending(row);
    db.prepare(
      `UPDATE mcp_confirmation_requests
          SET status = 'confirmed',
              confirmed_by = ?,
              confirmed_at = ?
        WHERE confirmation_id = ?`,
    ).run(confirmedBy, new Date().toISOString(), confirmationId);
  });
}

export function rejectMcpConfirmationRequest(
  harnessRoot: string,
  confirmationId: string,
  confirmedBy: string,
): McpConfirmationRow {
  return mutateConfirmation(harnessRoot, confirmationId, (db, row) => {
    assertPending(row);
    db.prepare(
      `UPDATE mcp_confirmation_requests
          SET status = 'rejected',
              confirmed_by = ?,
              confirmed_at = ?
        WHERE confirmation_id = ?`,
    ).run(confirmedBy, new Date().toISOString(), confirmationId);
  });
}

export function consumeMcpConfirmationRequest(
  harnessRoot: string,
  confirmationId: string,
  operationId: string | null,
): McpConfirmationRow {
  return mutateConfirmation(harnessRoot, confirmationId, (db, row) => {
    if (row.status !== "confirmed") {
      throw new McpConfirmationError(
        `confirmation ${confirmationId} is ${row.status}, expected confirmed`,
      );
    }
    db.prepare(
      `UPDATE mcp_confirmation_requests
          SET status = 'consumed',
              consumed_operation_id = ?
        WHERE confirmation_id = ?`,
    ).run(operationId, confirmationId);
  });
}

export function failMcpConfirmationRequest(
  harnessRoot: string,
  confirmationId: string,
  errorMessage: string,
): McpConfirmationRow {
  return mutateConfirmation(harnessRoot, confirmationId, (db, row) => {
    if (row.status !== "confirmed") {
      throw new McpConfirmationError(
        `confirmation ${confirmationId} is ${row.status}, expected confirmed`,
      );
    }
    db.prepare(
      `UPDATE mcp_confirmation_requests
          SET status = 'consumed',
              consumed_operation_id = NULL,
              error_message = ?
        WHERE confirmation_id = ?`,
    ).run(redactMcpText(errorMessage), confirmationId);
  });
}

export function listMcpConfirmationRequests(
  harnessRoot: string,
  input: { status?: McpConfirmationStatus; limit: number },
): McpConfirmationListRow[] {
  const paths = harnessPaths(harnessRoot);
  if (!existsSync(paths.dbPath)) return [];
  const handle = openManagedDb({
    dbPath: paths.dbPath,
    lockPath: paths.dbLockPath,
    readonly: true,
  });
  try {
    const params: unknown[] = [];
    let sql =
      `SELECT confirmation_id, client_name, actor, tool_name, operation_type,
	              target_type, target_id, input_json, preview_json, status,
	              created_at, expires_at, confirmed_by, confirmed_at,
	              consumed_operation_id, permission_snapshot_json, error_message
	         FROM mcp_confirmation_requests`;
    if (input.status !== undefined) {
      sql += " WHERE status = ?";
      params.push(input.status);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(input.limit);
    const rows = handle.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => redactMcpConfirmationRow(toRow(row)));
  } finally {
    handle.close();
  }
}

export function redactMcpConfirmationRow(
  row: McpConfirmationRow,
): McpConfirmationListRow {
  return {
    confirmationId: row.confirmationId,
    clientName: row.clientName,
    actor: row.actor,
    toolName: row.toolName,
    operationType: row.operationType,
    targetType: row.targetType,
    targetId: row.targetId,
    inputJson: redactMcpJsonText(row.inputJson),
    previewJson: redactMcpJsonText(row.previewJson),
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
    consumedOperationId: row.consumedOperationId,
    errorMessage:
      row.errorMessage === null ? null : String(redactMcpJsonText(JSON.stringify(row.errorMessage))).slice(1, -1),
  };
}

function mutateConfirmation(
  harnessRoot: string,
  confirmationId: string,
  mutate: (db: Database.Database, row: McpConfirmationRow) => void,
): McpConfirmationRow {
  const paths = harnessPaths(harnessRoot);
  if (!existsSync(paths.dbPath)) {
    throw new McpConfirmationError("harness DB is not initialized");
  }
  const handle = openManagedDb({ dbPath: paths.dbPath, lockPath: paths.dbLockPath });
  try {
    runMigrations(handle.db);
    const row = getConfirmation(handle.db, confirmationId);
    if (row === null) {
      throw new McpConfirmationError(`confirmation ${confirmationId} not found`);
    }
    if (row.status === "pending" && Date.parse(row.expiresAt) <= Date.now()) {
      handle.db
        .prepare(
          `UPDATE mcp_confirmation_requests
              SET status = 'expired'
            WHERE confirmation_id = ? AND status = 'pending'`,
        )
        .run(confirmationId);
      throw new McpConfirmationError(`confirmation ${confirmationId} expired`);
    }
    mutate(handle.db, row);
    return getConfirmation(handle.db, confirmationId) as McpConfirmationRow;
  } finally {
    handle.close();
  }
}

function assertPending(row: McpConfirmationRow): void {
  if (row.status !== "pending") {
    throw new McpConfirmationError(
      `confirmation ${row.confirmationId} is ${row.status}, expected pending`,
    );
  }
}

function getConfirmation(
  db: Database.Database,
  confirmationId: string,
): McpConfirmationRow | null {
  const row = db
    .prepare(
	      `SELECT confirmation_id, client_name, actor, tool_name, operation_type,
	              target_type, target_id, input_json, preview_json, status,
	              created_at, expires_at, confirmed_by, confirmed_at,
	              consumed_operation_id, permission_snapshot_json, error_message
	         FROM mcp_confirmation_requests
	        WHERE confirmation_id = ?`,
    )
    .get(confirmationId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toRow(row);
}

function toRow(r: Record<string, unknown>): McpConfirmationRow {
  return {
    confirmationId: r.confirmation_id as string,
    clientName: r.client_name as string,
    actor: r.actor as string,
    toolName: r.tool_name as string,
    operationType: r.operation_type as string,
    targetType: (r.target_type as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    inputJson: r.input_json as string,
    previewJson: r.preview_json as string,
    permissionSnapshotJson: r.permission_snapshot_json as string,
    status: r.status as McpConfirmationStatus,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    confirmedBy: (r.confirmed_by as string | null) ?? null,
    confirmedAt: (r.confirmed_at as string | null) ?? null,
    consumedOperationId: (r.consumed_operation_id as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
  };
}
