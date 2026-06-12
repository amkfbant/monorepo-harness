import { randomUUID } from "node:crypto";
import { harnessVersion } from "../config/version.js";
import type { McpConfig } from "./security/config.js";
import { McpRateLimiter } from "./security/limits.js";
import { decideMcpPermission, modeForClient } from "./security/permissions.js";
import { getMcpTool, listMcpTools } from "./registry/tool-registry.js";
import {
  MCP_RESOURCE_TEMPLATES,
  MCP_STATIC_RESOURCES,
  resolveMcpResourceRead,
  resourceContentFromResult,
} from "./registry/resource-registry.js";
import { MCP_PROMPTS, getMcpPrompt } from "./registry/prompt-registry.js";
import { parseToolArgs } from "./schemas/common.js";
import {
  errorResult,
  permissionDenied,
  redactMcpToolResult,
  toMcpToolResponse,
  type HarnessMcpToolResult,
} from "./schemas/outputs.js";
import {
  completeMcpToolInvocation,
  recordMcpSessionEnd,
  recordMcpSessionStart,
  shouldAuditMcpTool,
  startMcpToolInvocation,
} from "./audit/mcp-audit.js";
import { createMcpConfirmationRequest } from "./security/confirmation.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface McpServerOptions {
  harnessRoot: string;
  config: McpConfig;
  clientName?: string;
  clientVersion?: string;
  transport: "stdio" | "http";
  sessionId?: string;
}

export type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}

function requestId(req: JsonRpcRequest): JsonRpcId | undefined {
  return Object.prototype.hasOwnProperty.call(req, "id") ? req.id ?? null : undefined;
}

function isAllowedNotification(method: string): boolean {
  return method.startsWith("notifications/");
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return data === undefined
    ? { jsonrpc: "2.0", id, error: { code, message } }
    : { jsonrpc: "2.0", id, error: { code, message, data } };
}

export class HarnessMcpServer {
  private clientName: string;
  private clientVersion: string | undefined;
  private reportedClientName: string | undefined;
  private reportedClientVersion: string | undefined;
  private readonly rateLimiter = new McpRateLimiter();
  private sessionRecorded = false;
  readonly sessionId: string;

  constructor(private readonly opts: McpServerOptions) {
    this.clientName =
      opts.clientName ?? process.env.MCP_CLIENT_NAME ?? "unknown";
    this.clientVersion = opts.clientVersion;
    this.sessionId = opts.sessionId ?? `mcpsess_${randomUUID()}`;
  }

  async handleMessage(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isRequest(message)) {
      return failure(null, -32600, "Invalid JSON-RPC request");
    }
    const id = requestId(message);
    if (id === undefined) {
      if (isAllowedNotification(message.method)) return undefined;
      return failure(null, -32600, "MCP requests must include an id");
    }
    try {
      const result = await this.dispatch(message.method, message.params);
      return success(id, result);
    } catch (e) {
      const err = e as Error;
      return failure(id, -32603, err.message, { name: err.name });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: listMcpTools() };
      case "tools/call":
        return this.callTool(params);
      case "resources/list":
        return { resources: MCP_STATIC_RESOURCES };
      case "resources/templates/list":
        return { resourceTemplates: MCP_RESOURCE_TEMPLATES };
      case "resources/read":
        return this.readResource(params);
      case "prompts/list":
        return {
          prompts: MCP_PROMPTS.map((p) => ({
            name: p.name,
            title: p.title,
            description: p.description,
            arguments: p.arguments,
          })),
        };
      case "prompts/get":
        return this.getPrompt(params);
      default:
        throw new Error(`unknown MCP method: ${method}`);
    }
  }

  private initialize(params: unknown): Record<string, unknown> {
    const p = params as
      | {
          clientInfo?: { name?: unknown; version?: unknown };
        }
      | undefined;
    const info = p?.clientInfo;
    if (typeof info?.name === "string" && info.name.length > 0) {
      this.reportedClientName = info.name;
    }
    if (typeof info?.version === "string" && info.version.length > 0) {
      this.reportedClientVersion = info.version;
    }
    this.ensureSessionRecorded();
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: {
        name: "monorepo-harness",
        version: harnessVersion(),
      },
    };
  }

  private async callTool(params: unknown): Promise<unknown> {
    const p = params as { name?: unknown; arguments?: unknown } | undefined;
    const name = typeof p?.name === "string" ? p.name : "";
    const tool = getMcpTool(name);
    if (tool === undefined) {
      return toMcpToolResponse(errorResult(`unknown tool: ${name}`));
    }
    const audit = shouldAuditMcpTool(tool.kind, this.opts.config);
    let invocationId: string | undefined;
    if (audit) {
      this.ensureSessionRecorded();
      invocationId = startMcpToolInvocation({
        harnessRoot: this.opts.harnessRoot,
        sessionId: this.sessionId,
        toolName: tool.name,
        args: p?.arguments ?? {},
      });
    }
    const completeAudit = (result: HarnessMcpToolResult): void => {
      if (invocationId === undefined) return;
      completeMcpToolInvocation({
        harnessRoot: this.opts.harnessRoot,
        invocationId,
        resultStatus: result.status,
        ...(result.operationId !== undefined ? { operationId: result.operationId } : {}),
        ...(result.confirmationId !== undefined ? { confirmationId: result.confirmationId } : {}),
        ...(result.status === "error" || result.status === "permission_denied"
          ? { errorMessage: result.summary }
          : {}),
      });
    };

    try {
      const limit = this.rateLimiter.checkToolCall(
        this.opts.config,
        this.clientName,
      );
      if (!limit.allowed) {
        const result = permissionDenied(`MCP rate limit exceeded: ${limit.reason}`, {
          limit: limit.reason,
          ...(limit.resetAt !== undefined ? { resetAt: limit.resetAt } : {}),
        });
        completeAudit(result);
        return toMcpToolResponse(result);
      }

      const parsed = parseToolArgs(tool.argsSchema, p?.arguments ?? {});
      if (!parsed.ok) {
        const result = errorResult(`invalid arguments for ${tool.name}: ${parsed.message}`);
        completeAudit(result);
        return toMcpToolResponse(result);
      }

      const clientMode = modeForClient(this.opts.config, this.clientName);
      const toolContext = {
        harnessRoot: this.opts.harnessRoot,
        config: this.opts.config,
        clientName: this.clientName,
        sessionId: this.sessionId,
      };
      const projectId =
        tool.projectIdFromArgs?.(parsed.data) ??
        (await tool.resolveProjectIdForPermission?.(parsed.data, toolContext));
      const permissionRequest = {
        toolName: tool.name,
        kind: tool.kind,
        clientMode,
        ...(projectId !== undefined ? { projectId } : {}),
      };
      const decision = decideMcpPermission(this.opts.config, permissionRequest);
      if (!decision.allowed) {
        const result = permissionDenied(`MCP permission denied: ${decision.reason}`, {
          operation: tool.operation,
          reason: decision.reason,
        });
        completeAudit(result);
        return toMcpToolResponse(result);
      }
      if (tool.kind === "mutation" && decision.requiredConfirmation === true) {
        const preview: HarnessMcpToolResult = {
          status: "dry_run",
          summary: `would execute ${tool.operation} after confirmation`,
          data: {
            operation: tool.operation,
            toolName: tool.name,
            arguments: parsed.data,
            permission: {
              mode: decision.mode,
              reason: decision.reason,
            },
          },
        };
        const target =
          projectId !== undefined && projectId !== null
            ? { type: "project", id: projectId }
            : undefined;
        const row = createMcpConfirmationRequest({
          context: toolContext,
          toolName: tool.name,
          operationType: tool.operation,
          ...(target !== undefined ? { target } : {}),
          input: parsed.data,
          preview,
        });
        const responsePreview = redactMcpToolResult(preview);
        const result: HarnessMcpToolResult = {
          status: "confirmation_required",
          summary: `${tool.operation} requires confirmation`,
          confirmationId: row.confirmationId,
          data: {
            operation: tool.operation,
            target: target ?? null,
            expiresAt: row.expiresAt,
            preview: responsePreview,
          },
          nextActions: [
            {
              label: "Review confirmation",
              command: `harness operation confirm ${row.confirmationId} --preview`,
            },
            {
              label: "Confirm out of band",
              command: `harness operation confirm ${row.confirmationId} --yes`,
            },
            {
              label: "Reject",
              command: `harness operation reject ${row.confirmationId}`,
            },
          ],
        };
        completeAudit(result);
        return toMcpToolResponse(result);
      }

      const result = await tool.handler(parsed.data, {
        ...toolContext,
        permissionDecision: decision,
      });
      completeAudit(result);
      return toMcpToolResponse(result);
    } catch (e) {
      const result = errorResult((e as Error).message);
      completeAudit(result);
      return toMcpToolResponse(result);
    }
  }

  close(): void {
    if (!this.sessionRecorded) return;
    recordMcpSessionEnd({
      harnessRoot: this.opts.harnessRoot,
      sessionId: this.sessionId,
    });
  }

  private ensureSessionRecorded(): void {
    if (this.sessionRecorded) return;
    this.sessionRecorded = recordMcpSessionStart({
      harnessRoot: this.opts.harnessRoot,
      sessionId: this.sessionId,
      clientName: this.clientName,
      ...(this.clientVersion !== undefined ? { clientVersion: this.clientVersion } : {}),
      ...(this.reportedClientName !== undefined
        ? { reportedClientName: this.reportedClientName }
        : {}),
      ...(this.reportedClientVersion !== undefined
        ? { reportedClientVersion: this.reportedClientVersion }
        : {}),
      transport: this.opts.transport,
      config: this.opts.config,
    });
  }

  private async readResource(params: unknown): Promise<Record<string, unknown>> {
    const p = params as { uri?: unknown } | undefined;
    const uri = typeof p?.uri === "string" ? p.uri : "";
    const target = resolveMcpResourceRead(uri);
    const toolContext = {
      harnessRoot: this.opts.harnessRoot,
      config: this.opts.config,
      clientName: this.clientName,
      sessionId: this.sessionId,
    };
    let result: HarnessMcpToolResult;
    if (target === null) {
      result = errorResult("invalid resource URI", { uri });
    } else {
      const clientMode = modeForClient(this.opts.config, this.clientName);
      const tool = getMcpTool(target.toolName);
      let projectId: string | null | undefined;
      let permissionToolName = target.toolName;
      if (tool !== undefined) {
        permissionToolName = tool.name;
        const parsed = parseToolArgs(tool.argsSchema, target.permissionArgs);
        if (!parsed.ok) {
          result = errorResult(
            `invalid resource permission arguments: ${parsed.message}`,
            { uri, toolName: tool.name },
          );
          return {
            contents: [
              resourceContentFromResult(
                target.uri,
                target.mimeType,
                result,
                this.opts.config.resources.maxResourceBytes,
              ),
            ],
          };
        }
        projectId =
          tool.projectIdFromArgs?.(parsed.data) ??
          (await tool.resolveProjectIdForPermission?.(parsed.data, toolContext));
      }
      const decision = decideMcpPermission(this.opts.config, {
        toolName: permissionToolName,
        kind: "read",
        clientMode,
        ...(projectId !== undefined ? { projectId } : {}),
      });
      if (!decision.allowed || decision.requiredConfirmation === true) {
        result = permissionDenied(`MCP permission denied: ${decision.reason}`, {
          reason: decision.reason,
          uri,
        });
      } else {
        let extraDenied:
          | { operation: string; reason: string }
          | undefined;
        for (const operation of target.additionalOperations) {
          const extra = decideMcpPermission(this.opts.config, {
            toolName: `harness.${operation}`,
            kind: "read",
            clientMode,
            ...(projectId !== undefined ? { projectId } : {}),
          });
          if (!extra.allowed || extra.requiredConfirmation === true) {
            extraDenied = { operation, reason: extra.reason };
            break;
          }
        }
        result =
          extraDenied === undefined
            ? await target.read(toolContext)
            : permissionDenied(`MCP permission denied: ${extraDenied.reason}`, {
                reason: extraDenied.reason,
                operation: extraDenied.operation,
                uri,
              });
      }
    }
    return {
      contents: [
        resourceContentFromResult(
          target?.uri ?? uri,
          target?.mimeType ?? "application/json",
          result,
          this.opts.config.resources.maxResourceBytes,
        ),
      ],
    };
  }

  private getPrompt(params: unknown): Record<string, unknown> {
    const p = params as
      | { name?: unknown; arguments?: Record<string, unknown> }
      | undefined;
    const name = typeof p?.name === "string" ? p.name : "";
    const prompt = getMcpPrompt(name);
    if (prompt === undefined) {
      throw new Error(`unknown prompt: ${name}`);
    }
    for (const arg of prompt.arguments) {
      if (arg.required === true) {
        const value = p?.arguments?.[arg.name];
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(`missing required prompt argument: ${arg.name}`);
        }
      }
    }
    return {
      description: prompt.description,
      messages: prompt.buildMessages(p?.arguments ?? {}),
    };
  }
}
