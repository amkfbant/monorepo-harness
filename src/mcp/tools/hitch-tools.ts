import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";
import {
  OperationInFlightError,
  OperationReplayedFailureError,
  runOperation,
} from "../../operations/operation-runner.js";
import {
  classifyFindingForHitch,
  type ClassifiableHitchFinding,
} from "../../hitch/classification.js";
import { ConvergenceService } from "../../hitch/convergence.js";
import {
  evaluateConvergenceAndRecordStatus,
  recordConvergenceDecisionWithStatus,
} from "../../hitch/convergence-status.js";
import { deferFindingToBacklog } from "../../hitch/followups.js";
import { nextReviewMode } from "../../hitch/review-mode.js";
import {
  HitchRepository,
  type CreateHitchSessionInput,
  type UpsertHitchFindingInput,
} from "../../hitch/repository.js";
import { parseHitchScope } from "../../hitch/schemas.js";
import type {
  HitchCloseCheckStatus,
  HitchCloseCondition,
  HitchFinding,
  HitchFindingSeverity,
  HitchFindingSource,
  HitchPolicy,
  HitchScope,
  HitchScopeStatus,
  HitchSession,
  HitchStatus,
} from "../../hitch/types.js";
import { redactMcpAuditValue, redactMcpText } from "../audit/redaction.js";
import { errorResult, ok, permissionDenied, type HarnessMcpToolResult } from "../schemas/outputs.js";
import { createMcpConfirmationRequest } from "../security/confirmation.js";
import { assertMutationBudget, McpMutationBudgetExceededError } from "../security/limits.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { modeForClient } from "../security/permissions.js";
import { ensureProjectVisible, withReadonlyDb } from "./tool-helpers.js";

const MAX_FINDINGS_PER_CALL = 50;
const MAX_MCP_FINDINGS = 100;
const MAX_MCP_FINDING_TEXT_CHARS = 1000;

interface MutationBaseArgs {
  idempotencyKey: string;
  actorNote?: string;
}

export interface HitchListArgs {
  status?: HitchStatus;
  projectId?: string;
  repoId?: string;
  domain?: string;
  limit?: number;
}

export interface HitchIdArgs {
  hitchId: string;
}

export interface HitchStartArgs extends MutationBaseArgs {
  hitchId?: string;
  title: string;
  description?: string;
  projectId?: string;
  repoId?: string;
  domain?: string;
  backlogItemId?: string;
  scope?: HitchScope;
  closeConditions?: HitchCloseCondition[];
  policy?: HitchPolicy;
  maxIterations?: number;
  maxReviewCycles?: number;
  maxReruns?: number;
  maxTotalNewFindings?: number;
}

export interface HitchFindingInput {
  severity: HitchFindingSeverity;
  category: string;
  summary: string;
  detail?: string;
  filePath?: string;
  symbol?: string;
  suggestedFix?: string;
  source?: HitchFindingSource;
  sourceRef?: string;
  sourceAttemptId?: string;
  sourceCycleId?: string;
  scopeStatus?: HitchScopeStatus;
}

export interface HitchRecordFindingsArgs extends MutationBaseArgs {
  hitchId: string;
  findings: HitchFindingInput[];
}

export interface HitchClassifyFindingArgs extends MutationBaseArgs {
  findingId: string;
  scopeStatus: HitchScopeStatus;
  reason: string;
  duplicateOf?: string;
}

export interface HitchMarkFindingFixedArgs extends MutationBaseArgs {
  findingId: string;
  note?: string;
}

export interface HitchDeferFindingArgs extends MutationBaseArgs {
  findingId: string;
  reason: string;
  createBacklogItem?: boolean;
}

export interface HitchRecordCloseCheckArgs extends MutationBaseArgs {
  hitchId: string;
  conditionId: string;
  status: HitchCloseCheckStatus;
  checkedBy?: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

export interface HitchCheckConvergenceArgs extends MutationBaseArgs {
  hitchId: string;
  /** When false, record the decision but do not sync hitch_sessions.status
   *  (parity with the CLI `convergence --no-status-update`). */
  updateStatus?: boolean;
}

export interface HitchCloseArgs extends MutationBaseArgs {
  hitchId: string;
  summary: string;
  force?: boolean;
}

export interface HitchCancelArgs extends MutationBaseArgs {
  hitchId: string;
  reason: string;
}

export interface HitchExpandScopeArgs extends MutationBaseArgs {
  hitchId: string;
  scope: HitchScope;
  reason: string;
}

function splitRecordedConvergence(
  result: ReturnType<typeof evaluateConvergenceAndRecordStatus>,
) {
  const { decisionRecord, hitchStatus, ...convergence } = result;
  return { convergence, decisionRecord, hitchStatus };
}

export function hitchListTool(
  args: HitchListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const limit = args.limit ?? 50;
    const baseFilter = {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      ...(args.domain !== undefined ? { domain: args.domain } : {}),
      limit,
    };
    const goals =
      args.projectId !== undefined || context.config.allowedProjects.length === 0
        ? repo.listSessions({
            ...baseFilter,
            ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
          })
        : context.config.allowedProjects
            .flatMap((projectId) => repo.listSessions({ ...baseFilter, projectId }))
            .sort(compareHitchSessions)
            .slice(0, limit);
    return ok("goal sessions", { goals });
  }) as HarnessMcpToolResult;
}

export function hitchGetTool(
  args: HitchIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const goal = repo.getSession(args.hitchId);
    if (goal === null) return errorResult(`goal not found: ${args.hitchId}`);
    const denied = ensureProjectVisible(context.config, goal.projectId);
    if (denied !== null) return denied;
    return ok("goal session", { goal });
  }) as HarnessMcpToolResult;
}

export function hitchStatusTool(
  args: HitchIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const goal = repo.getSession(args.hitchId);
    if (goal === null) return errorResult(`goal not found: ${args.hitchId}`);
    const denied = ensureProjectVisible(context.config, goal.projectId);
    if (denied !== null) return denied;
    const findings = mcpFindingPage(repo, args.hitchId);
    const decisions = repo.listDecisions(args.hitchId);
    const convergence = new ConvergenceService(repo).evaluate(args.hitchId);
    return ok("goal status", {
      goal,
      findings: findings.findings,
      findingsTruncated: findings.truncated,
      decisions,
      convergence,
    });
  }) as HarnessMcpToolResult;
}

export function hitchFindingsTool(
  args: HitchIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const goal = repo.getSession(args.hitchId);
    if (goal === null) return errorResult(`goal not found: ${args.hitchId}`);
    const denied = ensureProjectVisible(context.config, goal.projectId);
    if (denied !== null) return denied;
    const findings = mcpFindingPage(repo, args.hitchId);
    return ok("goal findings", {
      findings: findings.findings,
      findingsTruncated: findings.truncated,
      limit: MAX_MCP_FINDINGS,
    });
  }) as HarnessMcpToolResult;
}

export function hitchDecisionsTool(
  args: HitchIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const goal = repo.getSession(args.hitchId);
    if (goal === null) return errorResult(`goal not found: ${args.hitchId}`);
    const denied = ensureProjectVisible(context.config, goal.projectId);
    if (denied !== null) return denied;
    return ok("goal decisions", {
      decisions: repo.listDecisions(args.hitchId),
    });
  }) as HarnessMcpToolResult;
}

/**
 * (#81) Derive a projectId from a repoId when the goal omits projectId but the
 * client is project-scoped. Only an UNAMBIGUOUS mapping (exactly one project for
 * the repoId) is derived; 0 or >1 matches return undefined so the caller falls
 * through to the actionable `ensureProjectVisible` denial — fail-closed, never
 * guess a project. A missing DB also yields undefined (withReadonlyDb returns a
 * tool result, not a string).
 */
function deriveProjectIdFromRepo(
  context: McpToolContext,
  repoId: string,
): string | undefined {
  const result = withReadonlyDb(context, ({ db }) => {
    const rows = db
      .prepare("SELECT project_id FROM projects WHERE repo_id = ?")
      .all(repoId) as Array<{ project_id: string }>;
    return rows.length === 1 ? rows[0]!.project_id : undefined;
  });
  return typeof result === "string" ? result : undefined;
}

export async function hitchStartTool(
  args: HitchStartArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  // (#81) When the client is project-scoped but the goal only carries a repoId,
  // derive the projectId from an unambiguous repo→project mapping before the
  // visibility gate, so a repoId-only goal.start is not rejected for a missing
  // projectId it could have inferred. Ambiguous/unknown repos are NOT derived.
  let effectiveProjectId = args.projectId;
  if (
    effectiveProjectId === undefined &&
    args.repoId !== undefined &&
    context.config.allowedProjects.length > 0
  ) {
    effectiveProjectId = deriveProjectIdFromRepo(context, args.repoId);
  }
  const visible = ensureProjectVisible(context.config, effectiveProjectId);
  if (visible !== null) return visible;
  const hitchId = args.hitchId ?? goalIdForIdempotencyKey(args.idempotencyKey);
  return runGoalOperation(context, {
    operationType: "hitch.start",
    target: { type: "goal", id: hitchId },
    args,
    metadata: goalMetadata(context, "harness.hitch.start", args, { hitchId }),
    workWithDb: async (db) => {
      const input: CreateHitchSessionInput = {
        hitchId,
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(effectiveProjectId !== undefined ? { projectId: effectiveProjectId } : {}),
        ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        ...(args.backlogItemId !== undefined
          ? { backlogItemId: args.backlogItemId }
          : {}),
        scope: args.scope ?? {},
        closeConditions: args.closeConditions ?? [],
        ...(args.policy !== undefined ? { policy: args.policy } : {}),
        ...(args.maxIterations !== undefined
          ? { maxIterations: args.maxIterations }
          : {}),
        ...(args.maxReviewCycles !== undefined
          ? { maxReviewCycles: args.maxReviewCycles }
          : {}),
        ...(args.maxReruns !== undefined ? { maxReruns: args.maxReruns } : {}),
        ...(args.maxTotalNewFindings !== undefined
          ? { maxTotalNewFindings: args.maxTotalNewFindings }
          : {}),
        createdBy: `mcp:${context.clientName}`,
        createdSource: "mcp",
      };
      return new HitchRepository(db).createSession(input);
    },
  });
}

export async function hitchRecordFindingsTool(
  args: HitchRecordFindingsArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (args.findings.length > MAX_FINDINGS_PER_CALL) {
    return errorResult("too many findings in one call", {
      maxFindingsPerCall: MAX_FINDINGS_PER_CALL,
      count: args.findings.length,
    });
  }
  return runGoalOperation(context, {
    operationType: "hitch.record_findings",
    target: { type: "goal", id: args.hitchId },
    args,
    metadata: goalMetadata(context, "harness.hitch.record_findings", args, {
      hitchId: args.hitchId,
    }),
    workWithDb: async (db, operationId) => {
      const repo = new HitchRepository(db);
      const tx = db.transaction(() => {
        const session = repo.requireSession(args.hitchId);
        const cycle = repo.startReviewCycle({
          hitchId: args.hitchId,
          reviewMode: nextReviewMode(session, repo.listReviewCycles(args.hitchId)),
          sourceReviewId: `mcp:${operationId}`,
        });
        const recorded = args.findings.map((finding) => {
          const source = finding.source ?? "mcp";
          const classification =
            finding.scopeStatus === undefined
              ? classifyFindingForHitch(session, toClassifiableFinding(source, finding))
              : {
                  scopeStatus: finding.scopeStatus,
                  reason: "scope supplied by MCP caller",
                };
          const input: UpsertHitchFindingInput = {
            hitchId: args.hitchId,
            source,
            severity: finding.severity,
            category: finding.category,
            scopeStatus: classification.scopeStatus,
            summary: redactMcpText(finding.summary),
            classificationReason: classification.reason,
            sourceCycleId: cycle.cycleId,
            ...(finding.detail !== undefined
              ? { detail: redactMcpText(finding.detail) }
              : {}),
            ...(finding.filePath !== undefined ? { filePath: finding.filePath } : {}),
            ...(finding.symbol !== undefined ? { symbol: finding.symbol } : {}),
            ...(finding.suggestedFix !== undefined
              ? { suggestedFix: redactMcpText(finding.suggestedFix) }
              : {}),
            ...(finding.sourceRef !== undefined ? { sourceRef: finding.sourceRef } : {}),
            ...(finding.sourceAttemptId !== undefined
              ? { sourceAttemptId: finding.sourceAttemptId }
              : {}),
          };
          return repo.upsertFinding(input);
        });
        const completedCycle = repo.completeReviewCycle({
          cycleId: cycle.cycleId,
          findingsSeen: recorded.length,
          findingsNew: recorded.filter((r) => r.created).length,
          findingsReopened: recorded.filter((r) => r.reopened).length,
          findingsFixed: repo.listFindings({
            hitchId: args.hitchId,
            lifecycleStatus: "fixed",
            limit: 10_000,
          }).length,
          findingsDeferred: repo.listFindings({
            hitchId: args.hitchId,
            lifecycleStatus: "deferred",
            limit: 10_000,
          }).length,
          findingsInScopeOpen: repo
            .listFindings({
              hitchId: args.hitchId,
              scopeStatus: "in_scope",
              limit: 10_000,
            })
            .filter(
              (finding) =>
                finding.lifecycleStatus === "open" ||
                finding.lifecycleStatus === "reopened",
            ).length,
          summary: `MCP recorded ${recorded.length} finding(s) via ${operationId}`,
        });
        const convergenceResult = evaluateConvergenceAndRecordStatus({
          repository: repo,
          hitchId: args.hitchId,
          cycleId: completedCycle.cycleId,
          createdBy: `mcp:${context.clientName}`,
        });
        const convergence = splitRecordedConvergence(convergenceResult);
        return {
          hitchId: args.hitchId,
          recorded,
          created: recorded.filter((r) => r.created).length,
          reopened: recorded.filter((r) => r.reopened).length,
          cycle: completedCycle,
          ...convergence,
        };
      });
      return tx.immediate();
    },
  });
}

export async function hitchClassifyFindingTool(
  args: HitchClassifyFindingArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runGoalOperation(context, {
    operationType: "hitch.classify_finding",
    target: { type: "goal_finding", id: args.findingId },
    args,
    metadata: goalMetadata(context, "harness.hitch.classify_finding", args, {
      findingIds: [args.findingId],
    }),
    workWithDb: async (db) => {
      const repo = new HitchRepository(db);
      const tx = db.transaction(() => {
        const finding = repo.classifyFinding({
          findingId: args.findingId,
          scopeStatus: args.scopeStatus,
          reason: redactMcpText(args.reason),
          ...(args.duplicateOf !== undefined ? { duplicateOf: args.duplicateOf } : {}),
        });
        const convergenceResult = evaluateConvergenceAndRecordStatus({
          repository: repo,
          hitchId: finding.hitchId,
          createdBy: `mcp:${context.clientName}`,
        });
        const convergence = splitRecordedConvergence(convergenceResult);
        return {
          finding,
          ...convergence,
        };
      });
      return tx.immediate();
    },
  });
}

export async function hitchMarkFindingFixedTool(
  args: HitchMarkFindingFixedArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runGoalOperation(context, {
    operationType: "hitch.mark_finding_fixed",
    target: { type: "goal_finding", id: args.findingId },
    args,
    metadata: goalMetadata(context, "harness.hitch.mark_finding_fixed", args, {
      findingIds: [args.findingId],
    }),
    workWithDb: async (db) => {
      const repo = new HitchRepository(db);
      const tx = db.transaction(() => {
        const finding = repo.markFindingFixed({
          findingId: args.findingId,
          ...(args.note !== undefined ? { note: redactMcpText(args.note) } : {}),
        });
        const convergenceResult = evaluateConvergenceAndRecordStatus({
          repository: repo,
          hitchId: finding.hitchId,
          createdBy: `mcp:${context.clientName}`,
        });
        const convergence = splitRecordedConvergence(convergenceResult);
        return {
          finding,
          ...convergence,
        };
      });
      return tx.immediate();
    },
  });
}

export async function hitchDeferFindingTool(
  args: HitchDeferFindingArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (args.createBacklogItem === true && !context.config.allowedOperations.includes("backlog.create")) {
    return permissionDenied("hitch.defer_finding cannot create backlog item: backlog.create is not allowed", {
      operation: "backlog.create",
      reason: "operation_not_allowlisted",
    });
  }
  const paths = harnessPaths(context.harnessRoot);
  return runGoalOperation(context, {
    operationType: "hitch.defer_finding",
    target: { type: "goal_finding", id: args.findingId },
    args,
    metadata: goalMetadata(context, "harness.hitch.defer_finding", args, {
      findingIds: [args.findingId],
    }),
    workWithDb: async (db) => {
      const repo = new HitchRepository(db);
      const deferred = await deferFindingToBacklog({
        repository: repo,
        findingId: args.findingId,
        reason: redactMcpText(args.reason),
        createBacklogItem: args.createBacklogItem === true,
        ...(args.createBacklogItem === true
          ? {
              backlogContext: {
                backlogDir: paths.backlogDir,
                dbPath: paths.dbPath,
              },
            }
          : {}),
      });
      const convergenceResult = evaluateConvergenceAndRecordStatus({
        repository: repo,
        hitchId: deferred.finding.hitchId,
        createdBy: `mcp:${context.clientName}`,
      });
      const convergence = splitRecordedConvergence(convergenceResult);
      return {
        ...deferred,
        ...convergence,
      };
    },
  });
}

export async function hitchRecordCloseCheckTool(
  args: HitchRecordCloseCheckArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runGoalOperation(context, {
    operationType: "hitch.record_close_check",
    target: { type: "goal", id: args.hitchId },
    args,
    metadata: goalMetadata(context, "harness.hitch.record_close_check", args, {
      hitchId: args.hitchId,
    }),
    workWithDb: async (db) => {
      const evidence =
        args.evidence === undefined
          ? undefined
          : (redactMcpAuditValue(args.evidence) as Record<string, unknown>);
      const repo = new HitchRepository(db);
      const tx = db.transaction(() => {
        const check = repo.recordCloseCheck({
          hitchId: args.hitchId,
          conditionId: args.conditionId,
          status: args.status,
          checkedBy: args.checkedBy ?? `mcp:${context.clientName}`,
          ...(evidence !== undefined ? { evidence } : {}),
          ...(args.message !== undefined
            ? { message: redactMcpText(args.message) }
            : {}),
        });
        const convergenceResult = evaluateConvergenceAndRecordStatus({
          repository: repo,
          hitchId: args.hitchId,
          createdBy: `mcp:${context.clientName}`,
        });
        const convergence = splitRecordedConvergence(convergenceResult);
        return {
          check,
          ...convergence,
        };
      });
      return tx.immediate();
    },
  });
}

export async function hitchCheckConvergenceTool(
  args: HitchCheckConvergenceArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runGoalOperation(context, {
    operationType: "hitch.check_convergence",
    target: { type: "goal", id: args.hitchId },
    args,
    metadata: goalMetadata(context, "harness.hitch.check_convergence", args, {
      hitchId: args.hitchId,
    }),
    workWithDb: async (db) => {
      const repo = new HitchRepository(db);
      const result = new ConvergenceService(repo).evaluate(args.hitchId);
      const recorded = recordConvergenceDecisionWithStatus({
        repository: repo,
        hitchId: args.hitchId,
        decision: result.decision,
        reason: result.reason,
        metrics: { ...result.metrics },
        recommendedNextAction: result.recommendedNextAction,
        createdBy: `mcp:${context.clientName}`,
        ...(args.updateStatus !== undefined
          ? { updateStatus: args.updateStatus }
          : {}),
      });
      return {
        ...result,
        decisionRecord: recorded.decisionRecord,
        hitchStatus: recorded.hitchStatus,
      };
    },
  });
}

export async function hitchCloseTool(
  args: HitchCloseArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const preview = goalClosePreview(args, context);
  if (preview.status === "error" || preview.status === "permission_denied") {
    return preview;
  }
  const decision = (preview.data as { convergence?: { decision?: string } })
    .convergence?.decision;
  const requiresConfirmation = args.force === true || decision !== "close_ready";
  const confirmedOverrideClose = isConfirmed(context) && requiresConfirmation;
  if (requiresConfirmation && !isConfirmed(context)) {
    return confirmationResult(context, "harness.hitch.close", "hitch.close", args, preview, {
      type: "goal",
      id: args.hitchId,
    });
  }
  if (!requiresConfirmation && !isConfirmed(context)) {
    const denied = ensureUnconfirmedGoalCloseAllowed(context);
    if (denied !== null) return denied;
  }
  return runGoalOperation(context, {
    operationType: "hitch.close",
    target: { type: "goal", id: args.hitchId },
    args,
    metadata: goalMetadata(context, "harness.hitch.close", args, {
      hitchId: args.hitchId,
    }),
    workWithDb: async (db) => {
      const repo = new HitchRepository(db);
      const tx = db.transaction(() => {
        if (!confirmedOverrideClose) {
          const current = new ConvergenceService(repo).evaluate(args.hitchId);
          if (current.decision !== "close_ready") {
            const error = new Error(
              `goal is no longer close_ready: decision=${current.decision}`,
            );
            (error as { code?: string }).code = "goal_not_close_ready";
            throw error;
          }
        }
        return repo.updateStatus(args.hitchId, "closed", redactMcpText(args.summary));
      });
      return tx.immediate();
    },
  });
}

export async function hitchCancelTool(
  args: HitchCancelArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const preview = ok("would cancel goal", {
    hitchId: args.hitchId,
    reason: redactMcpText(args.reason),
  });
  if (!isConfirmed(context)) {
    return confirmationResult(context, "harness.hitch.cancel", "hitch.cancel", args, preview, {
      type: "goal",
      id: args.hitchId,
    });
  }
  return runGoalOperation(context, {
    operationType: "hitch.cancel",
    target: { type: "goal", id: args.hitchId },
    args,
    metadata: goalMetadata(context, "harness.hitch.cancel", args, {
      hitchId: args.hitchId,
    }),
    workWithDb: async (db) =>
      new HitchRepository(db).updateStatus(
        args.hitchId,
        "cancelled",
        redactMcpText(args.reason),
      ),
  });
}

export async function hitchExpandScopeTool(
  args: HitchExpandScopeArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const preview = ok("would expand goal scope", {
    hitchId: args.hitchId,
    scope: args.scope,
    reason: redactMcpText(args.reason),
  });
  if (!isConfirmed(context)) {
    return confirmationResult(
      context,
      "harness.hitch.expand_scope",
      "hitch.expand_scope",
      args,
      preview,
      { type: "goal", id: args.hitchId },
    );
  }
  return runGoalOperation(context, {
    operationType: "hitch.expand_scope",
    target: { type: "goal", id: args.hitchId },
    args,
    metadata: goalMetadata(context, "harness.hitch.expand_scope", args, {
      hitchId: args.hitchId,
    }),
    workWithDb: async (db) => expandGoalScope(db, args),
  });
}

export function resolveHitchProjectId(
  args: { hitchId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.hitchId === undefined) return undefined;
  const unresolved =
    context.config.allowedProjects.length > 0
      ? "__mcp_unresolved_goal_project__"
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
      ? "__mcp_unresolved_goal_finding_project__"
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

async function runGoalOperation<T>(
  context: McpToolContext,
  opts: {
    operationType: string;
    target: { type: string; id: string };
    args: MutationBaseArgs;
    metadata: Record<string, unknown>;
    workWithDb: (db: Database.Database, operationId: string) => Promise<T> | T;
  },
): Promise<HarnessMcpToolResult> {
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    return errorResult("harness DB is not initialized", { dbPath: paths.dbPath });
  }
  const operationId = `op-${randomUUID()}`;
  const handle = openManagedDb({
    dbPath: paths.dbPath,
    lockPath: paths.dbLockPath,
  });
  try {
    runMigrations(handle.db);
    const outcome = await runOperation(
      handle.db,
      {
        operationId,
        operationType: opts.operationType,
        target: opts.target,
        actor: `mcp:${context.clientName}`,
        idempotencyKey: opts.args.idempotencyKey,
        dryRun: false,
        input: redactMcpAuditValue(opts.args),
        metadata: opts.metadata,
        beforeStart: (db) => {
          assertMutationBudget(db, context.config, {
            clientName: context.clientName,
            operationType: opts.operationType,
            targetId: opts.target.id,
            idempotencyKey: opts.args.idempotencyKey,
          });
        },
      },
      async (opId) => opts.workWithDb(handle.db, opId),
    );
    return {
      status: "operation_started",
      summary: `${opts.operationType} ${outcome.replayed ? "replayed" : "started"}`,
      operationId: outcome.operation.operationId,
      data: {
        operation: {
          operationId: outcome.operation.operationId,
          operationType: outcome.operation.operationType,
          targetType: outcome.operation.targetType,
          targetId: outcome.operation.targetId,
          status: outcome.operation.status,
        },
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
    if (e instanceof OperationInFlightError) {
      return errorResult(e.message, {
        operationId: e.operationId,
        reason: "operation_in_flight",
      });
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

function goalClosePreview(
  args: HitchCloseArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new HitchRepository(db);
    const goal = repo.getSession(args.hitchId);
    if (goal === null) return errorResult(`goal not found: ${args.hitchId}`);
    const convergence = new ConvergenceService(repo).evaluate(args.hitchId);
    return {
      status: "dry_run",
      summary:
        convergence.decision === "close_ready"
          ? "goal is close_ready and can be closed"
          : "would close a non-close_ready goal after confirmation",
      data: {
        goal,
        convergence,
        summary: redactMcpText(args.summary),
        force: args.force === true || convergence.decision !== "close_ready",
      },
    };
  }) as HarnessMcpToolResult;
}

function confirmationResult(
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
  return {
    status: "confirmation_required",
    summary: `${operationType} requires confirmation`,
    confirmationId: row.confirmationId,
    data: {
      operation: operationType,
      target,
      expiresAt: row.expiresAt,
      preview,
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

function isConfirmed(context: McpToolContext): boolean {
  return context.confirmedConfirmationId !== undefined;
}

function ensureUnconfirmedGoalCloseAllowed(
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

function compareHitchSessions(a: HitchSession, b: HitchSession): number {
  const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
  return byUpdated === 0 ? b.hitchId.localeCompare(a.hitchId) : byUpdated;
}

function mcpFindingPage(
  repo: HitchRepository,
  hitchId: string,
): { findings: HitchFinding[]; truncated: boolean } {
  const rows = repo.listFindings({
    hitchId,
    limit: MAX_MCP_FINDINGS + 1,
  });
  return {
    findings: rows.slice(0, MAX_MCP_FINDINGS).map(redactGoalFindingForMcp),
    truncated: rows.length > MAX_MCP_FINDINGS,
  };
}

function redactGoalFindingForMcp(finding: HitchFinding): HitchFinding {
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

function cappedNullableMcpText(value: string | null): string | null {
  return value === null ? null : cappedMcpText(value);
}

function cappedMcpText(value: string): string {
  const redacted = redactMcpText(value);
  if (redacted.length <= MAX_MCP_FINDING_TEXT_CHARS) return redacted;
  return `${redacted.slice(0, MAX_MCP_FINDING_TEXT_CHARS)}...[truncated]`;
}

function goalMetadata(
  context: McpToolContext,
  toolName: string,
  args: MutationBaseArgs,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const hitchId =
    typeof extra.hitchId === "string"
      ? extra.hitchId
      : typeof (args as unknown as { hitchId?: unknown }).hitchId === "string"
        ? (args as unknown as { hitchId: string }).hitchId
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

function goalIdForIdempotencyKey(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `goal-${digest.slice(0, 32)}`;
}

function toClassifiableFinding(
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

function expandGoalScope(
  db: Database.Database,
  args: HitchExpandScopeArgs,
): { hitchId: string; scope: HitchScope; reason: string } {
  const repo = new HitchRepository(db);
  const current = repo.requireSession(args.hitchId);
  const scope = parseHitchScope(mergeScope(current.scope, args.scope));
  db.prepare(
    `UPDATE hitch_sessions
        SET scope_json = ?, updated_at = ?
      WHERE hitch_id = ?`,
  ).run(JSON.stringify(scope), new Date().toISOString(), args.hitchId);
  return {
    hitchId: args.hitchId,
    scope,
    reason: redactMcpText(args.reason),
  };
}

function mergeScope(current: HitchScope, incoming: HitchScope): HitchScope {
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

function putMerged(
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
