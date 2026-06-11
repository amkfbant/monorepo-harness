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
  workspaceCheckpointTool,
  workspaceListTool,
  workspaceStatusTool,
} from "../tools/workspace-tools.js";
import {
  workspaceConflictsTool,
  workspaceInspectTool,
  workspaceRecoverTool,
} from "../tools/workspace-read-tools.js";
import { inboxTool, metricsTool } from "../tools/aggregate-tools.js";
import {
  opsKnowledgeGetTool,
  opsKnowledgeSearchTool,
  resolveOpsKnowledgeProjectId,
} from "../tools/ops-knowledge-tools.js";
import { releasePlanTool } from "../tools/release-tools.js";
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
  opsKnowledgeRecordTool,
  opsKnowledgeDeprecateTool,
  resolveDoctorFindingProjectId,
  orchestrateHitchTool,
  prCreateTool,
  rerunStartTool,
  resolveKnowledgeCandidateProjectId,
  reviewAutoTool,
  reviewProcessTool,
  runStartTool,
} from "../tools/mutation-tools.js";
import {
  hitchCancelTool,
  hitchCheckConvergenceTool,
  hitchClassifyFindingTool,
  hitchCloseTool,
  hitchDecisionsTool,
  hitchDeferFindingTool,
  hitchExpandScopeTool,
  hitchFindingsTool,
  hitchGetTool,
  hitchListTool,
  hitchMarkFindingFixedTool,
  hitchRecordCloseCheckTool,
  hitchRecordFindingsTool,
  hitchStartTool,
  hitchStatusTool,
  resolveHitchFindingProjectId,
  resolveHitchProjectId,
} from "../tools/hitch-tools.js";
import {
  courseCreateTool,
  courseGetTool,
  courseListTool,
  courseStatusTool,
  phaseAddTool,
  phaseGetTool,
  phaseListTool,
  phaseLinkHitchTool,
  phaseUpdateTool,
  resolveCourseProjectId,
  resolvePhaseProjectId,
} from "../tools/course-tools.js";
import type { McpPermissionDecision } from "../security/permissions.js";
import {
  HITCH_CLOSE_CHECK_STATUSES,
  HITCH_FINDING_SEVERITIES,
  HITCH_FINDING_SOURCES,
  HITCH_SCOPE_STATUSES,
  HITCH_STATUSES,
} from "../../hitch/types.js";
import {
  HitchCloseConditionSchema,
  HitchPolicySchema,
  HitchScopeSchema,
} from "../../hitch/schemas.js";
import { COURSE_STATUSES, PHASE_STATUSES } from "../../roadmap/types.js";

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
    hitchId: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const reviewAutoArgs = z
  .object({
    runId: z.string().min(1),
    hitchId: z.string().min(1).optional(),
    reviewer: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const reviewProcessArgs = z
  .object({
    runId: z.string().min(1),
    hitchId: z.string().min(1).optional(),
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

const opsKnowledgeSearchArgs = z
  .object({
    query: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    includeDeprecated: z.boolean().optional(),
    limit: LimitSchema,
  })
  .strict();

const opsKnowledgeGetArgs = z
  .object({
    entryId: z.string().min(1),
    includeBody: z.boolean().optional(),
    maxBytes: z.number().int().min(0).optional(),
  })
  .strict();

const releasePlanArgs = z
  .object({
    since: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
  })
  .strict();

const opsKnowledgeRecordArgs = z
  .object({
    title: z.string().min(1),
    body: z.string().min(1),
    // MCP writes require an explicit key so the operation targets a real,
    // resolvable `ops/<key>` row (audit / idempotency / project-scope checks).
    key: z.string().min(1),
    kind: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    reason: z.string().optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const opsKnowledgeDeprecateArgs = z
  .object({
    entryId: z.string().min(1),
    reason: z.string().optional(),
  })
  .merge(MutationArgsBaseSchema)
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

const hitchListArgs = z
  .object({
    status: z.enum(HITCH_STATUSES).optional(),
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    limit: LimitSchema,
  })
  .strict();

const hitchGetArgs = z
  .object({
    hitchId: z.string().min(1),
  })
  .strict();

const hitchStartArgs = z
  .object({
    hitchId: z.string().min(1).optional(),
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    backlogItemId: z.string().min(1).optional(),
    scope: HitchScopeSchema.optional(),
    closeConditions: z.array(HitchCloseConditionSchema).optional(),
    policy: HitchPolicySchema.optional(),
    maxIterations: z.number().int().min(1).optional(),
    maxReviewCycles: z.number().int().min(1).optional(),
    maxReruns: z.number().int().min(0).optional(),
    maxTotalNewFindings: z.number().int().min(0).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchFindingInputArgs = z
  .object({
    severity: z.enum(HITCH_FINDING_SEVERITIES),
    category: z.string().min(1),
    summary: z.string().min(1),
    detail: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    suggestedFix: z.string().min(1).optional(),
    source: z.enum(HITCH_FINDING_SOURCES).optional(),
    sourceRef: z.string().min(1).optional(),
    sourceAttemptId: z.string().min(1).optional(),
    sourceCycleId: z.string().min(1).optional(),
    scopeStatus: z.enum(HITCH_SCOPE_STATUSES).optional(),
  })
  .strict();

const hitchRecordFindingsArgs = z
  .object({
    hitchId: z.string().min(1),
    findings: z.array(hitchFindingInputArgs).min(1).max(50),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchClassifyFindingArgs = z
  .object({
    findingId: z.string().min(1),
    scopeStatus: z.enum(HITCH_SCOPE_STATUSES),
    reason: z.string().min(1),
    duplicateOf: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchFindingMutationArgs = z
  .object({
    findingId: z.string().min(1),
    note: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchDeferFindingArgs = z
  .object({
    findingId: z.string().min(1),
    reason: z.string().min(1),
    createBacklogItem: z.boolean().optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchRecordCloseCheckArgs = z
  .object({
    hitchId: z.string().min(1),
    conditionId: z.string().min(1),
    status: z.enum(HITCH_CLOSE_CHECK_STATUSES),
    checkedBy: z.string().min(1).optional(),
    evidence: z.record(z.unknown()).optional(),
    message: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchCheckConvergenceArgs = z
  .object({
    hitchId: z.string().min(1),
    updateStatus: z.boolean().optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchCloseArgs = z
  .object({
    hitchId: z.string().min(1),
    summary: z.string().min(1),
    force: z.boolean().optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchCancelArgs = z
  .object({
    hitchId: z.string().min(1),
    reason: z.string().min(1),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const hitchExpandScopeArgs = z
  .object({
    hitchId: z.string().min(1),
    scope: HitchScopeSchema,
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
    hitchId: z.string().min(1).optional(),
  })
  .merge(MutationArgsBaseSchema)
  .strict();

const orchestrateHitchArgs = z
  .object({
    hitchId: z.string().min(1),
    maxSteps: z.number().int().positive().max(50).optional(),
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
const hitchIdJson = { type: "string", description: "Hitch id" };
const idempotencyJson = {
  type: "string",
  description: "Required idempotency key for mutation tools",
};
const hitchScopeJson = {
  type: "object",
  description: "Hitch scope object",
  additionalProperties: true,
};
const hitchFindingJson = {
  type: "object",
  description: "Hitch finding input",
  additionalProperties: true,
};

const workspaceListArgs = z
  .object({
    agent: z.string().min(1).optional(),
    limit: LimitSchema,
  })
  .strict();

const workspaceStatusArgs = z
  .object({
    repoPath: z.string().min(1),
    base: z.string().min(1).optional(),
    staleAfterHours: z.number().nonnegative().optional(),
  })
  .strict();

const workspaceCheckpointArgs = z
  .object({
    repoPath: z.string().min(1),
    agent: z.string().min(1),
    note: z.string().optional(),
    hitchId: z.string().min(1).optional(),
    objective: z.string().optional(),
    idempotencyKey: z.string().min(1),
    actorNote: z.string().optional(),
  })
  .strict();

// inbox = current actionable state; a time window is not honored consistently
// across its buckets (knowledge-candidate count is all-time), so it is not
// exposed there. metrics is historical, so it accepts `sinceHours`.
const inboxArgs = z
  .object({
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
  })
  .strict();

const metricsArgs = z
  .object({
    projectId: z.string().min(1).optional(),
    repoId: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    sinceHours: z.number().nonnegative().optional(),
  })
  .strict();

const workspaceInspectArgs = z
  .object({
    repoPath: z.string().min(1),
    agent: z.string().min(1),
    base: z.string().min(1).optional(),
  })
  .strict();

const workspaceConflictsArgs = z
  .object({
    repoPath: z.string().min(1),
    base: z.string().min(1).optional(),
  })
  .strict();

const workspaceRecoverArgs = z
  .object({
    repoPath: z.string().min(1),
    agent: z.string().min(1),
    base: z.string().min(1).optional(),
  })
  .strict();

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
    name: "harness.ops_knowledge.search",
    title: "Search operational knowledge",
    description:
      "Search operational (non-codebase) knowledge: toolchain / CI / environment / harness-usage learnings (issue #57).",
    kind: "read",
    operation: "ops_knowledge.search",
    argsSchema: opsKnowledgeSearchArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        query: { type: "string" },
        projectId: projectIdJson,
        repoId: { type: "string", description: "Repo id" },
        domain: { type: "string" },
        includeDeprecated: { type: "boolean" },
        limit: { type: "number" },
      },
      [],
    ),
    handler: opsKnowledgeSearchTool,
  }),
  define({
    name: "harness.ops_knowledge.get",
    title: "Get operational knowledge",
    description: "Read an operational knowledge entry (issue #57).",
    kind: "read",
    operation: "ops_knowledge.get",
    argsSchema: opsKnowledgeGetArgs,
    resolveProjectIdForPermission: resolveOpsKnowledgeProjectId,
    inputSchema: objectSchema(
      {
        entryId: { type: "string" },
        includeBody: { type: "boolean" },
        maxBytes: { type: "number" },
      },
      ["entryId"],
    ),
    handler: opsKnowledgeGetTool,
  }),
  define({
    name: "harness.ops_knowledge.record",
    title: "Record operational knowledge",
    description:
      "Author operational (non-codebase) knowledge through OperationRunner (issue #57). Guarded mutation.",
    kind: "mutation",
    operation: "ops_knowledge.record",
    argsSchema: opsKnowledgeRecordArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        title: { type: "string" },
        body: { type: "string" },
        key: { type: "string" },
        kind: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        projectId: projectIdJson,
        repoId: { type: "string", description: "Repo id" },
        domain: { type: "string" },
        reason: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["title", "body", "key", "idempotencyKey"],
    ),
    handler: opsKnowledgeRecordTool,
  }),
  define({
    name: "harness.ops_knowledge.deprecate",
    title: "Deprecate operational knowledge",
    description:
      "Deprecate an operational knowledge entry through OperationRunner (issue #57). Guarded mutation.",
    kind: "mutation",
    operation: "ops_knowledge.deprecate",
    argsSchema: opsKnowledgeDeprecateArgs,
    resolveProjectIdForPermission: resolveOpsKnowledgeProjectId,
    inputSchema: objectSchema(
      {
        entryId: { type: "string" },
        reason: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["entryId", "idempotencyKey"],
    ),
    handler: opsKnowledgeDeprecateTool,
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
    name: "harness.release.plan",
    title: "Release plan",
    description:
      "Deterministic release-readiness + compatibility analysis for a tag range (schema delta / no-downgrade / added-removed CLI+MCP surface / recommended bump). Read-only; complements release-please.",
    kind: "read",
    operation: "release.plan",
    argsSchema: releasePlanArgs,
    inputSchema: objectSchema(
      {
        since: { type: "string", description: "compare-from ref (default: last tag)" },
        to: { type: "string", description: "compare-to ref (default: HEAD)" },
      },
      [],
    ),
    handler: releasePlanTool,
  }),
  define({
    name: "harness.inbox",
    title: "What to look at now",
    description:
      "Runs needing attention: needs-review / changes-requested / failed runs, " +
      "a knowledge-candidate run count, and an operational-knowledge slice " +
      "(operationalKnowledge.total + recent entries). Optional projectId / " +
      "repoId / domain filters. Scoped to allowedProjects. Pure DB read.",
    kind: "read",
    operation: "inbox",
    argsSchema: inboxArgs,
    inputSchema: objectSchema({
      projectId: { type: "string" },
      repoId: { type: "string" },
      domain: { type: "string" },
    }),
    handler: inboxTool,
  }),
  define({
    name: "harness.metrics",
    title: "Run / review metrics",
    description:
      "Aggregate run health: run counts by status, plus review approved-rate. " +
      "Optional projectId / repoId / domain / sinceHours filters. Scoped to " +
      "allowedProjects. Pure DB read.",
    kind: "read",
    operation: "metrics",
    argsSchema: metricsArgs,
    inputSchema: objectSchema({
      projectId: { type: "string" },
      repoId: { type: "string" },
      domain: { type: "string" },
      sinceHours: { type: "number" },
    }),
    handler: metricsTool,
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
    name: "harness.hitch.list",
    title: "List hitches",
    description: "List hitch convergence sessions.",
    kind: "read",
    operation: "hitch.list",
    argsSchema: hitchListArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({
      status: enumSchema(HITCH_STATUSES),
      projectId: projectIdJson,
      repoId: { type: "string" },
      domain: { type: "string" },
      limit: { type: "number" },
    }),
    handler: hitchListTool,
  }),
  define({
    name: "harness.hitch.get",
    title: "Get hitch",
    description: "Read one hitch session.",
    kind: "read",
    operation: "hitch.get",
    argsSchema: hitchGetArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema({ hitchId: hitchIdJson }, ["hitchId"]),
    handler: hitchGetTool,
  }),
  define({
    name: "harness.hitch.status",
    title: "Hitch status",
    description: "Read a hitch, findings, decisions, and current convergence.",
    kind: "read",
    operation: "hitch.status",
    argsSchema: hitchGetArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema({ hitchId: hitchIdJson }, ["hitchId"]),
    handler: hitchStatusTool,
  }),
  define({
    name: "harness.hitch.findings",
    title: "Hitch findings",
    description: "List findings for a hitch.",
    kind: "read",
    operation: "hitch.findings",
    argsSchema: hitchGetArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema({ hitchId: hitchIdJson }, ["hitchId"]),
    handler: hitchFindingsTool,
  }),
  define({
    name: "harness.hitch.decisions",
    title: "Hitch decisions",
    description: "List recorded convergence decisions for a hitch.",
    kind: "read",
    operation: "hitch.decisions",
    argsSchema: hitchGetArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema({ hitchId: hitchIdJson }, ["hitchId"]),
    handler: hitchDecisionsTool,
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
        hitchId: hitchIdJson,
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
        hitchId: hitchIdJson,
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
        hitchId: hitchIdJson,
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["runId", "idempotencyKey"],
    ),
    handler: rerunStartTool,
  }),
  define({
    name: "harness.hitch.orchestrate",
    title: "Drive hitch loop",
    description:
      "Advance a hitch a bounded number of orchestrator steps (coder rerun -> " +
      "review -> convergence), halting at close_ready WITHOUT opening a PR.",
    kind: "mutation",
    operation: "hitch.orchestrate",
    argsSchema: orchestrateHitchArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema(
      {
        hitchId: hitchIdJson,
        maxSteps: {
          type: "number",
          description: "Max orchestrator steps to run (1-50, default 20)",
        },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["hitchId", "idempotencyKey"],
    ),
    handler: orchestrateHitchTool,
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
    name: "harness.hitch.start",
    title: "Start hitch",
    description: "Create a hitch convergence session through OperationRunner.",
    kind: "mutation",
    operation: "hitch.start",
    argsSchema: hitchStartArgs,
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        hitchId: hitchIdJson,
        title: { type: "string" },
        description: { type: "string" },
        projectId: projectIdJson,
        repoId: { type: "string" },
        domain: { type: "string" },
        backlogItemId: { type: "string" },
        scope: hitchScopeJson,
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
    handler: hitchStartTool,
  }),
  define({
    name: "harness.hitch.record_findings",
    title: "Record hitch findings",
    description: "Record review/test/human findings for a hitch.",
    kind: "mutation",
    operation: "hitch.record_findings",
    argsSchema: hitchRecordFindingsArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema(
      {
        hitchId: hitchIdJson,
        findings: { type: "array", items: hitchFindingJson },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["hitchId", "findings", "idempotencyKey"],
    ),
    handler: hitchRecordFindingsTool,
  }),
  define({
    name: "harness.hitch.classify_finding",
    title: "Classify hitch finding",
    description: "Manually classify a hitch finding.",
    kind: "mutation",
    operation: "hitch.classify_finding",
    argsSchema: hitchClassifyFindingArgs,
    resolveProjectIdForPermission: resolveHitchFindingProjectId,
    inputSchema: objectSchema(
      {
        findingId: { type: "string" },
        scopeStatus: enumSchema(HITCH_SCOPE_STATUSES),
        reason: { type: "string" },
        duplicateOf: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["findingId", "scopeStatus", "reason", "idempotencyKey"],
    ),
    handler: hitchClassifyFindingTool,
  }),
  define({
    name: "harness.hitch.mark_finding_fixed",
    title: "Mark hitch finding fixed",
    description: "Mark a hitch finding as fixed.",
    kind: "mutation",
    operation: "hitch.mark_finding_fixed",
    argsSchema: hitchFindingMutationArgs,
    resolveProjectIdForPermission: resolveHitchFindingProjectId,
    inputSchema: objectSchema(
      {
        findingId: { type: "string" },
        note: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["findingId", "idempotencyKey"],
    ),
    handler: hitchMarkFindingFixedTool,
  }),
  define({
    name: "harness.hitch.defer_finding",
    title: "Defer hitch finding",
    description: "Defer an out-of-scope finding, optionally creating a backlog follow-up.",
    kind: "mutation",
    operation: "hitch.defer_finding",
    argsSchema: hitchDeferFindingArgs,
    resolveProjectIdForPermission: resolveHitchFindingProjectId,
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
    handler: hitchDeferFindingTool,
  }),
  define({
    name: "harness.hitch.record_close_check",
    title: "Record hitch close check",
    description: "Record close-check evidence for a hitch.",
    kind: "mutation",
    operation: "hitch.record_close_check",
    argsSchema: hitchRecordCloseCheckArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema(
      {
        hitchId: hitchIdJson,
        conditionId: { type: "string" },
        status: enumSchema(HITCH_CLOSE_CHECK_STATUSES),
        checkedBy: { type: "string" },
        evidence: { type: "object", additionalProperties: true },
        message: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["hitchId", "conditionId", "status", "idempotencyKey"],
    ),
    handler: hitchRecordCloseCheckTool,
  }),
  define({
    name: "harness.hitch.check_convergence",
    title: "Check hitch convergence",
    description: "Evaluate and record hitch convergence.",
    kind: "mutation",
    operation: "hitch.check_convergence",
    argsSchema: hitchCheckConvergenceArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema(
      {
        hitchId: hitchIdJson,
        updateStatus: { type: "boolean" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["hitchId", "idempotencyKey"],
    ),
    handler: hitchCheckConvergenceTool,
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
        hitchId: hitchIdJson,
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
    name: "harness.hitch.close",
    title: "Close hitch",
    description: "Close a hitch. Confirmation is required unless it is close_ready.",
    kind: "dangerous",
    operation: "hitch.close",
    argsSchema: hitchCloseArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema(
      {
        hitchId: hitchIdJson,
        summary: { type: "string" },
        force: { type: "boolean" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["hitchId", "summary", "idempotencyKey"],
    ),
    handler: hitchCloseTool,
  }),
  define({
    name: "harness.hitch.cancel",
    title: "Cancel hitch",
    description: "Cancel a hitch after confirmation.",
    kind: "dangerous",
    operation: "hitch.cancel",
    argsSchema: hitchCancelArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema(
      {
        hitchId: hitchIdJson,
        reason: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["hitchId", "reason", "idempotencyKey"],
    ),
    handler: hitchCancelTool,
  }),
  define({
    name: "harness.hitch.expand_scope",
    title: "Expand hitch scope",
    description: "Expand a hitch scope after confirmation.",
    kind: "dangerous",
    operation: "hitch.expand_scope",
    argsSchema: hitchExpandScopeArgs,
    resolveProjectIdForPermission: resolveHitchProjectId,
    inputSchema: objectSchema(
      {
        hitchId: hitchIdJson,
        scope: hitchScopeJson,
        reason: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["hitchId", "scope", "reason", "idempotencyKey"],
    ),
    handler: hitchExpandScopeTool,
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
  // -------------------------------------------------------------------------
  // Course / Phase tools (SP-1)
  // -------------------------------------------------------------------------
  define({
    name: "harness.course.list",
    title: "List courses",
    description:
      "List roadmap courses visible to the MCP client. " +
      "A null-project course is invisible to a project-restricted client (fail-closed).",
    kind: "read",
    operation: "course.list",
    argsSchema: z
      .object({
        status: z.enum(COURSE_STATUSES).optional(),
        projectId: z.string().min(1).optional(),
        limit: LimitSchema,
      })
      .strict(),
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema({
      status: enumSchema(COURSE_STATUSES),
      projectId: { type: "string", description: "Project id" },
      limit: { type: "number" },
    }),
    handler: courseListTool,
  }),
  define({
    name: "harness.course.get",
    title: "Get course",
    description: "Read one roadmap course.",
    kind: "read",
    operation: "course.get",
    argsSchema: z.object({ courseId: z.string().min(1) }).strict(),
    resolveProjectIdForPermission: resolveCourseProjectId,
    inputSchema: objectSchema(
      { courseId: { type: "string", description: "Course id" } },
      ["courseId"],
    ),
    handler: courseGetTool,
  }),
  define({
    name: "harness.course.status",
    title: "Course rollup status",
    description:
      "Read a course and its live phase-tree rollup (open P0/P1 derived " +
      "from hitch_findings, phase counts by status).",
    kind: "read",
    operation: "course.status",
    argsSchema: z.object({ courseId: z.string().min(1) }).strict(),
    resolveProjectIdForPermission: resolveCourseProjectId,
    inputSchema: objectSchema(
      { courseId: { type: "string", description: "Course id" } },
      ["courseId"],
    ),
    handler: courseStatusTool,
  }),
  define({
    name: "harness.phase.list",
    title: "List phases for a course",
    description: "List phases for a roadmap course, ordered by position.",
    kind: "read",
    operation: "phase.list",
    argsSchema: z.object({ courseId: z.string().min(1) }).strict(),
    resolveProjectIdForPermission: resolveCourseProjectId,
    inputSchema: objectSchema(
      { courseId: { type: "string", description: "Course id" } },
      ["courseId"],
    ),
    handler: phaseListTool,
  }),
  define({
    name: "harness.phase.get",
    title: "Get phase",
    description: "Read one roadmap phase.",
    kind: "read",
    operation: "phase.get",
    argsSchema: z.object({ phaseId: z.string().min(1) }).strict(),
    resolveProjectIdForPermission: resolvePhaseProjectId,
    inputSchema: objectSchema(
      { phaseId: { type: "string", description: "Phase id" } },
      ["phaseId"],
    ),
    handler: phaseGetTool,
  }),
  define({
    name: "harness.course.create",
    title: "Create course",
    description:
      "Create a roadmap course through OperationRunner. Guarded mutation.",
    kind: "mutation",
    operation: "course.create",
    argsSchema: z
      .object({
        title: z.string().min(1),
        description: z.string().min(1).optional(),
        projectId: z.string().min(1).optional(),
        repoId: z.string().min(1).optional(),
      })
      .merge(MutationArgsBaseSchema)
      .strict(),
    projectIdFromArgs: (args) => args.projectId,
    inputSchema: objectSchema(
      {
        title: { type: "string" },
        description: { type: "string" },
        projectId: { type: "string", description: "Project id" },
        repoId: { type: "string", description: "Repo id" },
        idempotencyKey: { type: "string", description: "Required idempotency key for mutation tools" },
        actorNote: { type: "string" },
      },
      ["title", "idempotencyKey"],
    ),
    handler: courseCreateTool,
  }),
  define({
    name: "harness.phase.add",
    title: "Add phase to course",
    description:
      "Add a phase to a roadmap course through OperationRunner. Guarded mutation.",
    kind: "mutation",
    operation: "phase.add",
    argsSchema: z
      .object({
        courseId: z.string().min(1),
        title: z.string().min(1),
        parentPhaseId: z.string().min(1).optional(),
        position: z.number().int().min(0).optional(),
        scope: z.unknown().optional(),
        closeConditions: z.unknown().optional(),
      })
      .merge(MutationArgsBaseSchema)
      .strict(),
    resolveProjectIdForPermission: resolveCourseProjectId,
    inputSchema: objectSchema(
      {
        courseId: { type: "string", description: "Course id" },
        title: { type: "string" },
        parentPhaseId: { type: "string", description: "Parent phase id" },
        position: { type: "number" },
        scope: { type: "object", additionalProperties: true },
        closeConditions: { type: "array", items: { type: "object" } },
        idempotencyKey: { type: "string", description: "Required idempotency key for mutation tools" },
        actorNote: { type: "string" },
      },
      ["courseId", "title", "idempotencyKey"],
    ),
    handler: phaseAddTool,
  }),
  define({
    name: "harness.phase.update",
    title: "Update phase",
    description:
      "Update a phase status through OperationRunner. Guarded mutation.",
    kind: "mutation",
    operation: "phase.update",
    argsSchema: z
      .object({
        phaseId: z.string().min(1),
        status: z.enum(PHASE_STATUSES).optional(),
      })
      .merge(MutationArgsBaseSchema)
      .strict(),
    resolveProjectIdForPermission: resolvePhaseProjectId,
    inputSchema: objectSchema(
      {
        phaseId: { type: "string", description: "Phase id" },
        status: enumSchema(PHASE_STATUSES),
        idempotencyKey: { type: "string", description: "Required idempotency key for mutation tools" },
        actorNote: { type: "string" },
      },
      ["phaseId", "idempotencyKey"],
    ),
    handler: phaseUpdateTool,
  }),
  define({
    name: "harness.phase.link_hitch",
    title: "Link hitch to phase",
    description:
      "Link a hitch session to a roadmap phase through OperationRunner. " +
      "Rejects cross-project links and double-links. Guarded mutation.",
    kind: "mutation",
    operation: "phase.link_hitch",
    argsSchema: z
      .object({
        phaseId: z.string().min(1),
        hitchId: z.string().min(1),
      })
      .merge(MutationArgsBaseSchema)
      .strict(),
    resolveProjectIdForPermission: resolvePhaseProjectId,
    inputSchema: objectSchema(
      {
        phaseId: { type: "string", description: "Phase id" },
        hitchId: { type: "string", description: "Hitch id" },
        idempotencyKey: { type: "string", description: "Required idempotency key for mutation tools" },
        actorNote: { type: "string" },
      },
      ["phaseId", "hitchId", "idempotencyKey"],
    ),
    handler: phaseLinkHitchTool,
  }),
  define({
    name: "harness.workspace.list",
    title: "List agent workspaces",
    description:
      "Read-only coordination view of the per-agent workspaces (DB index): " +
      "branch, linked hitch + its convergence decision, objective, heartbeat, " +
      "and last checkpoint. No git state; mutations stay CLI-only.",
    kind: "read",
    operation: "workspace.list",
    argsSchema: workspaceListArgs,
    inputSchema: objectSchema({
      agent: { type: "string" },
      limit: { type: "number" },
    }),
    handler: workspaceListTool,
  }),
  define({
    name: "harness.workspace.status",
    title: "Git-inclusive workspace status",
    description:
      "Status of every workspace of one repo. repoPath = a tracked worktree " +
      "path (from workspace.list) or any subpath under it. Returns progress " +
      "label + git state (dirty / ahead-behind) + linked hitch + heartbeat. " +
      "Read-only (runs read-only git in known worktrees only).",
    kind: "read",
    operation: "workspace.status",
    argsSchema: workspaceStatusArgs,
    inputSchema: objectSchema(
      {
        repoPath: { type: "string" },
        base: { type: "string" },
        staleAfterHours: { type: "number" },
      },
      ["repoPath"],
    ),
    handler: workspaceStatusTool,
  }),
  define({
    name: "harness.workspace.inspect",
    title: "Deterministic git briefing of one workspace",
    description:
      "Git-only briefing of one agent's workspace (branch / HEAD / dirty / " +
      "ahead-behind vs base / last commit). repoPath = a tracked worktree path " +
      "(from workspace.list) or any subpath; the agent must be in scope. " +
      "Read-only (runs read-only git in known worktrees only).",
    kind: "read",
    operation: "workspace.inspect",
    argsSchema: workspaceInspectArgs,
    inputSchema: objectSchema(
      {
        repoPath: { type: "string" },
        agent: { type: "string" },
        base: { type: "string" },
      },
      ["repoPath", "agent"],
    ),
    handler: workspaceInspectTool,
  }),
  define({
    name: "harness.workspace.conflicts",
    title: "Cross-agent changed-file overlap pre-check",
    description:
      "Pairs of agent workspaces (of one repo) that have changed the SAME " +
      "files — the overlap pre-check for concurrent multi-agent work. repoPath " +
      "= a tracked worktree path or any subpath. Only in-scope workspaces are " +
      "inspected. Read-only (runs read-only git in known worktrees only).",
    kind: "read",
    operation: "workspace.conflicts",
    argsSchema: workspaceConflictsArgs,
    inputSchema: objectSchema(
      {
        repoPath: { type: "string" },
        base: { type: "string" },
      },
      ["repoPath"],
    ),
    handler: workspaceConflictsTool,
  }),
  define({
    name: "harness.workspace.recover",
    title: "Reconstruct workspace state + deterministic next steps",
    description:
      "Reconstruct one agent's workspace (git briefing + linked hitch " +
      "convergence) and recommend deterministic next steps (the checkpoint " +
      "narrative is advisory context only, never a driver). repoPath = a " +
      "tracked worktree path or any subpath; the agent must be in scope. " +
      "Read-only (runs read-only git in known worktrees only).",
    kind: "read",
    operation: "workspace.recover",
    argsSchema: workspaceRecoverArgs,
    inputSchema: objectSchema(
      {
        repoPath: { type: "string" },
        agent: { type: "string" },
        base: { type: "string" },
      },
      ["repoPath", "agent"],
    ),
    handler: workspaceRecoverTool,
  }),
  define({
    name: "harness.workspace.checkpoint",
    title: "Save a workspace checkpoint",
    description:
      "Record an advisory checkpoint (note + hitch link + objective) for a " +
      "tracked workspace; refreshes its heartbeat. DB-only (no git snapshot). " +
      "Requires the workspace.checkpoint operation to be allowlisted.",
    kind: "mutation",
    operation: "workspace.checkpoint",
    argsSchema: workspaceCheckpointArgs,
    inputSchema: objectSchema(
      {
        repoPath: { type: "string" },
        agent: { type: "string" },
        note: { type: "string" },
        hitchId: { type: "string" },
        objective: { type: "string" },
        idempotencyKey: idempotencyJson,
        actorNote: { type: "string" },
      },
      ["repoPath", "agent", "idempotencyKey"],
    ),
    handler: workspaceCheckpointTool,
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
