import type { McpConfig, McpMode } from "./config.js";

export type McpToolKind = "read" | "dry-run" | "mutation" | "dangerous";

export interface McpPermissionRequest {
  toolName: string;
  kind: McpToolKind;
  projectId?: string | null;
  clientMode: McpMode;
}

export interface McpPermissionDecision {
  allowed: boolean;
  mode: "read" | "dry-run" | "mutation" | "confirmation-required";
  reason: string;
  requiredConfirmation?: boolean;
  limits?: {
    remainingRunsThisHour?: number;
    remainingToolCallsThisMinute?: number;
  };
}

export interface ResolvedMcpClientPermission {
  clientName: string;
  clientId: string | null;
  mode: McpMode;
  allowedOperations: string[];
  requireConfirmation: string[];
}

export function resolveMcpClientPermission(
  config: McpConfig,
  clientName: string,
): ResolvedMcpClientPermission {
  const matched = config.clients.find((c) => c.names.includes(clientName));
  return {
    clientName,
    clientId: matched?.id ?? null,
    mode: matched?.mode ?? config.defaultMode,
    allowedOperations: [...config.allowedOperations],
    requireConfirmation: [...config.requireConfirmation],
  };
}

export function modeForClient(config: McpConfig, clientName: string): McpMode {
  return resolveMcpClientPermission(config, clientName).mode;
}

export function operationNameForTool(toolName: string): string {
  return toolName.startsWith("harness.")
    ? toolName.slice("harness.".length)
    : toolName;
}

export function isProjectAllowed(
  config: McpConfig,
  projectId: string | null | undefined,
): boolean {
  if (projectId === null || projectId === undefined) return true;
  if (config.allowedProjects.length === 0) return true;
  return config.allowedProjects.includes(projectId);
}

export function decideMcpPermission(
  config: McpConfig,
  request: McpPermissionRequest,
): McpPermissionDecision {
  if (!config.enabled) {
    return {
      allowed: false,
      mode: request.kind === "read" ? "read" : "dry-run",
      reason: "mcp_disabled",
    };
  }

  if (!isProjectAllowed(config, request.projectId)) {
    return {
      allowed: false,
      mode: request.kind === "read" ? "read" : "dry-run",
      reason: "project_not_allowed",
    };
  }

  const operation = operationNameForTool(request.toolName);
  if (config.deniedOperations.includes(operation)) {
    return {
      allowed: false,
      mode: request.kind === "read" ? "read" : "dry-run",
      reason: "operation_denied",
    };
  }

  if (
    request.kind === "dangerous" ||
    config.requireConfirmation.includes(operation)
  ) {
    if (request.kind !== "read" && request.clientMode !== "guarded-mutation") {
      return {
        allowed: false,
        mode: request.kind === "dry-run" ? "dry-run" : "mutation",
        reason: "dangerous_disabled_for_client",
      };
    }
    return {
      allowed: true,
      mode: "confirmation-required",
      reason: "confirmation_required",
      requiredConfirmation: true,
    };
  }

  if (request.kind === "read") {
    return { allowed: true, mode: "read", reason: "read_allowed" };
  }

  if (request.kind === "dry-run") {
    if (request.clientMode === "read-only") {
      return {
        allowed: false,
        mode: "dry-run",
        reason: "dry_run_disabled_for_client",
      };
    }
    return { allowed: true, mode: "dry-run", reason: "dry_run_allowed" };
  }

  if (request.kind === "mutation") {
    if (request.clientMode !== "guarded-mutation") {
      return {
        allowed: false,
        mode: "mutation",
        reason: "mutation_disabled_for_client",
      };
    }
    if (!config.allowedOperations.includes(operation)) {
      return {
        allowed: false,
        mode: "mutation",
        reason: "operation_not_allowlisted",
      };
    }
    return { allowed: true, mode: "mutation", reason: "mutation_allowed" };
  }

  return {
    allowed: false,
    mode: "mutation",
    reason: "unknown_tool_kind",
  };
}
