// hitch tool の resolver + 内部 helper 層（convergence-split/confirmation/scope-merge 等）。

import type Database from "better-sqlite3";

import { runMcpMutationOperation } from "./operation-wrapper.js";
import { scopedIdForIdempotencyKey } from "./scoped-idempotency.js";
import { type ClassifiableHitchFinding } from "../../hitch/classification.js";
import { ConvergenceService } from "../../hitch/convergence.js";
import { evaluateConvergenceAndRecordStatus } from "../../hitch/convergence-status.js";

import { HitchRepository } from "../../hitch/repository.js";
import { parseHitchScope } from "../../hitch/schemas.js";
import type { HitchFinding, HitchFindingSource, HitchScope, HitchSession } from "../../hitch/types.js";
import { redactMcpText } from "../audit/redaction.js";
import { errorResult, permissionDenied, redactMcpToolResult, type HarnessMcpToolResult } from "../schemas/outputs.js";
import { createMcpConfirmationRequest } from "../security/confirmation.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { modeForClient } from "../security/permissions.js";
import { withReadonlyDb } from "./tool-helpers.js";
import type { HitchCloseArgs, HitchExpandScopeArgs, HitchFindingInput, MutationBaseArgs } from "./hitch-tools-types.js";
import { MAX_MCP_FINDING_TEXT_CHARS, MAX_MCP_FINDINGS } from "./hitch-tools-types.js";

export function splitRecordedConvergence(
  result: ReturnType<typeof evaluateConvergenceAndRecordStatus>,
) {
  const { decisionRecord, hitchStatus, ...convergence } = result;
  return { convergence, decisionRecord, hitchStatus };
}

export function resolveHitchProjectId(
  args: { hitchId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.hitchId === undefined) return undefined;
  const unresolved =
    context.config.allowedProjects.length > 0
      ? "__mcp_unresolved_hitch_project__"
      : undefined;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare("SELECT project_id FROM hitch_sessions WHERE hitch_id = ?")
      .get(args.hitchId) as { project_id: string | null } | undefined;
    return row?.project_id ?? unresolved;
  }) as string | null | undefined;
}

export function resolveHitchFindingProjectId(
  args: { findingId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.findingId === undefined) return undefined;
  const unresolved =
    context.config.allowedProjects.length > 0
      ? "__mcp_unresolved_hitch_finding_project__"
      : undefined;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare(
        `SELECT s.project_id
           FROM hitch_findings f
           JOIN hitch_sessions s ON s.hitch_id = f.hitch_id
          WHERE f.finding_id = ?`,
      )
      .get(args.findingId) as { project_id: string | null } | undefined;
    return row?.project_id ?? unresolved;
  }) as string | null | undefined;
}

export function runHitchOperation<T>(
  context: McpToolContext,
  opts: {
    operationType: string;
    target: { type: string; id: string };
    args: MutationBaseArgs;
    metadata: Record<string, unknown>;
    workWithDb: (db: Database.Database, operationId: string) => Promise<T> | T;
  },
): Promise<HarnessMcpToolResult> {
  return runMcpMutationOperation(context, opts);
}

export function hitchClosePreview(
  args: HitchCloseArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const hitch = repo.getSession(args.hitchId);
    if (hitch === null) return errorResult(`hitch not found: ${args.hitchId}`);
    const convergence = new ConvergenceService(repo).evaluate(args.hitchId);
    return {
      status: "dry_run",
      summary:
        convergence.decision === "close_ready"
          ? "hitch is close_ready and can be closed"
          : "would close a non-close_ready hitch after confirmation",
      data: {
        hitch,
        convergence,
        summary: redactMcpText(args.summary),
        force: args.force === true || convergence.decision !== "close_ready",
      },
    };
  }) as HarnessMcpToolResult;
}

export function confirmationResult(
  context: McpToolContext,
  toolName: string,
  operationType: string,
  args: MutationBaseArgs,
  preview: HarnessMcpToolResult,
  target: { type: string; id: string },
): HarnessMcpToolResult {
  if (preview.status === "permission_denied") return preview;
  if (preview.status === "error") return preview;
  const row = createMcpConfirmationRequest({
    context,
    toolName,
    operationType,
    target,
    input: args,
    preview,
  });
  const responsePreview = redactMcpToolResult(preview);
  return {
    status: "confirmation_required",
    summary: `${operationType} requires confirmation`,
    confirmationId: row.confirmationId,
    data: {
      operation: operationType,
      target,
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
}

export function isConfirmed(context: McpToolContext): boolean {
  return context.confirmedConfirmationId !== undefined;
}

export function ensureUnconfirmedHitchCloseAllowed(
  context: McpToolContext,
): HarnessMcpToolResult | null {
  if (modeForClient(context.config, context.clientName) !== "guarded-mutation") {
    return permissionDenied("MCP permission denied: mutation_disabled_for_client", {
      operation: "hitch.close",
      reason: "mutation_disabled_for_client",
    });
  }
  if (!context.config.allowedOperations.includes("hitch.close")) {
    return permissionDenied("MCP permission denied: operation_not_allowlisted", {
      operation: "hitch.close",
      reason: "operation_not_allowlisted",
    });
  }
  return null;
}

export function compareHitchSessions(a: HitchSession, b: HitchSession): number {
  const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
  return byUpdated === 0 ? b.hitchId.localeCompare(a.hitchId) : byUpdated;
}

export function mcpFindingPage(
  repo: HitchRepository,
  hitchId: string,
): { findings: HitchFinding[]; truncated: boolean } {
  const rows = repo.listFindings({
    hitchId,
    limit: MAX_MCP_FINDINGS + 1,
  });
  return {
    findings: rows.slice(0, MAX_MCP_FINDINGS).map(redactHitchFindingForMcp),
    truncated: rows.length > MAX_MCP_FINDINGS,
  };
}

export function redactHitchFindingForMcp(finding: HitchFinding): HitchFinding {
  return {
    ...finding,
    sourceRef: cappedNullableMcpText(finding.sourceRef),
    summary: cappedMcpText(finding.summary),
    detail: cappedNullableMcpText(finding.detail),
    suggestedFix: cappedNullableMcpText(finding.suggestedFix),
    classificationReason: cappedNullableMcpText(finding.classificationReason),
    resolutionNote: cappedNullableMcpText(finding.resolutionNote),
  };
}

export function cappedNullableMcpText(value: string | null): string | null {
  return value === null ? null : cappedMcpText(value);
}

export function cappedMcpText(value: string): string {
  const redacted = redactMcpText(value);
  if (redacted.length <= MAX_MCP_FINDING_TEXT_CHARS) return redacted;
  return `${redacted.slice(0, MAX_MCP_FINDING_TEXT_CHARS)}...[truncated]`;
}

export function hitchMetadata(
  context: McpToolContext,
  toolName: string,
  args: MutationBaseArgs,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const hitchId =
    typeof extra.hitchId === "string"
      ? extra.hitchId
      : hasStringHitchId(args)
        ? args.hitchId
        : undefined;
  return {
    source: "mcp",
    clientName: context.clientName,
    sessionId: context.sessionId,
    toolName,
    idempotencyKey: args.idempotencyKey,
    ...(hitchId !== undefined ? { hitch_id: hitchId } : {}),
    ...(args.actorNote !== undefined ? { actorNote: args.actorNote } : {}),
    ...(context.confirmedConfirmationId !== undefined
      ? { confirmationId: context.confirmedConfirmationId }
      : {}),
    ...extra,
  };
}

export function hasStringHitchId(value: unknown): value is { hitchId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { hitchId?: unknown }).hitchId === "string"
  );
}

export function hitchIdForIdempotencyKey(
  projectScope: string | null,
  idempotencyKey: string,
): string {
  return scopedIdForIdempotencyKey("hitch", projectScope, idempotencyKey);
}

export function toClassifiableFinding(
  source: HitchFindingSource,
  finding: HitchFindingInput,
): ClassifiableHitchFinding {
  return {
    source,
    severity: finding.severity,
    category: finding.category,
    summary: finding.summary,
    ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
    ...(finding.filePath !== undefined ? { filePath: finding.filePath } : {}),
    ...(finding.symbol !== undefined ? { symbol: finding.symbol } : {}),
    ...(finding.sourceRef !== undefined ? { sourceRef: finding.sourceRef } : {}),
  };
}

export function expandHitchScope(
  db: Database.Database,
  context: McpToolContext,
  args: HitchExpandScopeArgs,
): { hitchId: string; scope: HitchScope; reason: string } {
  const repo = new HitchRepository(db);
  const current = repo.requireSession(args.hitchId);
  const scope = parseHitchScope(mergeScope(current.scope, args.scope));
  const updated = repo.updateSessionConfig({
    hitchId: args.hitchId,
    scope,
    reason: redactMcpText(args.reason),
    allowScopeWiden: true,
    createdBy: `mcp:${context.clientName}`,
  });
  return {
    hitchId: args.hitchId,
    scope: updated.scope,
    reason: redactMcpText(args.reason),
  };
}

export function mergeScope(current: HitchScope, incoming: HitchScope): HitchScope {
  const scope: HitchScope = {
    ...current,
    ...incoming,
  };
  putMerged(scope, "targetFiles", current.targetFiles, incoming.targetFiles);
  putMerged(
    scope,
    "targetOperations",
    current.targetOperations,
    incoming.targetOperations,
  );
  putMerged(
    scope,
    "allowedFindingCategories",
    current.allowedFindingCategories,
    incoming.allowedFindingCategories,
  );
  putMerged(
    scope,
    "excludedCategories",
    current.excludedCategories,
    incoming.excludedCategories,
  );
  return scope;
}

export function putMerged(
  scope: HitchScope,
  key:
    | "targetFiles"
    | "targetOperations"
    | "allowedFindingCategories"
    | "excludedCategories",
  current: string[] | undefined,
  incoming: string[] | undefined,
): void {
  if (current === undefined && incoming === undefined) {
    delete scope[key];
    return;
  }
  scope[key] = [...new Set([...(current ?? []), ...(incoming ?? [])])];
}
