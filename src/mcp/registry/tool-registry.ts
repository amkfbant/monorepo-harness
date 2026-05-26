import { z } from "zod";
import type Database from "better-sqlite3";
import type { JsonSchema } from "../schemas/common.js";
import {
  CursorSchema,
  LimitSchema,
  MutationArgsBaseSchema,
  emptyInputSchema,
  enumSchema,
  objectSchema,
  stringArraySchema,
} from "../schemas/common.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { ok } from "../schemas/outputs.js";
import type { McpConfig } from "../security/config.js";
import type { McpToolKind } from "../security/permissions.js";
import {
  backlogGetTool,
  backlogListTool,
  dbStatusTool,
  doctorSummaryTool,
  domainListTool,
  knowledgeGetTool,
  knowledgeSearchTool,
  operationGetTool,
  operationListTool,
  policyGetEffectiveTool,
  policySnapshotGetTool,
  projectGetTool,
  projectListTool,
  resolveBacklogProjectId,
  resolveKnowledgeProjectId,
  resolveRunProjectId,
  reviewConsensusTool,
  reviewProposalsTool,
  reviewQueueTool,
  runArtifactGetTool,
  runArtifactsTool,
  runGetTool,
  runListTool,
  runTimelineTool,
} from "../tools/read-tools.js";
import {
  cleanupDryRunTool,
  dbArchivePreviewTool,
  dbGcBlobsPreviewTool,
  dbMigrateBlobsPreviewTool,
  dbRepairDryRunTool,
  prPreviewTool,
  projectCheckTool,
  projectInspectTool,
  runDryRunTool,
} from "../tools/dry-run-tools.js";
import {
  backlogCreateTool,
  backlogRunTool,
  backlogUpdateTool,
  cleanupApplyTool,
  dbArchiveApplyTool,
  dbGcBlobsApplyTool,
  dbMigrateBlobsApplyTool,
  dbRepairApplyTool,
  knowledgePromoteTool,
  knowledgeRejectTool,
  resolveDoctorFindingProjectId,
  prCreateTool,
  rerunStartTool,
  resolveKnowledgeCandidateProjectId,
  reviewAutoTool,
  reviewProcessTool,
  runStartTool,
} from "../tools/mutation-tools.js";
import {
  goalCancelTool,
  goalCheckConvergenceTool,
  goalClassifyFindingTool,
  goalCloseTool,
  goalDecisionsTool,
  goalDeferFindingTool,
  goalExpandScopeTool,
  goalFindingsTool,
  goalGetTool,
  goalListTool,
  goalMarkFindingFixedTool,
  goalRecordCloseCheckTool,
  goalRecordFindingsTool,
  goalStartTool,
  goalStatusTool,
  resolveGoalFindingProjectId,
  resolveGoalProjectId,
} from "../tools/goal-tools.js";
import type { McpPermissionDecision } from "../security/permissions.js";
import {
  GOAL_CLOSE_CHECK_STATUSES,
  GOAL_FINDING_SEVERITIES,
  GOAL_FINDING_SOURCES,
  GOAL_SCOPE_STATUSES,
  GOAL_STATUSES,
} from "../../goal/types.js";
import {
  GoalCloseConditionSchema,
  GoalPolicySchema,
  GoalScopeSchema,
} from "../../goal/schemas.js";

export interface McpToolContext {
  harnessRoot: string;
  db?: Database.Database;
  config: McpConfig;
  clientName: string;
  sessionId: string;
  permissionDecision?: McpPermissionDecision;
  confirmedConfirmationId?: string;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  kind: McpToolKind;
  operation: string;
  inputSchema: JsonSchema;
  argsSchema: z.ZodTypeAny;
  projectIdFromArgs?: (args: unknown) => string | null | undefined;
  resolveProjectIdForPermission?: (
    args: unknown,
    context: McpToolContext,
  ) => Promise<string | null | undefined> | string | null | undefined;
  handler: (
    args: unknown,
    context: McpToolContext,
  ) => Promise<HarnessMcpToolResult> | HarnessMcpToolResult;
}

const noArgs = z.object({}).strict();

const projectListArgs = z
  .object({
    includeArchived: z.boolean().optional(),
  })
  .strict();

const projectGetArgs = z
  .object({
    projectId: z.string().min(1),
  })
  .strict();

const projectDomainArgs = z
  .object({
    projectId: z.string().min(1).optional(),
  })
  .strict();

const runListArgs = z
  .object({
    projectId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    statuses: z.array(z.string().min(1)).optional(),
    limit: LimitSchema,
    cursor: CursorSchema,
  })
  .strict();

const runGetArgs = z
  .object({
    runId: z.string().min(1),
    includeArtifacts: z.boolean().optional(),
    includeTimeline: z.boolean().optional(),
  })
  .strict();

const artifactGetArgs = z
  .object({
    runId: z.string().min(1).optional(),
    artifactId: z.string().min(1),
  })
  .strict();

const runDryRunArgs = z
  .object({
    projectId: z.string().min(1),
    domain: z.string().min(1),
    goal: z.string().min(1),
    contextPack: z.string().min(1).optional(),
  })
  .strict();

const runStartArgs = runDryRunArgs
  .extend({
    goalId: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const reviewAutoArgs = z
  .object({
    runId: z.string().min(1),
    goalId: z.string().min(1).optional(),
    reviewer: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const reviewProcessArgs = z
  .object({
    runId: z.string().min(1),
    goalId: z.string().min(1).optional(),
    decision: z.enum(["approved", "changes_requested", "rejected"]),
    proposalId: z.number().int().positive().optional(),
    sourceSha256: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const backlogListArgs = z
  .object({
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    status: z.enum(["open", "doing", "done", "deferred"]).optional(),
    limit: LimitSchema,
    cursor: CursorSchema,
  })
  .strict();

const backlogGetArgs = z
  .object({
    itemId: z.string().min(1),
  })
  .strict();

const backlogCreateArgs = z
  .object({
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1),
    title: z.string().min(1),
    goal: z.string().min(1),
    priority: z.enum(["high", "medium", "low"]).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const backlogRunArgs = z
  .object({
    itemId: z.string().min(1),
    workflow: z.enum(["run", "reviewed-run"]).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const backlogUpdateArgs = z
  .object({
    itemId: z.string().min(1),
    status: z.enum(["open", "doing", "done", "deferred"]).optional(),
    title: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const knowledgeSearchArgs = z
  .object({
    query: z.string().min(1),
    projectId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    limit: LimitSchema,
  })
  .strict();

const knowledgeGetArgs = z
  .object({
    entryId: z.string().min(1),
    includeBody: z.boolean().optional(),
    maxBytes: z.number().int().min(0).optional(),
  })
  .strict();

const knowledgeDecisionArgs = z
  .object({
    candidateId: z.string().min(1),
    reason: z.string().optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const operationListArgs = z
  .object({
    targetType: z.string().min(1).optional(),
    targetId: z.string().min(1).optional(),
    status: z
      .enum(["pending", "running", "succeeded", "failed", "cancelled"])
      .optional(),
    limit: LimitSchema,
    cursor: CursorSchema,
  })
  .strict();

const operationGetArgs = z
  .object({
    operationId: z.string().min(1),
  })
  .strict();

const goalListArgs = z
  .object({
    status: z.enum(GOAL_STATUSES).optional(),
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    limit: LimitSchema,
  })
  .strict();

const goalGetArgs = z
  .object({
    goalId: z.string().min(1),
  })
  .strict();

const goalStartArgs = z
  .object({
    goalId: z.string().min(1).optional(),
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    backlogItemId: z.string().min(1).optional(),
    scope: GoalScopeSchema.optional(),
    closeConditions: z.array(GoalCloseConditionSchema).optional(),
    policy: GoalPolicySchema.optional(),
    maxIterations: z.number().int().min(1).optional(),
    maxReviewCycles: z.number().int().min(1).optional(),
    maxReruns: z.number().int().min(0).optional(),
    maxTotalNewFindings: z.number().int().min(0).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalFindingInputArgs = z
  .object({
    severity: z.enum(GOAL_FINDING_SEVERITIES),
    category: z.string().min(1),
    summary: z.string().min(1),
    detail: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    suggestedFix: z.string().min(1).optional(),
    source: z.enum(GOAL_FINDING_SOURCES).optional(),
    sourceRef: z.string().min(1).optional(),
    sourceAttemptId: z.string().min(1).optional(),
    sourceCycleId: z.string().min(1).optional(),
    scopeStatus: z.enum(GOAL_SCOPE_STATUSES).optional(),
  })
  .strict();

const goalRecordFindingsArgs = z
  .object({
    goalId: z.string().min(1),
    findings: z.array(goalFindingInputArgs).min(1).max(50),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalClassifyFindingArgs = z
  .object({
    findingId: z.string().min(1),
    scopeStatus: z.enum(GOAL_SCOPE_STATUSES),
    reason: z.string().min(1),
    duplicateOf: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalFindingMutationArgs = z
  .object({
    findingId: z.string().min(1),
    note: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalDeferFindingArgs = z
  .object({
    findingId: z.string().min(1),
    reason: z.string().min(1),
    createBacklogItem: z.boolean().optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalRecordCloseCheckArgs = z
  .object({
    goalId: z.string().min(1),
    conditionId: z.string().min(1),
    status: z.enum(GOAL_CLOSE_CHECK_STATUSES),
    checkedBy: z.string().min(1).optional(),
    evidence: z.record(z.unknown()).optional(),
    message: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalCheckConvergenceArgs = z
  .object({
    goalId: z.string().min(1),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalCloseArgs = z
  .object({
    goalId: z.string().min(1),
    summary: z.string().min(1),
    force: z.boolean().optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalCancelArgs = z
  .object({
    goalId: z.string().min(1),
    reason: z.string().min(1),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const goalExpandScopeArgs = z
  .object({
    goalId: z.string().min(1),
    scope: GoalScopeSchema,
    reason: z.string().min(1),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const dangerousRunArgs = z
  .object({
    runId: z.string().min(1),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const rerunStartArgs = z
  .object({
    runId: z.string().min(1),
    goalId: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const dbPreviewArgs = z
  .object({
    limit: LimitSchema,
  })
  .strict();

const dbRepairApplyArgs = z
  .object({
    findingId: z.number().int().positive(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const dbArchiveApplyArgs = z
  .object({
    before: z.string().min(1),
    out: z.string().min(1).optional(),
    archiveId: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const dbMigrateBlobsApplyArgs = z
  .object({
    to: z.enum(["external", "db"]),
    storeId: z.string().min(1).optional(),
    limit: LimitSchema,
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const dbGcBlobsApplyArgs = z
  .object({
    storeId: z.string().min(1).optional(),
    deleteObjects: z.boolean().optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

function notImplemented(name: string): McpToolDefinition["handler"] {
  return () =>
    ok(`${name} is registered; implementation arrives in a later Phase 18 subphase`, {
      tool: name,
      implemented: false,
    });
}

function define(
  input: Omit<
    McpToolDefinition,
    "argsSchema" | "projectIdFromArgs" | "resolveProjectIdForPermission" | "handler"
  > & {
    argsSchema: z.ZodTypeAny;
    projectIdFromArgs?: (args: any) => string | null | undefined;
    resolveProjectIdForPermission?: (
      args: any,
      context: McpToolContext,
    ) => Promise<string | null | undefined> | string | null | undefined;
    handler?: (
      args: any,
      context: McpToolContext,
    ) => Promise<HarnessMcpToolResult> | HarnessMcpToolResult;
  },
): McpToolDefinition {
  const {
    projectIdFromArgs,
    resolveProjectIdForPermission,
    handler,
    ...rest
  } = input;
  const fallback = notImplemented(input.name);
  const definition: McpToolDefinition = {
    ...rest,
    handler:
      handler === undefined
        ? fallback
        : (args, context) => handler(args, context),
  };
  if (projectIdFromArgs !== undefined) {
    definition.projectIdFromArgs = (args: unknown) =>
      projectIdFromArgs(args);
  }
  if (resolveProjectIdForPermission !== undefined) {
    definition.resolveProjectIdForPermission = (args, context) =>
      resolveProjectIdForPermission(args, context);
  }
  return definition;
}

const projectIdJson = { type: "string", description: "Project id" };
const runIdJson = { type: "string", description: "Run id" };
const goalIdJson = { type: "string", description: "Goal id" };
const idempotencyJson = {
  type: "string",
  description: "Required idempotency key for mutation tools",
};
const goalScopeJson = {
  type: "object",
  description: "Goal scope object",
  additionalProperties: true,
};
const goalFindingJson = {
  type: "object",
  description: "Goal finding input",
  additionalProperties: true,
};

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  define({
    name: "harness.project.list",
    title: "List projects",
    description: "List DB-canonical projects visible to the MCP client.",
    kind: "read",
    operation: "project.list",
    argsSchema: projectListArgs,
    inputSchema: objectSchema({ includeArchived: { type: "boolean" } }),
    handler: projectListTool,
  }),
  define({
    name: "harness.project.get",
    title: "Get project",
    description: "Read one project and its profile/domain summary.",
    kind: "read",
    operation: "project.get",
    argsSchema: projectGetArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({ projectId: projectIdJson }, ["projectId"]),
    handler: projectGetTool,
  }),
  define({
    name: "harness.project.inspect",
    title: "Inspect project repository",
    description: "Inspect project repository layout without mutation.",
    kind: "read",
    operation: "project.inspect",
    argsSchema: projectGetArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({ projectId: projectIdJson }, ["projectId"]),
    handler: projectInspectTool,
  }),
  define({
    name: "harness.domain.list",
    title: "List domains",
    description: "List domains, optionally scoped to a project.",
    kind: "read",
    operation: "domain.list",
    argsSchema: projectDomainArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({ projectId: projectIdJson }),
    handler: domainListTool,
  }),
  define({
    name: "harness.policy.get_effective",
    title: "Get effective policy",
    description: "Return effective policy metadata for a project/domain.",
    kind: "read",
    operation: "policy.get_effective",
    argsSchema: z
      .object({ projectId: z.string().min(1), domain: z.string().min(1) })
      .strict(),
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      { projectId: projectIdJson, domain: { type: "string" } },
      ["projectId", "domain"],
    ),
    handler: policyGetEffectiveTool,
  }),
  define({
    name: "harness.policy.snapshot.get",
    title: "Get policy snapshot",
    description: "Return a recorded effective policy snapshot.",
    kind: "read",
    operation: "policy.snapshot.get",
    argsSchema: z.object({ snapshotId: z.number().int().positive() }).strict(),
    inputSchema: objectSchema({ snapshotId: { type: "number" } }, ["snapshotId"]),
    handler: policySnapshotGetTool,
  }),
  define({
    name: "harness.run.list",
    title: "List runs",
    description: "List DB-canonical runs.",
    kind: "read",
    operation: "run.list",
    argsSchema: runListArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({
      projectId: projectIdJson,
      domain: { type: "string" },
      statuses: stringArraySchema,
      limit: { type: "number" },
      cursor: { type: "string" },
    }),
    handler: runListTool,
  }),
  define({
    name: "harness.run.get",
    title: "Get run",
    description: "Read a run summary and resource links.",
    kind: "read",
    operation: "run.get",
    argsSchema: runGetArgs,
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema(
      {
        runId: runIdJson,
        includeArtifacts: { type: "boolean" },
        includeTimeline: { type: "boolean" },
      },
      ["runId"],
    ),
    handler: runGetTool,
  }),
  define({
    name: "harness.run.timeline",
    title: "Get run timeline",
    description: "Read run lifecycle events.",
    kind: "read",
    operation: "run.timeline",
    argsSchema: runGetArgs.pick({ runId: true }),
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema({ runId: runIdJson }, ["runId"]),
    handler: runTimelineTool,
  }),
  define({
    name: "harness.run.artifacts",
    title: "List run artifacts",
    description: "List artifact metadata for a run.",
    kind: "read",
    operation: "run.artifacts",
    argsSchema: runGetArgs.pick({ runId: true }),
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema({ runId: runIdJson }, ["runId"]),
    handler: runArtifactsTool,
  }),
  define({
    name: "harness.run.artifact.get",
    title: "Get artifact metadata",
    description: "Read artifact metadata and safe body summary.",
    kind: "read",
    operation: "run.artifact.get",
    argsSchema: artifactGetArgs,
    inputSchema: objectSchema(
      { runId: runIdJson, artifactId: { type: "string" } },
      ["artifactId"],
    ),
    handler: runArtifactGetTool,
  }),
  define({
    name: "harness.review.queue",
    title: "Review queue",
    description: "List runs awaiting review.",
    kind: "read",
    operation: "review.queue",
    argsSchema: runListArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({
      projectId: projectIdJson,
      domain: { type: "string" },
      limit: { type: "number" },
      cursor: { type: "string" },
    }),
    handler: reviewQueueTool,
  }),
  define({
    name: "harness.review.proposals",
    title: "Review proposals",
    description: "List active review proposals for a run.",
    kind: "read",
    operation: "review.proposals",
    argsSchema: runGetArgs.pick({ runId: true }),
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema({ runId: runIdJson }, ["runId"]),
    handler: reviewProposalsTool,
  }),
  define({
    name: "harness.review.consensus",
    title: "Review consensus",
    description: "Read review consensus for a run.",
    kind: "read",
    operation: "review.consensus",
    argsSchema: runGetArgs.pick({ runId: true }),
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema({ runId: runIdJson }, ["runId"]),
    handler: reviewConsensusTool,
  }),
  define({
    name: "harness.backlog.list",
    title: "List backlog",
    description: "List DB-canonical backlog items.",
    kind: "read",
    operation: "backlog.list",
    argsSchema: backlogListArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({
      projectId: projectIdJson,
      repoId: { type: "string" },
      status: enumSchema(["open", "doing", "done", "deferred"]),
      limit: { type: "number" },
      cursor: { type: "string" },
    }),
    handler: backlogListTool,
  }),
  define({
    name: "harness.backlog.get",
    title: "Get backlog item",
    description: "Read a backlog item.",
    kind: "read",
    operation: "backlog.get",
    argsSchema: backlogGetArgs,
    resolveProjectIdForPermission: resolveBacklogProjectId,
    inputSchema: objectSchema({ itemId: { type: "string" } }, ["itemId"]),
    handler: backlogGetTool,
  }),
  define({
    name: "harness.knowledge.search",
    title: "Search knowledge",
    description: "Search promoted knowledge entries.",
    kind: "read",
    operation: "knowledge.search",
    argsSchema: knowledgeSearchArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        query: { type: "string" },
        projectId: projectIdJson,
        domain: { type: "string" },
        limit: { type: "number" },
      },
      ["query"],
    ),
    handler: knowledgeSearchTool,
  }),
  define({
    name: "harness.knowledge.get",
    title: "Get knowledge",
    description: "Read a knowledge entry.",
    kind: "read",
    operation: "knowledge.get",
    argsSchema: knowledgeGetArgs,
    resolveProjectIdForPermission: resolveKnowledgeProjectId,
    inputSchema: objectSchema(
      {
        entryId: { type: "string" },
        includeBody: { type: "boolean" },
        maxBytes: { type: "number" },
      },
      ["entryId"],
    ),
    handler: knowledgeGetTool,
  }),
  define({
    name: "harness.db.status",
    title: "DB status",
    description: "Read DB status.",
    kind: "read",
    operation: "db.status",
    argsSchema: noArgs,
    inputSchema: emptyInputSchema,
    handler: dbStatusTool,
  }),
  define({
    name: "harness.doctor.summary",
    title: "Doctor summary",
    description: "Read latest doctor summary.",
    kind: "read",
    operation: "doctor.summary",
    argsSchema: noArgs,
    inputSchema: emptyInputSchema,
    handler: doctorSummaryTool,
  }),
  define({
    name: "harness.operation.list",
    title: "List operations",
    description: "List operation audit rows.",
    kind: "read",
    operation: "operation.list",
    argsSchema: operationListArgs,
    inputSchema: objectSchema({
      targetType: { type: "string" },
      targetId: { type: "string" },
      status: enumSchema(["pending", "running", "succeeded", "failed", "cancelled"]),
      limit: { type: "number" },
      cursor: { type: "string" },
    }),
    handler: operationListTool,
  }),
  define({
    name: "harness.operation.get",
    title: "Get operation",
    description: "Read operation status and timeline.",
    kind: "read",
    operation: "operation.get",
    argsSchema: operationGetArgs,
    inputSchema: objectSchema({ operationId: { type: "string" } }, ["operationId"]),
    handler: operationGetTool,
  }),
  define({
    name: "harness.goal.list",
    title: "List goals",
    description: "List goal convergence sessions.",
    kind: "read",
    operation: "goal.list",
    argsSchema: goalListArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({
      status: enumSchema(GOAL_STATUSES),
      projectId: projectIdJson,
      repoId: { type: "string" },
      domain: { type: "string" },
      limit: { type: "number" },
    }),
    handler: goalListTool,
  }),
  define({
    name: "harness.goal.get",
    title: "Get goal",
    description: "Read one goal session.",
    kind: "read",
    operation: "goal.get",
    argsSchema: goalGetArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema({ goalId: goalIdJson }, ["goalId"]),
    handler: goalGetTool,
  }),
  define({
    name: "harness.goal.status",
    title: "Goal status",
    description: "Read a goal, findings, decisions, and current convergence.",
    kind: "read",
    operation: "goal.status",
    argsSchema: goalGetArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema({ goalId: goalIdJson }, ["goalId"]),
    handler: goalStatusTool,
  }),
  define({
    name: "harness.goal.findings",
    title: "Goal findings",
    description: "List findings for a goal.",
    kind: "read",
    operation: "goal.findings",
    argsSchema: goalGetArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema({ goalId: goalIdJson }, ["goalId"]),
    handler: goalFindingsTool,
  }),
  define({
    name: "harness.goal.decisions",
    title: "Goal decisions",
    description: "List recorded convergence decisions for a goal.",
    kind: "read",
    operation: "goal.decisions",
    argsSchema: goalGetArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema({ goalId: goalIdJson }, ["goalId"]),
    handler: goalDecisionsTool,
  }),
  define({
    name: "harness.project.check",
    title: "Check project",
    description: "Validate project profile and repo layout without mutation.",
    kind: "dry-run",
    operation: "project.check",
    argsSchema: projectGetArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({ projectId: projectIdJson }, ["projectId"]),
    handler: projectCheckTool,
  }),
  define({
    name: "harness.run.dry_run",
    title: "Dry-run run",
    description: "Preview a project run without mutation.",
    kind: "dry-run",
    operation: "run.dry_run",
    argsSchema: runDryRunArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        projectId: projectIdJson,
        domain: { type: "string" },
        goal: { type: "string" },
        contextPack: { type: "string" },
      },
      ["projectId", "domain", "goal"],
    ),
    handler: runDryRunTool,
  }),
  define({
    name: "harness.cleanup.dry_run",
    title: "Cleanup dry-run",
    description: "Preview cleanup for a run.",
    kind: "dry-run",
    operation: "cleanup.dry_run",
    argsSchema: runGetArgs.pick({ runId: true }),
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema({ runId: runIdJson }, ["runId"]),
    handler: cleanupDryRunTool,
  }),
  define({
    name: "harness.pr.preview",
    title: "PR preview",
    description: "Preview PR creation for a run.",
    kind: "dry-run",
    operation: "pr.preview",
    argsSchema: runGetArgs.pick({ runId: true }),
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema({ runId: runIdJson }, ["runId"]),
    handler: prPreviewTool,
  }),
  define({
    name: "harness.db.repair.dry_run",
    title: "DB repair dry-run",
    description: "Preview DB repair operations.",
    kind: "dry-run",
    operation: "db.repair.dry_run",
    argsSchema: dbPreviewArgs,
    inputSchema: objectSchema({ limit: { type: "number" } }),
    handler: dbRepairDryRunTool,
  }),
  define({
    name: "harness.db.archive.preview",
    title: "Archive preview",
    description: "Preview DB archive operations.",
    kind: "dry-run",
    operation: "db.archive.preview",
    argsSchema: dbPreviewArgs,
    inputSchema: objectSchema({ limit: { type: "number" } }),
    handler: dbArchivePreviewTool,
  }),
  define({
    name: "harness.db.migrate_blobs.preview",
    title: "Blob migration preview",
    description: "Preview artifact blob migration.",
    kind: "dry-run",
    operation: "db.migrate_blobs.preview",
    argsSchema: dbPreviewArgs,
    inputSchema: objectSchema({ limit: { type: "number" } }),
    handler: dbMigrateBlobsPreviewTool,
  }),
  define({
    name: "harness.db.gc_blobs.preview",
    title: "Blob GC preview",
    description: "Preview unreferenced external artifact blob GC.",
    kind: "dry-run",
    operation: "db.gc_blobs.preview",
    argsSchema: dbPreviewArgs,
    inputSchema: objectSchema({
      limit: { type: "number" },
      storeId: { type: "string" },
      deleteObjects: { type: "boolean" },
    }),
    handler: dbGcBlobsPreviewTool,
  }),
  define({
    name: "harness.run.start",
    title: "Start run",
    description: "Start a project run through OperationRunner.",
    kind: "mutation",
    operation: "run.start",
    argsSchema: runStartArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        projectId: projectIdJson,
        domain: { type: "string" },
        goal: { type: "string" },
        goalId: goalIdJson,
        contextPack: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["projectId", "domain", "goal", "idempotencyKey"],
    ),
    handler: runStartTool,
  }),
  define({
    name: "harness.review.auto",
    title: "Auto review",
    description: "Start an automated review through OperationRunner.",
    kind: "mutation",
    operation: "review.auto",
    argsSchema: reviewAutoArgs,
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema(
      {
        runId: runIdJson,
        goalId: goalIdJson,
        reviewer: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["runId", "idempotencyKey"],
    ),
    handler: reviewAutoTool,
  }),
  define({
    name: "harness.rerun.start",
    title: "Start rerun",
    description: "Start a rerun through OperationRunner.",
    kind: "mutation",
    operation: "rerun.start",
    argsSchema: rerunStartArgs,
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema(
      {
        runId: runIdJson,
        goalId: goalIdJson,
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["runId", "idempotencyKey"],
    ),
    handler: rerunStartTool,
  }),
  define({
    name: "harness.backlog.create",
    title: "Create backlog item",
    description: "Create a backlog item through OperationRunner.",
    kind: "mutation",
    operation: "backlog.create",
    argsSchema: backlogCreateArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        projectId: projectIdJson,
        repoId: { type: "string" },
        domain: { type: "string" },
        title: { type: "string" },
        goal: { type: "string" },
        priority: enumSchema(["high", "medium", "low"]),
        tags: stringArraySchema,
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["domain", "title", "goal", "idempotencyKey"],
    ),
    handler: backlogCreateTool,
  }),
  define({
    name: "harness.backlog.run",
    title: "Run backlog item",
    description: "Start work from a backlog item through OperationRunner.",
    kind: "mutation",
    operation: "backlog.run",
    argsSchema: backlogRunArgs,
    resolveProjectIdForPermission: resolveBacklogProjectId,
    inputSchema: objectSchema(
      {
        itemId: { type: "string" },
        workflow: enumSchema(["run", "reviewed-run"]),
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["itemId", "idempotencyKey"],
    ),
    handler: backlogRunTool,
  }),
  define({
    name: "harness.backlog.update",
    title: "Update backlog item",
    description: "Update a backlog item through OperationRunner.",
    kind: "mutation",
    operation: "backlog.update",
    argsSchema: backlogUpdateArgs,
    resolveProjectIdForPermission: resolveBacklogProjectId,
    inputSchema: objectSchema(
      {
        itemId: { type: "string" },
        status: enumSchema(["open", "doing", "done", "deferred"]),
        title: { type: "string" },
        goal: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["itemId", "idempotencyKey"],
    ),
    handler: backlogUpdateTool,
  }),
  define({
    name: "harness.goal.start",
    title: "Start goal",
    description: "Create a goal convergence session through OperationRunner.",
    kind: "mutation",
    operation: "goal.start",
    argsSchema: goalStartArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        goalId: goalIdJson,
        title: { type: "string" },
        description: { type: "string" },
        projectId: projectIdJson,
        repoId: { type: "string" },
        domain: { type: "string" },
        backlogItemId: { type: "string" },
        scope: goalScopeJson,
        closeConditions: { type: "array", items: { type: "object" } },
        policy: { type: "object", additionalProperties: true },
        maxIterations: { type: "number" },
        maxReviewCycles: { type: "number" },
        maxReruns: { type: "number" },
        maxTotalNewFindings: { type: "number" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["title", "idempotencyKey"],
    ),
    handler: goalStartTool,
  }),
  define({
    name: "harness.goal.record_findings",
    title: "Record goal findings",
    description: "Record review/test/human findings for a goal.",
    kind: "mutation",
    operation: "goal.record_findings",
    argsSchema: goalRecordFindingsArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema(
      {
        goalId: goalIdJson,
        findings: { type: "array", items: goalFindingJson },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["goalId", "findings", "idempotencyKey"],
    ),
    handler: goalRecordFindingsTool,
  }),
  define({
    name: "harness.goal.classify_finding",
    title: "Classify goal finding",
    description: "Manually classify a goal finding.",
    kind: "mutation",
    operation: "goal.classify_finding",
    argsSchema: goalClassifyFindingArgs,
    resolveProjectIdForPermission: resolveGoalFindingProjectId,
    inputSchema: objectSchema(
      {
        findingId: { type: "string" },
        scopeStatus: enumSchema(GOAL_SCOPE_STATUSES),
        reason: { type: "string" },
        duplicateOf: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["findingId", "scopeStatus", "reason", "idempotencyKey"],
    ),
    handler: goalClassifyFindingTool,
  }),
  define({
    name: "harness.goal.mark_finding_fixed",
    title: "Mark goal finding fixed",
    description: "Mark a goal finding as fixed.",
    kind: "mutation",
    operation: "goal.mark_finding_fixed",
    argsSchema: goalFindingMutationArgs,
    resolveProjectIdForPermission: resolveGoalFindingProjectId,
    inputSchema: objectSchema(
      {
        findingId: { type: "string" },
        note: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["findingId", "idempotencyKey"],
    ),
    handler: goalMarkFindingFixedTool,
  }),
  define({
    name: "harness.goal.defer_finding",
    title: "Defer goal finding",
    description: "Defer an out-of-scope finding, optionally creating a backlog follow-up.",
    kind: "mutation",
    operation: "goal.defer_finding",
    argsSchema: goalDeferFindingArgs,
    resolveProjectIdForPermission: resolveGoalFindingProjectId,
    inputSchema: objectSchema(
      {
        findingId: { type: "string" },
        reason: { type: "string" },
        createBacklogItem: { type: "boolean" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["findingId", "reason", "idempotencyKey"],
    ),
    handler: goalDeferFindingTool,
  }),
  define({
    name: "harness.goal.record_close_check",
    title: "Record goal close check",
    description: "Record close-check evidence for a goal.",
    kind: "mutation",
    operation: "goal.record_close_check",
    argsSchema: goalRecordCloseCheckArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema(
      {
        goalId: goalIdJson,
        conditionId: { type: "string" },
        status: enumSchema(GOAL_CLOSE_CHECK_STATUSES),
        checkedBy: { type: "string" },
        evidence: { type: "object", additionalProperties: true },
        message: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["goalId", "conditionId", "status", "idempotencyKey"],
    ),
    handler: goalRecordCloseCheckTool,
  }),
  define({
    name: "harness.goal.check_convergence",
    title: "Check goal convergence",
    description: "Evaluate and record goal convergence.",
    kind: "mutation",
    operation: "goal.check_convergence",
    argsSchema: goalCheckConvergenceArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema(
      {
        goalId: goalIdJson,
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["goalId", "idempotencyKey"],
    ),
    handler: goalCheckConvergenceTool,
  }),
  define({
    name: "harness.knowledge.promote",
    title: "Promote knowledge",
    description: "Promote a knowledge candidate through OperationRunner.",
    kind: "mutation",
    operation: "knowledge.promote",
    argsSchema: knowledgeDecisionArgs,
    resolveProjectIdForPermission: resolveKnowledgeCandidateProjectId,
    inputSchema: objectSchema(
      {
        candidateId: { type: "string" },
        reason: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["candidateId", "idempotencyKey"],
    ),
    handler: knowledgePromoteTool,
  }),
  define({
    name: "harness.knowledge.reject",
    title: "Reject knowledge",
    description: "Reject a knowledge candidate through OperationRunner.",
    kind: "mutation",
    operation: "knowledge.reject",
    argsSchema: knowledgeDecisionArgs,
    resolveProjectIdForPermission: resolveKnowledgeCandidateProjectId,
    inputSchema: objectSchema(
      {
        candidateId: { type: "string" },
        reason: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["candidateId", "idempotencyKey"],
    ),
    handler: knowledgeRejectTool,
  }),
  define({
    name: "harness.review.process",
    title: "Process review decision",
    description: "Preview review processing; execution requires confirmation.",
    kind: "dangerous",
    operation: "review.process",
    argsSchema: reviewProcessArgs,
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema(
      {
        runId: runIdJson,
        goalId: goalIdJson,
        decision: enumSchema(["approved", "changes_requested", "rejected"]),
        proposalId: { type: "number" },
        sourceSha256: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["runId", "decision", "idempotencyKey"],
    ),
    handler: reviewProcessTool,
  }),
  define({
    name: "harness.cleanup.apply",
    title: "cleanup.apply",
    description: "Preview cleanup execution; execution requires confirmation.",
    kind: "dangerous",
    operation: "cleanup.apply",
    argsSchema: dangerousRunArgs,
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema(
      { runId: runIdJson, idempotencyKey: idempotencyJson, actorNote: { type: "string" } },
      ["runId", "idempotencyKey"],
    ),
    handler: cleanupApplyTool,
  }),
  define({
    name: "harness.pr.create",
    title: "pr.create",
    description: "Preview PR creation; execution requires confirmation.",
    kind: "dangerous",
    operation: "pr.create",
    argsSchema: dangerousRunArgs,
    resolveProjectIdForPermission: resolveRunProjectId,
    inputSchema: objectSchema(
      { runId: runIdJson, idempotencyKey: idempotencyJson, actorNote: { type: "string" } },
      ["runId", "idempotencyKey"],
    ),
    handler: prCreateTool,
  }),
  define({
    name: "harness.goal.close",
    title: "Close goal",
    description: "Close a goal. Confirmation is required unless it is close_ready.",
    kind: "dangerous",
    operation: "goal.close",
    argsSchema: goalCloseArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema(
      {
        goalId: goalIdJson,
        summary: { type: "string" },
        force: { type: "boolean" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["goalId", "summary", "idempotencyKey"],
    ),
    handler: goalCloseTool,
  }),
  define({
    name: "harness.goal.cancel",
    title: "Cancel goal",
    description: "Cancel a goal after confirmation.",
    kind: "dangerous",
    operation: "goal.cancel",
    argsSchema: goalCancelArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema(
      {
        goalId: goalIdJson,
        reason: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["goalId", "reason", "idempotencyKey"],
    ),
    handler: goalCancelTool,
  }),
  define({
    name: "harness.goal.expand_scope",
    title: "Expand goal scope",
    description: "Expand a goal scope after confirmation.",
    kind: "dangerous",
    operation: "goal.expand_scope",
    argsSchema: goalExpandScopeArgs,
    resolveProjectIdForPermission: resolveGoalProjectId,
    inputSchema: objectSchema(
      {
        goalId: goalIdJson,
        scope: goalScopeJson,
        reason: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["goalId", "scope", "reason", "idempotencyKey"],
    ),
    handler: goalExpandScopeTool,
  }),
  define({
    name: "harness.db.repair.apply",
    title: "db.repair.apply",
    description: "Preview DB repair execution; execution requires confirmation.",
    kind: "dangerous",
    operation: "db.repair.apply",
    argsSchema: dbRepairApplyArgs,
    resolveProjectIdForPermission: resolveDoctorFindingProjectId,
    inputSchema: objectSchema(
      {
        findingId: { type: "number" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["findingId", "idempotencyKey"],
    ),
    handler: dbRepairApplyTool,
  }),
  define({
    name: "harness.db.archive.apply",
    title: "db.archive.apply",
    description: "Preview DB archive execution; execution requires confirmation.",
    kind: "dangerous",
    operation: "db.archive.apply",
    argsSchema: dbArchiveApplyArgs,
    inputSchema: objectSchema(
      {
        before: { type: "string" },
        out: { type: "string" },
        archiveId: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["before", "idempotencyKey"],
    ),
    handler: dbArchiveApplyTool,
  }),
  define({
    name: "harness.db.migrate_blobs.apply",
    title: "db.migrate_blobs.apply",
    description: "Preview blob migration execution; execution requires confirmation.",
    kind: "dangerous",
    operation: "db.migrate_blobs.apply",
    argsSchema: dbMigrateBlobsApplyArgs,
    inputSchema: objectSchema(
      {
        to: enumSchema(["external", "db"]),
        storeId: { type: "string" },
        limit: { type: "number" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["to", "idempotencyKey"],
    ),
    handler: dbMigrateBlobsApplyTool,
  }),
  define({
    name: "harness.db.gc_blobs.apply",
    title: "db.gc_blobs.apply",
    description: "Preview blob GC execution; execution requires confirmation.",
    kind: "dangerous",
    operation: "db.gc_blobs.apply",
    argsSchema: dbGcBlobsApplyArgs,
    inputSchema: objectSchema(
      {
        storeId: { type: "string" },
        deleteObjects: { type: "boolean" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["idempotencyKey"],
    ),
    handler: dbGcBlobsApplyTool,
  }),
];

export function listMcpTools(): Array<{
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
}> {
  return MCP_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function getMcpTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOL_DEFINITIONS.find((t) => t.name === name);
}
