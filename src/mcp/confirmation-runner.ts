import {
  consumeMcpConfirmationRequest,
  failMcpConfirmationRequest,
  getMcpConfirmationRequest,
  markMcpConfirmationConfirmed,
  rejectMcpConfirmationRequest,
  type McpConfirmationRow,
} from "./security/confirmation.js";
import {
  parseMcpConfigSnapshotJson,
  type McpConfig,
} from "./security/config.js";
import { decideMcpPermission, modeForClient } from "./security/permissions.js";
import { parseToolArgs } from "./schemas/common.js";
import { errorResult, type HarnessMcpToolResult } from "./schemas/outputs.js";
import { getMcpTool } from "./registry/tool-registry.js";
import { redactMcpText } from "./audit/redaction.js";

export interface ConfirmMcpOptions {
  harnessRoot: string;
  confirmationId: string;
  confirmedBy: string;
  config?: McpConfig;
}

export async function confirmMcpRequest(
  opts: ConfirmMcpOptions,
): Promise<HarnessMcpToolResult> {
  const before = getMcpConfirmationRequest(opts.harnessRoot, opts.confirmationId);
  if (before === null) {
    return errorResult(`confirmation ${opts.confirmationId} not found`);
  }
  const tool = getMcpTool(before.toolName);
  if (tool === undefined) {
    return errorResult(`confirmation references unknown tool ${before.toolName}`);
  }
  let config: McpConfig;
  try {
    config =
      opts.config ??
      parseMcpConfigSnapshotJson(before.permissionSnapshotJson);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const rawArgs = JSON.parse(before.inputJson) as unknown;
  const parsed = parseToolArgs(tool.argsSchema, rawArgs);
  if (!parsed.ok) {
    return errorResult(`stored confirmation arguments are invalid: ${parsed.message}`);
  }
  const context = {
    harnessRoot: opts.harnessRoot,
    config,
    clientName: before.clientName,
    sessionId: `mcpconfirm:${opts.confirmationId}`,
    confirmedConfirmationId: opts.confirmationId,
  };
  const projectId =
    tool.projectIdFromArgs?.(parsed.data) ??
    (await tool.resolveProjectIdForPermission?.(parsed.data, context));
  const decision = decideMcpPermission(config, {
    toolName: tool.name,
    kind: tool.kind,
    clientMode: modeForClient(config, before.clientName),
    ...(projectId !== undefined ? { projectId } : {}),
  });
  if (!decision.allowed) {
    return errorResult(`MCP permission denied: ${decision.reason}`, {
      reason: decision.reason,
      operation: tool.operation,
    });
  }

  try {
    markMcpConfirmationConfirmed(
      opts.harnessRoot,
      opts.confirmationId,
      opts.confirmedBy,
    );
  } catch (e) {
    return errorResult((e as Error).message);
  }

  try {
    const result = await tool.handler(parsed.data, {
      ...context,
      permissionDecision: decision,
    });
    consumeMcpConfirmationRequest(
      opts.harnessRoot,
      opts.confirmationId,
      result.operationId ?? null,
	    );
	    return result;
  } catch (e) {
    const message = (e as Error).message;
    const redactedMessage = redactMcpText(message);
    try {
      failMcpConfirmationRequest(opts.harnessRoot, opts.confirmationId, message);
    } catch {
      // The original handler failure is the actionable error for the operator.
    }
    return errorResult(redactedMessage);
  }
}

export function rejectMcpRequest(opts: ConfirmMcpOptions): McpConfirmationRow {
  return rejectMcpConfirmationRequest(
    opts.harnessRoot,
    opts.confirmationId,
    opts.confirmedBy,
  );
}
