import { redactMcpAuditValue, redactMcpText } from "../audit/redaction.js";

export type HarnessMcpStatus =
  | "ok"
  | "dry_run"
  | "queued"
  | "operation_started"
  | "confirmation_required"
  | "permission_denied"
  | "error";

export interface HarnessMcpResourceLink {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface HarnessMcpNextAction {
  label: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  command?: string;
}

export interface HarnessMcpToolResult<T = unknown> {
  status: HarnessMcpStatus;
  summary: string;
  data?: T;
  operationId?: string;
  confirmationId?: string;
  resourceLinks?: HarnessMcpResourceLink[];
  warnings?: string[];
  nextActions?: HarnessMcpNextAction[];
}

export function ok<T>(summary: string, data?: T): HarnessMcpToolResult<T> {
  return data === undefined ? { status: "ok", summary } : { status: "ok", summary, data };
}

export function errorResult(
  summary: string,
  data?: Record<string, unknown>,
): HarnessMcpToolResult<Record<string, unknown>> {
  const safeSummary = redactMcpText(summary);
  const safeData =
    data === undefined
      ? undefined
      : (redactMcpAuditValue(data) as Record<string, unknown>);
  return safeData === undefined
    ? { status: "error", summary: safeSummary }
    : { status: "error", summary: safeSummary, data: safeData };
}

export function permissionDenied(
  summary: string,
  data?: Record<string, unknown>,
): HarnessMcpToolResult<Record<string, unknown>> {
  return data === undefined
    ? { status: "permission_denied", summary }
    : { status: "permission_denied", summary, data };
}

export function redactMcpToolResult<T extends HarnessMcpToolResult>(result: T): T {
  return redactMcpAuditValue(result) as T;
}

export function toMcpToolResponse(result: HarnessMcpToolResult): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: HarnessMcpToolResult;
  isError: boolean;
} {
  const safeResult = redactMcpToolResult(result);
  return {
    content: [
      {
        type: "text",
        text: safeResult.summary,
      },
    ],
    structuredContent: safeResult,
    isError:
      safeResult.status === "error" || safeResult.status === "permission_denied",
  };
}
