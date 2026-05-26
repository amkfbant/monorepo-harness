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
  classifyFindingForGoal,
  type ClassifiableGoalFinding,
} from "../../goal/classification.js";
import { ConvergenceService } from "../../goal/convergence.js";
import { deferFindingToBacklog } from "../../goal/followups.js";
import {
  GoalRepository,
  type CreateGoalSessionInput,
  type UpsertGoalFindingInput,
} from "../../goal/repository.js";
import { parseGoalScope } from "../../goal/schemas.js";
import type {
  GoalCloseCheckStatus,
  GoalCloseCondition,
  GoalFinding,
  GoalFindingSeverity,
  GoalFindingSource,
  GoalPolicy,
  GoalScope,
  GoalScopeStatus,
  GoalSession,
  GoalStatus,
} from "../../goal/types.js";
import { redactMcpAuditValue, redactMcpText } from "../audit/redaction.js";
import { errorResult, ok, permissionDenied, type HarnessMcpToolResult } from "../schemas/outputs.js";
import { createMcpConfirmationRequest } from "../security/confirmation.js";
import { assertMutationBudget, McpMutationBudgetExceededError } from "../security/limits.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { modeForClient } from "../security/config.js";
import { ensureProjectVisible, withReadonlyDb } from "./tool-helpers.js";

const MAX_FINDINGS_PER_CALL = 50;
const MAX_MCP_FINDINGS = 100;
const MAX_MCP_FINDING_TEXT_CHARS = 1000;

interface MutationBaseArgs {
  idempotencyKey: string;
  actorNote?: string;
}

export interface GoalListArgs {
  status?: GoalStatus;
  projectId?: string;
  repoId?: string;
  domain?: string;
  limit?: number;
}

export interface GoalIdArgs {
  goalId: string;
}

export interface GoalStartArgs extends MutationBaseArgs {
  goalId?: string;
  title: string;
  description?: string;
  projectId?: string;
  repoId?: string;
  domain?: string;
  backlogItemId?: string;
  scope?: GoalScope;
  closeConditions?: GoalCloseCondition[];
  policy?: GoalPolicy;
  maxIterations?: number;
  maxReviewCycles?: number;
  maxReruns?: number;
  maxTotalNewFindings?: number;
}

export interface GoalFindingInput {
  severity: GoalFindingSeverity;
  category: string;
  summary: string;
  detail?: string;
  filePath?: string;
  symbol?: string;
  suggestedFix?: string;
  source?: GoalFindingSource;
  sourceRef?: string;
  sourceAttemptId?: string;
  sourceCycleId?: string;
  scopeStatus?: GoalScopeStatus;
}

export interface GoalRecordFindingsArgs extends MutationBaseArgs {
  goalId: string;
  findings: GoalFindingInput[];
}

export interface GoalClassifyFindingArgs extends MutationBaseArgs {
  findingId: string;
  scopeStatus: GoalScopeStatus;
  reason: string;
  duplicateOf?: string;
}

export interface GoalMarkFindingFixedArgs extends MutationBaseArgs {
  findingId: string;
  note?: string;
}

export interface GoalDeferFindingArgs extends MutationBaseArgs {
  findingId: string;
  reason: string;
  createBacklogItem?: boolean;
}

export interface GoalRecordCloseCheckArgs extends MutationBaseArgs {
  goalId: string;
  conditionId: string;
  status: GoalCloseCheckStatus;
  checkedBy?: string;
  evidence?: Record<string, unknown>;
  message?: string;
}

export interface GoalCheckConvergenceArgs extends MutationBaseArgs {
  goalId: string;
}

export interface GoalCloseArgs extends MutationBaseArgs {
  goalId: string;
  summary: string;
  force?: boolean;
}

export interface GoalCancelArgs extends MutationBaseArgs {
  goalId: string;
  reason: string;
}

export interface GoalExpandScopeArgs extends MutationBaseArgs {
  goalId: string;
  scope: GoalScope;
  reason: string;
}

export function goalListTool(
  args: GoalListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const repo = new GoalRepository(db);
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
            .sort(compareGoalSessions)
            .slice(0, limit);
    return ok("goal sessions", { goals });
  }) as HarnessMcpToolResult;
}

export function goalGetTool(
  args: GoalIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new GoalRepository(db);
    const goal = repo.getSession(args.goalId);
    if (goal === null) return errorResult(`goal not found: ${args.goalId}`);
    const denied = ensureProjectVisible(context.config, goal.projectId);
    if (denied !== null) return denied;
    return ok("goal session", { goal });
  }) as HarnessMcpToolResult;
}

export function goalStatusTool(
  args: GoalIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new GoalRepository(db);
    const goal = repo.getSession(args.goalId);
    if (goal === null) return errorResult(`goal not found: ${args.goalId}`);
    const denied = ensureProjectVisible(context.config, goal.projectId);
    if (denied !== null) return denied;
    const findings = mcpFindingPage(repo, args.goalId);
    const decisions = repo.listDecisions(args.goalId);
    const convergence = new ConvergenceService(repo).evaluate(args.goalId);
    return ok("goal status", {
      goal,
      findings: findings.findings,
      findingsTruncated: findings.truncated,
      decisions,
      convergence,
    });
  }) as HarnessMcpToolResult;
}

export function goalFindingsTool(
  args: GoalIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new GoalRepository(db);
    const goal = repo.getSession(args.goalId);
    if (goal === null) return errorResult(`goal not found: ${args.goalId}`);
    const denied = ensureProjectVisible(context.config, goal.projectId);
    if (denied !== null) return denied;
    const findings = mcpFindingPage(repo, args.goalId);
    return ok("goal findings", {
      findings: findings.findings,
      findingsTruncated: findings.truncated,
      limit: MAX_MCP_FINDINGS,
    });
  }) as HarnessMcpToolResult;
}

export function goalDecisionsTool(
  args: GoalIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new GoalRepository(db);
    const goal = repo.getSession(args.goalId);
    if (goal === null) return errorResult(`goal not found: ${args.goalId}`);
    const denied = ensureProjectVisible(context.config, goal.projectId);
    if (denied !== null) return denied;
    return ok("goal decisions", {
      decisions: repo.listDecisions(args.goalId),
    });
  }) as HarnessMcpToolResult;
}

export async function goalStartTool(
  args: GoalStartArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const visible = ensureProjectVisible(context.config, args.projectId);
  if (visible !== null) return visible;
  const goalId = args.goalId ?? goalIdForIdempotencyKey(args.idempotencyKey);
  return runGoalOperation(context, {
    operationType: "goal.start",
    target: { type: "goal", id: goalId },
    args,
    metadata: goalMetadata(context, "harness.goal.start", args, { goalId }),
    workWithDb: async (db) => {
      const input: CreateGoalSessionInput = {
        goalId,
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
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
      return new GoalRepository(db).createSession(input);
    },
  });
}

export async function goalRecordFindingsTool(
  args: GoalRecordFindingsArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (args.findings.length > MAX_FINDINGS_PER_CALL) {
    return errorResult("too many findings in one call", {
      maxFindingsPerCall: MAX_FINDINGS_PER_CALL,
      count: args.findings.length,
    });
  }
  return runGoalOperation(context, {
    operationType: "goal.record_findings",
    target: { type: "goal", id: args.goalId },
    args,
    metadata: goalMetadata(context, "harness.goal.record_findings", args, {
      goalId: args.goalId,
    }),
    workWithDb: async (db) => {
      const repo = new GoalRepository(db);
      const session = repo.requireSession(args.goalId);
      const recorded = args.findings.map((finding) => {
        const source = finding.source ?? "mcp";
        const classification =
          finding.scopeStatus === undefined
            ? classifyFindingForGoal(session, toClassifiableFinding(source, finding))
            : {
                scopeStatus: finding.scopeStatus,
                reason: "scope supplied by MCP caller",
              };
        const input: UpsertGoalFindingInput = {
          goalId: args.goalId,
          source,
          severity: finding.severity,
          category: finding.category,
          scopeStatus: classification.scopeStatus,
          summary: redactMcpText(finding.summary),
          classificationReason: classification.reason,
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
          ...(finding.sourceCycleId !== undefined
            ? { sourceCycleId: finding.sourceCycleId }
            : {}),
        };
        return repo.upsertFinding(input);
      });
      return {
        goalId: args.goalId,
        recorded,
        created: recorded.filter((r) => r.created).length,
        reopened: recorded.filter((r) => r.reopened).length,
      };
    },
  });
}

export async function goalClassifyFindingTool(
  args: GoalClassifyFindingArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runGoalOperation(context, {
    operationType: "goal.classify_finding",
    target: { type: "goal_finding", id: args.findingId },
    args,
    metadata: goalMetadata(context, "harness.goal.classify_finding", args, {
      findingIds: [args.findingId],
    }),
    workWithDb: async (db) =>
      new GoalRepository(db).classifyFinding({
        findingId: args.findingId,
        scopeStatus: args.scopeStatus,
        reason: redactMcpText(args.reason),
        ...(args.duplicateOf !== undefined ? { duplicateOf: args.duplicateOf } : {}),
      }),
  });
}

export async function goalMarkFindingFixedTool(
  args: GoalMarkFindingFixedArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runGoalOperation(context, {
    operationType: "goal.mark_finding_fixed",
    target: { type: "goal_finding", id: args.findingId },
    args,
    metadata: goalMetadata(context, "harness.goal.mark_finding_fixed", args, {
      findingIds: [args.findingId],
    }),
    workWithDb: async (db) =>
      new GoalRepository(db).markFindingFixed({
        findingId: args.findingId,
        ...(args.note !== undefined ? { note: redactMcpText(args.note) } : {}),
      }),
  });
}

export async function goalDeferFindingTool(
  args: GoalDeferFindingArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (args.createBacklogItem === true && !context.config.allowedOperations.includes("backlog.create")) {
    return permissionDenied("goal.defer_finding cannot create backlog item: backlog.create is not allowed", {
      operation: "backlog.create",
      reason: "operation_not_allowlisted",
    });
  }
  const paths = harnessPaths(context.harnessRoot);
  return runGoalOperation(context, {
    operationType: "goal.defer_finding",
    target: { type: "goal_finding", id: args.findingId },
    args,
    metadata: goalMetadata(context, "harness.goal.defer_finding", args, {
      findingIds: [args.findingId],
    }),
    workWithDb: async (db) =>
      deferFindingToBacklog({
        repository: new GoalRepository(db),
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
      }),
  });
}

export async function goalRecordCloseCheckTool(
  args: GoalRecordCloseCheckArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runGoalOperation(context, {
    operationType: "goal.record_close_check",
    target: { type: "goal", id: args.goalId },
    args,
    metadata: goalMetadata(context, "harness.goal.record_close_check", args, {
      goalId: args.goalId,
    }),
    workWithDb: async (db) => {
      const evidence =
        args.evidence === undefined
          ? undefined
          : (redactMcpAuditValue(args.evidence) as Record<string, unknown>);
      return new GoalRepository(db).recordCloseCheck({
        goalId: args.goalId,
        conditionId: args.conditionId,
        status: args.status,
        checkedBy: args.checkedBy ?? `mcp:${context.clientName}`,
        ...(evidence !== undefined ? { evidence } : {}),
        ...(args.message !== undefined ? { message: redactMcpText(args.message) } : {}),
      });
    },
  });
}

export async function goalCheckConvergenceTool(
  args: GoalCheckConvergenceArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runGoalOperation(context, {
    operationType: "goal.check_convergence",
    target: { type: "goal", id: args.goalId },
    args,
    metadata: goalMetadata(context, "harness.goal.check_convergence", args, {
      goalId: args.goalId,
    }),
    workWithDb: async (db) => {
      const repo = new GoalRepository(db);
      const result = new ConvergenceService(repo).evaluate(args.goalId);
      const decisionRecord = repo.recordConvergenceDecision({
        goalId: args.goalId,
        decision: result.decision,
        reason: result.reason,
        metrics: { ...result.metrics },
        recommendedNextAction: result.recommendedNextAction,
        createdBy: `mcp:${context.clientName}`,
      });
      return { ...result, decisionRecord };
    },
  });
}

export async function goalCloseTool(
  args: GoalCloseArgs,
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
    return confirmationResult(context, "harness.goal.close", "goal.close", args, preview, {
      type: "goal",
      id: args.goalId,
    });
  }
  if (!requiresConfirmation && !isConfirmed(context)) {
    const denied = ensureUnconfirmedGoalCloseAllowed(context);
    if (denied !== null) return denied;
  }
  return runGoalOperation(context, {
    operationType: "goal.close",
    target: { type: "goal", id: args.goalId },
    args,
    metadata: goalMetadata(context, "harness.goal.close", args, {
      goalId: args.goalId,
    }),
    workWithDb: async (db) => {
      const repo = new GoalRepository(db);
      const tx = db.transaction(() => {
        if (!confirmedOverrideClose) {
          const current = new ConvergenceService(repo).evaluate(args.goalId);
          if (current.decision !== "close_ready") {
            const error = new Error(
              `goal is no longer close_ready: decision=${current.decision}`,
            );
            (error as { code?: string }).code = "goal_not_close_ready";
            throw error;
          }
        }
        return repo.updateStatus(args.goalId, "closed", redactMcpText(args.summary));
      });
      return tx.immediate();
    },
  });
}

export async function goalCancelTool(
  args: GoalCancelArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const preview = ok("would cancel goal", {
    goalId: args.goalId,
    reason: redactMcpText(args.reason),
  });
  if (!isConfirmed(context)) {
    return confirmationResult(context, "harness.goal.cancel", "goal.cancel", args, preview, {
      type: "goal",
      id: args.goalId,
    });
  }
  return runGoalOperation(context, {
    operationType: "goal.cancel",
    target: { type: "goal", id: args.goalId },
    args,
    metadata: goalMetadata(context, "harness.goal.cancel", args, {
      goalId: args.goalId,
    }),
    workWithDb: async (db) =>
      new GoalRepository(db).updateStatus(
        args.goalId,
        "cancelled",
        redactMcpText(args.reason),
      ),
  });
}

export async function goalExpandScopeTool(
  args: GoalExpandScopeArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const preview = ok("would expand goal scope", {
    goalId: args.goalId,
    scope: args.scope,
    reason: redactMcpText(args.reason),
  });
  if (!isConfirmed(context)) {
    return confirmationResult(
      context,
      "harness.goal.expand_scope",
      "goal.expand_scope",
      args,
      preview,
      { type: "goal", id: args.goalId },
    );
  }
  return runGoalOperation(context, {
    operationType: "goal.expand_scope",
    target: { type: "goal", id: args.goalId },
    args,
    metadata: goalMetadata(context, "harness.goal.expand_scope", args, {
      goalId: args.goalId,
    }),
    workWithDb: async (db) => expandGoalScope(db, args),
  });
}

export function resolveGoalProjectId(
  args: { goalId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.goalId === undefined) return undefined;
  const unresolved =
    context.config.allowedProjects.length > 0
      ? "__mcp_unresolved_goal_project__"
      : undefined;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare("SELECT project_id FROM goal_sessions WHERE goal_id = ?")
      .get(args.goalId) as { project_id: string | null } | undefined;
    return row?.project_id ?? unresolved;
  }) as string | null | undefined;
}

export function resolveGoalFindingProjectId(
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
           FROM goal_findings f
           JOIN goal_sessions s ON s.goal_id = f.goal_id
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
  args: GoalCloseArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new GoalRepository(db);
    const goal = repo.getSession(args.goalId);
    if (goal === null) return errorResult(`goal not found: ${args.goalId}`);
    const convergence = new ConvergenceService(repo).evaluate(args.goalId);
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
      operation: "goal.close",
      reason: "mutation_disabled_for_client",
    });
  }
  if (!context.config.allowedOperations.includes("goal.close")) {
    return permissionDenied("MCP permission denied: operation_not_allowlisted", {
      operation: "goal.close",
      reason: "operation_not_allowlisted",
    });
  }
  return null;
}

function compareGoalSessions(a: GoalSession, b: GoalSession): number {
  const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
  return byUpdated === 0 ? b.goalId.localeCompare(a.goalId) : byUpdated;
}

function mcpFindingPage(
  repo: GoalRepository,
  goalId: string,
): { findings: GoalFinding[]; truncated: boolean } {
  const rows = repo.listFindings({
    goalId,
    limit: MAX_MCP_FINDINGS + 1,
  });
  return {
    findings: rows.slice(0, MAX_MCP_FINDINGS).map(redactGoalFindingForMcp),
    truncated: rows.length > MAX_MCP_FINDINGS,
  };
}

function redactGoalFindingForMcp(finding: GoalFinding): GoalFinding {
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
  const goalId =
    typeof extra.goalId === "string"
      ? extra.goalId
      : typeof (args as unknown as { goalId?: unknown }).goalId === "string"
        ? (args as unknown as { goalId: string }).goalId
        : undefined;
  return {
    source: "mcp",
    clientName: context.clientName,
    sessionId: context.sessionId,
    toolName,
    idempotencyKey: args.idempotencyKey,
    ...(goalId !== undefined ? { goal_id: goalId } : {}),
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
  source: GoalFindingSource,
  finding: GoalFindingInput,
): ClassifiableGoalFinding {
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
  args: GoalExpandScopeArgs,
): { goalId: string; scope: GoalScope; reason: string } {
  const repo = new GoalRepository(db);
  const current = repo.requireSession(args.goalId);
  const scope = parseGoalScope(mergeScope(current.scope, args.scope));
  db.prepare(
    `UPDATE goal_sessions
        SET scope_json = ?, updated_at = ?
      WHERE goal_id = ?`,
  ).run(JSON.stringify(scope), new Date().toISOString(), args.goalId);
  return {
    goalId: args.goalId,
    scope,
    reason: redactMcpText(args.reason),
  };
}

function mergeScope(current: GoalScope, incoming: GoalScope): GoalScope {
  const scope: GoalScope = {
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
  scope: GoalScope,
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
