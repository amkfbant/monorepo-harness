// mutation-tools の runMcpOperation engine + preview/confirmation/resolver 層。

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";
import { runOperation, OperationInFlightError, OperationReplayedFailureError } from "../../operations/operation-runner.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, permissionDenied, redactMcpToolResult } from "../schemas/outputs.js";
import { redactMcpAuditValue } from "../audit/redaction.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { withReadonlyDb, parseJson } from "./tool-helpers.js";
import { dbArchivePreviewTool, projectIdsForDoctorFinding } from "./dry-run-tools.js";
import { createMcpConfirmationRequest, getMcpConfirmationRequest } from "../security/confirmation.js";
import { assertMutationBudget, McpMutationBudgetExceededError } from "../security/limits.js";

import { HitchRepository } from "../../hitch/repository.js";

import { assertHitchCanStartMutation, HitchMutationGateError, type HitchLinkedMutationKind } from "../../hitch/mutation-gate.js";
import { syncHitchStatusForConvergence } from "../../hitch/convergence-status.js";

import { findRepairFor } from "../../db/repair.js";

import type { DbArchiveApplyArgs, DbRepairApplyArgs, MutationBaseArgs } from "./mutation-types.js";
import { uniqueStrings } from "./mutation-types.js";
import { loadDoctorFinding, operationSummary, parseCandidateId } from "./mutation-helpers-low.js";

export interface ArchiveOutTarget {
  archiveDir: string;
  defaultOutPath: string;
  outPath: string;
  existingTarget: boolean;
}

export function createArchiveId(): string {
  return `archive-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export function resolveArchiveOutPath(
  context: McpToolContext,
  out: string | undefined,
  archiveId: string,
): ArchiveOutTarget | HarnessMcpToolResult {
  const archiveDir = resolve(context.harnessRoot, ".harness", "archives");
  const defaultOutPath = resolve(archiveDir, `${archiveId}.sqlite`);
  const outPath = out === undefined
    ? defaultOutPath
    : isAbsolute(out)
      ? resolve(out)
      : resolve(archiveDir, out);
  const rel = relative(archiveDir, outPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return permissionDenied("db.archive.apply out must be inside .harness/archives", {
      reason: "archive_outside_harness_archives",
      archiveDir,
      requestedOut: out ?? null,
      outPath,
    });
  }
  return {
    archiveDir,
    defaultOutPath,
    outPath,
    existingTarget: existsSync(outPath),
  };
}

export function dbArchiveApplyPreview(
  args: DbArchiveApplyArgs,
  context: McpToolContext,
  target: ArchiveOutTarget,
): HarnessMcpToolResult {
  const basePreview = dbArchivePreviewTool({ limit: 100 }, context);
  if (basePreview.status === "permission_denied" || basePreview.status === "error") {
    return basePreview;
  }
  const baseData = (basePreview.data ?? {}) as Record<string, unknown>;
  return {
    status: "dry_run",
    summary: `would create copy-only full DB archive at ${target.outPath}`,
    data: {
      dryRun: true,
      operation: "db-archive-copy",
      mode: "copy-only-full-db",
      before: args.before,
      rangeEnd: args.before,
      beforeIsMetadataOnly: true,
      outPath: target.outPath,
      defaultOutPath: target.defaultOutPath,
      archiveDir: target.archiveDir,
      archiveId: args.archiveId ?? null,
      willCopyFullDb: true,
      candidateRunsAreInformational: true,
      existingTarget: target.existingTarget,
      candidates: baseData.candidates ?? [],
      attachedArchives: baseData.attachedArchives ?? [],
    },
    warnings: [
      ...(basePreview.warnings ?? []),
      "db.archive.apply creates a copy-only full DB snapshot; before is archive metadata rangeEnd and does not filter copied rows",
      ...(target.existingTarget
        ? ["archive target already exists; confirmed execution will fail rather than overwrite it"]
        : []),
    ],
  };
}

export function staleArchiveConfirmation(
  context: McpToolContext,
  outPath: string,
): HarnessMcpToolResult | null {
  const confirmationId = context.confirmedConfirmationId;
  if (confirmationId === undefined) return null;
  const confirmation = getMcpConfirmationRequest(context.harnessRoot, confirmationId);
  if (confirmation === null) {
    return errorResult("db.archive.apply confirmation is missing");
  }
  const preview = parseJson<Record<string, unknown>>(confirmation.previewJson, {});
  const data = (preview.data as { outPath?: unknown } | undefined) ?? {};
  if (typeof data.outPath !== "string") {
    return errorResult("db.archive.apply confirmation is missing outPath binding", {
      confirmationId,
    });
  }
  if (data.outPath !== outPath) {
    return errorResult("db.archive.apply confirmation is stale: outPath changed", {
      confirmationId,
      expectedOutPath: data.outPath,
      currentOutPath: outPath,
    });
  }
  return null;
}

export function resolveDoctorFindingProjectId(
  args: { findingId: number },
  context: McpToolContext,
): string | null | undefined {
  const unresolvedProject =
    context.config.allowedProjects.length > 0
      ? "__mcp_unresolved_doctor_finding_project__"
      : undefined;
  const resolved = withReadonlyDb(context, ({ db }) => {
    const finding = loadDoctorFinding(db, args.findingId);
    if (finding === null) return unresolvedProject;
    const projects = projectIdsForDoctorFinding(db, finding);
    if (context.config.allowedProjects.length > 0) {
      if (projects.length === 0) return unresolvedProject;
      const disallowed = projects.find(
        (projectId) => !context.config.allowedProjects.includes(projectId),
      );
      if (disallowed !== undefined) return disallowed;
    }
    return projects[0];
  });
  return typeof resolved === "string" || resolved === null || resolved === undefined
    ? resolved
    : unresolvedProject;
}

export function dbRepairFindingPreview(
  args: DbRepairApplyArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const finding = loadDoctorFinding(db, args.findingId);
    if (finding === null) {
      return errorResult(`doctor finding ${args.findingId} not found`);
    }
    const projects = projectIdsForDoctorFinding(db, finding);
    if (context.config.allowedProjects.length > 0) {
      if (
        projects.length === 0 ||
        projects.some((projectId) => !context.config.allowedProjects.includes(projectId))
      ) {
        return permissionDenied("MCP permission denied: project_not_allowed", {
          reason: "project_not_allowed",
          findingId: args.findingId,
          projects,
        });
      }
    }
    const action = findRepairFor(finding);
    if (action === null) {
      return errorResult(`doctor finding ${args.findingId} has no registered repair`, {
        findingId: args.findingId,
        checkId: finding.checkId,
      });
    }
    return {
      status: "dry_run",
      summary: `would repair doctor finding ${args.findingId}`,
      data: {
        dryRun: true,
        findingId: args.findingId,
        projects,
        finding,
        repair: action.apply(db, finding, { dryRun: true }),
      },
    };
  }) as HarnessMcpToolResult;
}

export function confirmedPreviewCandidates(context: McpToolContext): Record<string, unknown>[] {
  const confirmationId = context.confirmedConfirmationId;
  if (confirmationId === undefined) {
    throw new Error("confirmed operation has no confirmation id");
  }
  const row = getMcpConfirmationRequest(context.harnessRoot, confirmationId);
  if (row === null) {
    throw new Error(`confirmation ${confirmationId} not found`);
  }
  const preview = parseJson<Record<string, unknown>>(row.previewJson, {});
  const data = preview.data;
  if (typeof data !== "object" || data === null) return [];
  const candidates = (data as { candidates?: unknown }).candidates;
  return Array.isArray(candidates)
    ? candidates.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    : [];
}

export function previewCandidateStrings(
  candidates: Record<string, unknown>[],
  key: string,
): string[] {
  return uniqueStrings(
    candidates
      .map((candidate) => candidate[key])
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

export function previewCandidateStringList(
  candidates: Record<string, unknown>[],
  key: string,
): string[] {
  return uniqueStrings(
    candidates.flatMap((candidate) => {
      const value = candidate[key];
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
    }),
  );
}

export function resolveKnowledgeCandidateProjectId(
  args: { candidateId: string },
  context: McpToolContext,
): string | null | undefined {
  const parsed = parseCandidateId(args.candidateId);
  const unresolvedProject =
    context.config.allowedProjects.length > 0
      ? "__mcp_unresolved_knowledge_candidate_project__"
      : undefined;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare("SELECT project_id FROM knowledge_candidates WHERE candidate_id = ?")
      .get(args.candidateId) as { project_id: string | null } | undefined;
    if (row?.project_id !== undefined && row.project_id !== null) return row.project_id;
    if (parsed === null) return unresolvedProject;
    const run = db
      .prepare("SELECT project_id FROM runs WHERE run_id = ?")
      .get(parsed.runId) as { project_id: string | null } | undefined;
    if (run?.project_id !== undefined && run.project_id !== null) return run.project_id;
    return unresolvedProject;
  }) as string | null | undefined;
}

export async function runMcpOperation<T>(
  context: McpToolContext,
  opts: {
    operationType: string;
    target: { type: string; id: string };
    idempotencyKey: string;
    input: unknown;
    metadata: Record<string, unknown>;
    pendingExternalExecutor?: boolean;
    work?: () => Promise<T>;
    workWithDb?: (db: Database.Database, operationId: string) => Promise<T>;
    hitchGate?: {
      hitchId: string | undefined;
      mutationKind: HitchLinkedMutationKind;
    };
  },
): Promise<HarnessMcpToolResult> {
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    return errorResult("harness DB is not initialized", { dbPath: paths.dbPath });
  }
  const operationId = `op-${randomUUID()}`;
  const handle = openManagedDb({ dbPath: paths.dbPath, lockPath: paths.dbLockPath });
  try {
    runMigrations(handle.db);
    const outcome = await runOperation(
      handle.db,
      {
        operationId,
        operationType: opts.operationType,
        target: opts.target,
        actor: `mcp:${context.clientName}`,
        idempotencyKey: opts.idempotencyKey,
        dryRun: false,
        input: redactMcpAuditValue(opts.input),
        metadata: redactMcpAuditValue(opts.metadata) as Record<string, unknown>,
        ...(opts.pendingExternalExecutor === true ? { pendingExternalExecutor: true } : {}),
        beforeStart: (db) => {
          if (opts.hitchGate?.hitchId !== undefined) {
            assertHitchCanStartMutation({
              repository: new HitchRepository(db),
              hitchId: opts.hitchGate.hitchId,
              mutationKind: opts.hitchGate.mutationKind,
              syncCreatedBy: `mcp:${context.clientName}`,
            });
          }
          assertMutationBudget(db, context.config, {
            clientName: context.clientName,
            operationType: opts.operationType,
            targetId: opts.target.id,
            idempotencyKey: opts.idempotencyKey,
          });
        },
      },
      async (opId) =>
        opts.workWithDb !== undefined
          ? opts.workWithDb(handle.db, opId)
          : (opts.work as () => Promise<T>)(),
    );
    const status = outcome.operation.status === "pending" ? "queued" : "operation_started";
    return {
      status,
      summary: `${opts.operationType} ${outcome.replayed ? "replayed" : "started"}`,
      operationId: outcome.operation.operationId,
      data: {
        operation: operationSummary(outcome.operation),
        result: outcome.result,
        replayed: outcome.replayed,
      },
      resourceLinks: [
        {
          uri: `harness://operation/${outcome.operation.operationId}`,
          name: `operation ${outcome.operation.operationId}`,
          mimeType: "application/json",
        },
      ],
    };
  } catch (e) {
    if (e instanceof McpMutationBudgetExceededError) {
      const budget = e.decision;
      return permissionDenied(e.message, {
        limit: budget.limit ?? budget.reason,
        max: budget.max ?? null,
        resetAt: budget.resetAt ?? null,
      });
    }
    if (e instanceof HitchMutationGateError) {
      const gate = e.denial;
      if (gate.convergence) {
        syncHitchStatusForConvergence(
          new HitchRepository(handle.db),
          gate.convergence,
          `mcp:${context.clientName}`,
        );
      }
      return permissionDenied(gate.message, {
        reason: gate.code,
        hitchId: opts.hitchGate?.hitchId ?? gate.convergence?.hitchId ?? null,
        mutationKind: opts.hitchGate?.mutationKind ?? null,
        ...(gate.convergence ? { convergence: gate.convergence } : {}),
      });
    }
    if (e instanceof OperationInFlightError) {
      return errorResult(e.message, { operationId: e.operationId, reason: "operation_in_flight" });
    }
    if (e instanceof OperationReplayedFailureError) {
      return errorResult(e.message, {
        operationId: e.operationId,
        reason: "idempotency_replayed_failure",
        priorStatus: e.priorStatus,
        priorErrorCode: e.priorErrorCode,
        priorErrorMessage: e.priorErrorMessage,
      });
    }
    return errorResult((e as Error).message, { operationId });
  } finally {
    handle.close();
  }
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

