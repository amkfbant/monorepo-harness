// read-tools 公開 MCP tool factory（#125 A15 barrel 分割）。

import { statSync } from "node:fs";

import { readSchemaVersion } from "../../db/migrations.js";
import { SCHEMA_VERSION } from "../../db/schema.js";
import { dbStats } from "../../db/maintenance.js";

import { getOperation, listOperationEvents } from "../../db/repositories/operations.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, ok } from "../schemas/outputs.js";

import type { McpToolContext } from "../registry/tool-registry.js";
import { redactMcpAuditValue } from "../audit/redaction.js";
import { decodeCursor, encodeCursor, ensureProjectVisible, normalizeLimit, parseJson, tableExists, withReadonlyDb } from "./tool-helpers.js";
import type { OperationGetArgs, OperationListArgs } from "./read-types.js";
import { listOperationPage, projectIdForOperation, toOperationData } from "./read-helpers.js";

export function dbStatusTool(
  _args: Record<string, never>,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db, dbPath }) => {
    const stats = dbStats(dbPath);
    return ok("harness DB status", {
      dbPath,
      exists: true,
      schemaVersion: readSchemaVersion(db),
      latestSchemaVersion: SCHEMA_VERSION,
      sizeBytes: statSync(dbPath).size,
      walBytes: stats.walBytes,
      totalRows: stats.totalRows,
      tableRows: stats.tableRows,
      blobs: stats.blobs,
      truncation: stats.truncation,
    });
  }) as HarnessMcpToolResult;
}

export function doctorSummaryTool(
  _args: Record<string, never>,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    if (!tableExists(db, "doctor_runs")) {
      return errorResult("doctor tables are not available in this DB schema");
    }
    const latest = db
      .prepare(
        `SELECT doctor_run_id, started_at, completed_at, status, summary_json
           FROM doctor_runs
          ORDER BY started_at DESC, doctor_run_id DESC
          LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (latest === undefined) {
      return {
        status: "ok",
        summary: "no doctor run recorded",
        data: { latest: null },
        nextActions: [{ label: "Run doctor", command: "harness db doctor" }],
      };
    }
    const latestHeader = {
      doctorRunId: latest.doctor_run_id,
      startedAt: latest.started_at,
      completedAt: latest.completed_at,
      status: latest.status,
      summary: parseJson(latest.summary_json as string, {}),
    };
    if (context.config.allowedProjects.length > 0) {
      const counts = db
        .prepare(
          `SELECT severity, status, COUNT(*) AS count
             FROM doctor_findings
            WHERE doctor_run_id = ?
            GROUP BY severity, status
            ORDER BY severity, status`,
        )
        .all(latest.doctor_run_id) as Record<string, unknown>[];
      return ok(`latest doctor run ${latest.doctor_run_id}`, {
        findingsRedacted: true,
        reason: "project_scoped_client",
        latest: {
          ...latestHeader,
          findings: counts.map((f) => ({
            severity: f.severity,
            status: f.status,
            count: f.count,
          })),
        },
      });
    }
    const findings = db
      .prepare(
        `SELECT finding_id, check_id, severity, status, message,
                repairable, details_json
           FROM doctor_findings
          WHERE doctor_run_id = ?
          ORDER BY finding_id`,
      )
      .all(latest.doctor_run_id) as Record<string, unknown>[];
    return ok(`latest doctor run ${latest.doctor_run_id}`, {
      latest: {
        ...latestHeader,
        findings: findings.map((f) => ({
          findingId: f.finding_id,
          checkId: f.check_id,
          severity: f.severity,
          status: f.status,
          message: f.message,
          repairable: f.repairable === 1,
          details: parseJson(f.details_json as string, {}),
        })),
      },
    });
  }) as HarnessMcpToolResult;
}

export function operationListTool(
  args: OperationListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const offset = decodeCursor(args.cursor);
    const page = listOperationPage(db, args, context, limit, offset);
    const operations = page.operations;
    const nextOffset = offset + operations.length;
    return ok(`listed ${operations.length} operation(s)`, {
      operations: operations.map(toOperationData),
      page: {
        limit,
        offset,
        total: page.total,
        nextCursor: nextOffset < page.total ? encodeCursor(nextOffset) : null,
      },
    });
  }) as HarnessMcpToolResult;
}

export function operationGetTool(
  args: OperationGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const operation = getOperation(db, args.operationId);
    if (operation === null) {
      return errorResult(`operation not found: ${args.operationId}`);
    }
    const denied = ensureProjectVisible(
      context.config,
      projectIdForOperation(db, operation),
    );
    if (denied !== null) return denied;
    return {
      status: "ok",
      summary: `operation ${args.operationId}`,
      data: {
        operation: toOperationData(operation),
        events: listOperationEvents(db, args.operationId).map((e) => ({
          ...e,
          message:
            e.message === null
              ? null
              : String(redactMcpAuditValue(e.message)),
          data: redactMcpAuditValue(parseJson(e.dataJson, {})),
        })),
      },
      resourceLinks: [
        {
          uri: `harness://operation/${encodeURIComponent(args.operationId)}`,
          name: "Operation",
          mimeType: "application/json",
        },
      ],
    };
  }) as HarnessMcpToolResult;
}
