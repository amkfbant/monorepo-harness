import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";
import { runOperation, OperationInFlightError, OperationReplayedFailureError } from "../../operations/operation-runner.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, permissionDenied } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { ensureProjectVisible, withReadonlyDb, parseJson } from "./tool-helpers.js";
import {
  cleanupDryRunTool,
  dbArchivePreviewTool,
  dbGcBlobsPreviewTool,
  dbMigrateBlobsPreviewTool,
  projectIdsForDoctorFinding,
  prPreviewTool,
} from "./dry-run-tools.js";
import { createMcpConfirmationRequest, getMcpConfirmationRequest } from "../security/confirmation.js";
import { assertMutationBudget, McpMutationBudgetExceededError } from "../security/limits.js";
import { prepareProjectRun } from "../../project/run-project.js";
import { RunFinalizedError, runDomainCoding } from "../../core/workflow-runner.js";
import { createCodexCliRunner } from "../../codex/codex-cli-runner.js";
import { runReviewerAgent } from "../../core/reviewer-agent.js";
import { prepareRerunFromReview } from "../../core/rerun.js";
import { addBacklogItem, resolveBacklogItemForRun, type BacklogDbContext } from "../../core/backlog-db.js";
import { BacklogRepository } from "../../db/repositories/backlog.js";
import { ReviewProposalRepository, type ReviewProposalRow } from "../../db/repositories/review-proposals.js";
import { exportBacklogItem } from "../../db/export-files.js";
import { promoteKnowledgeDbFirst, rejectKnowledgeDbFirst } from "../../core/knowledge-db.js";
import {
  recordOperationalKnowledge,
  deprecateOperationalKnowledge,
  getOperationalKnowledge,
  operationalEntryIdForKey,
  OperationalKnowledgeError,
} from "../../core/operational-knowledge.js";
import { processReviewDecision } from "../../core/review-processor.js";
import {
  latestHitchAttemptForRun,
  recordHitchAttemptForOperationResult,
} from "../../hitch/operation-integration.js";
import { importReviewProposalToHitch } from "../../hitch/review-integration.js";
import { HitchRepository } from "../../hitch/repository.js";
import { HitchOrchestrator } from "../../hitch/orchestrator.js";
import { createOrchestratorRunners } from "../../hitch/orchestrator-runners.js";
import {
  assertHitchCanStartMutation,
  evaluateHitchMutationGate,
  HitchMutationGateError,
  type HitchLinkedMutationKind,
} from "../../hitch/mutation-gate.js";
import { syncHitchStatusForConvergence } from "../../hitch/convergence-status.js";
import { cleanupRun } from "../../core/cleanup.js";
import { createPullRequest } from "../../core/pr-creator.js";
import { createGhPrPublisher } from "../../core/gh-pr-publisher.js";
import type { DoctorFinding } from "../../db/doctor.js";
import { findRepairFor, runRepair } from "../../db/repair.js";
import { backupDb } from "../../db/maintenance.js";
import { recordArchive } from "../../db/archive-catalog.js";
import { findBlobStore, listBlobStores, recordExternalBlob } from "../../db/blob-stores.js";
import { LocalBlobStore } from "../../storage/local-blob-store.js";
import { gcExternalBlobs } from "../../storage/blob-migration.js";
import { readArtifactBlob, storeArtifactBlob } from "../../db/artifact-blobs.js";

interface MutationBaseArgs {
  idempotencyKey: string;
  actorNote?: string;
}

interface RunStartArgs extends MutationBaseArgs {
  projectId: string;
  domain: string;
  goal: string;
  contextPack?: string;
  hitchId?: string;
}

interface RunArgs extends MutationBaseArgs {
  runId: string;
  hitchId?: string;
}

interface OrchestrateHitchArgs extends MutationBaseArgs {
  hitchId: string;
  maxSteps?: number;
}

interface ReviewAutoArgs extends RunArgs {
  reviewer?: string;
}

interface BacklogCreateArgs extends MutationBaseArgs {
  projectId?: string;
  repoId?: string;
  domain: string;
  title: string;
  goal: string;
  priority?: "high" | "medium" | "low";
  tags?: string[];
}

interface BacklogRunArgs extends MutationBaseArgs {
  itemId: string;
  workflow?: "run" | "reviewed-run";
}

interface BacklogUpdateArgs extends MutationBaseArgs {
  itemId: string;
  status?: "open" | "doing" | "done" | "deferred";
  title?: string;
  goal?: string;
}

interface KnowledgeDecisionArgs extends MutationBaseArgs {
  candidateId: string;
  reason?: string;
}

interface OpsKnowledgeRecordArgs extends MutationBaseArgs {
  title: string;
  body: string;
  key: string;
  kind?: string;
  tags?: string[];
  projectId?: string;
  repoId?: string;
  domain?: string;
  reason?: string;
}

interface OpsKnowledgeDeprecateArgs extends MutationBaseArgs {
  entryId: string;
  reason?: string;
}

interface ReviewProcessArgs extends RunArgs {
  decision: "approved" | "changes_requested" | "rejected";
  proposalId?: number;
  sourceSha256?: string;
}

interface DbRepairApplyArgs extends MutationBaseArgs {
  findingId: number;
}

interface DbArchiveApplyArgs extends MutationBaseArgs {
  before: string;
  out?: string;
  archiveId?: string;
}

interface DbMigrateBlobsApplyArgs extends MutationBaseArgs {
  to: "external" | "db";
  storeId?: string;
  limit?: number;
}

interface DbGcBlobsApplyArgs extends MutationBaseArgs {
  storeId?: string;
  deleteObjects?: boolean;
}

export async function runStartTool(
  args: RunStartArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const visible = ensureProjectVisible(context.config, args.projectId);
  if (visible !== null) return visible;
  const hitchVisible = validateHitchLinkForProject(
    context,
    args.hitchId,
    args.projectId,
    args.domain,
  );
  if (hitchVisible !== null) return hitchVisible;
  return runMcpOperation(context, {
    operationType: "run.start",
    target: { type: "project_domain", id: `${args.projectId}:${args.domain}` },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.run.start", args),
    hitchGate: {
      hitchId: args.hitchId,
      mutationKind: "run.start",
    },
    workWithDb: async (db, operationId) => {
      const prepared = await prepareProjectRun({
        harnessRoot: context.harnessRoot,
        projectId: args.projectId,
        domain: args.domain,
      });
      if (args.hitchId !== undefined) {
        assertHitchRepoMatches(db, args.hitchId, prepared.repoId);
      }
      let result: Awaited<ReturnType<typeof runDomainCoding>>;
      try {
        result = await runDomainCoding({
          harnessRoot: context.harnessRoot,
          repoPath: prepared.repoPath,
          repoId: prepared.repoId,
          domain: prepared.domain,
          goal: args.goal,
          baseBranch: prepared.baseBranch,
          codexRunner: createCodexCliRunner({ codexBin: process.env.HARNESS_CODEX_BIN ?? "codex" }),
          compiledPolicy: prepared.compiledPolicy,
          project: prepared.project,
          ...(prepared.projectContextPacks !== undefined
            ? { projectContextPacks: prepared.projectContextPacks }
            : {}),
        });
      } catch (e) {
        if (args.hitchId !== undefined && e instanceof RunFinalizedError) {
          recordHitchAttemptForOperationResult(db, {
            hitchId: args.hitchId,
            attemptType: "implement",
            operationId,
            runId: e.runId,
            runStatus: e.status,
            errorMessage: e.message,
            input: {
              toolName: "harness.run.start",
              projectId: args.projectId,
              domain: args.domain,
            },
            result: { runId: e.runId, status: e.status },
          });
        }
        throw e;
      }
      if (args.hitchId !== undefined) {
        const attempt = recordHitchAttemptForOperationResult(db, {
          hitchId: args.hitchId,
          attemptType: "implement",
          operationId,
          runId: result.runId,
          runStatus: result.status,
          input: {
            toolName: "harness.run.start",
            projectId: args.projectId,
            domain: args.domain,
          },
          result: { ...result, projectId: args.projectId },
        });
        return { ...result, projectId: args.projectId, hitchAttempt: attempt };
      }
      return { ...result, projectId: args.projectId };
    },
  });
}

export async function reviewAutoTool(
  args: ReviewAutoArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const hitchVisible = validateHitchLinkForRun(context, args.hitchId, args.runId);
  if (hitchVisible !== null) return hitchVisible;
  return runMcpOperation(context, {
    operationType: "review.auto",
    target: { type: "run", id: args.runId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.review.auto", args),
    hitchGate: {
      hitchId: args.hitchId,
      mutationKind: "review.auto",
    },
    workWithDb: async (db, operationId) => {
      const result = await runReviewerAgent({
        runsDir: harnessPaths(context.harnessRoot).runsDir,
        runId: args.runId,
        dbPath: harnessPaths(context.harnessRoot).dbPath,
        reviewerName: args.reviewer ?? `mcp:${context.clientName}`,
        codexRunner: createCodexCliRunner({
          codexBin: process.env.HARNESS_CODEX_BIN ?? "codex",
          sandbox: "read-only",
        }),
      });
      if (args.hitchId !== undefined) {
        const relatedAttempt = latestHitchAttemptForRun(db, args.hitchId, args.runId);
        const attempt = recordHitchAttemptForOperationResult(db, {
          hitchId: args.hitchId,
          attemptType: "fix-review",
          operationId,
          runId: args.runId,
          ...(relatedAttempt !== null
            ? {
                iteration: relatedAttempt.iteration,
                parentAttemptId: relatedAttempt.attemptId,
              }
            : {}),
          runStatus: result.decision,
          input: {
            toolName: "harness.review.auto",
            reviewer: args.reviewer ?? `mcp:${context.clientName}`,
          },
          result: { ...result },
        });
        return { ...result, hitchAttempt: attempt };
      }
      return result;
    },
  });
}

export async function rerunStartTool(
  args: RunArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const paths = harnessPaths(context.harnessRoot);
  const hitchVisible = validateHitchLinkForRun(context, args.hitchId, args.runId);
  if (hitchVisible !== null) return hitchVisible;
  return runMcpOperation(context, {
    operationType: "rerun.start",
    target: { type: "run", id: args.runId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.rerun.start", args),
    hitchGate: {
      hitchId: args.hitchId,
      mutationKind: "rerun.start",
    },
    workWithDb: async (db, operationId) => {
      const prep = await prepareRerunFromReview({
        runsDir: paths.runsDir,
        parentRunId: args.runId,
        dbPath: paths.dbPath,
      });
      let result: Awaited<ReturnType<typeof runDomainCoding>>;
      if (prep.projectId !== undefined) {
        const prepared = await prepareProjectRun({
          harnessRoot: context.harnessRoot,
          projectId: prep.projectId,
          domain: prep.domain,
          repoOverride: prep.repoPath,
        });
        if (prepared.repoId !== prep.repoId) {
          throw new Error(
            `rerun repo attribution drift: parent ${prep.parentRunId} recorded repoId ` +
              `${JSON.stringify(prep.repoId)} but project ${JSON.stringify(prep.projectId)} ` +
              `now resolves to ${JSON.stringify(prepared.repoId)}`,
          );
        }
        if (args.hitchId !== undefined) {
          assertHitchRepoMatches(db, args.hitchId, prepared.repoId);
        }
        try {
          result = await runDomainCoding({
            harnessRoot: context.harnessRoot,
            repoPath: prepared.repoPath,
            repoId: prepared.repoId,
            domain: prepared.domain,
            goal: prep.goal,
            baseBranch: prepared.baseBranch,
            codexRunner: createCodexCliRunner({ codexBin: process.env.HARNESS_CODEX_BIN ?? "codex" }),
            parentRunId: prep.parentRunId,
            rootRunId: prep.rootRunId,
            rerunAttempt: prep.rerunAttempt,
            compiledPolicy: prepared.compiledPolicy,
            project: prepared.project,
            ...(prepared.projectContextPacks !== undefined
              ? { projectContextPacks: prepared.projectContextPacks }
              : {}),
          });
        } catch (e) {
          if (args.hitchId !== undefined && e instanceof RunFinalizedError) {
            const parentAttempt = latestHitchAttemptForRun(db, args.hitchId, args.runId);
            recordHitchAttemptForOperationResult(db, {
              hitchId: args.hitchId,
              attemptType: "rerun",
              operationId,
              runId: e.runId,
              runStatus: e.status,
              errorMessage: e.message,
              ...(parentAttempt !== null ? { parentAttemptId: parentAttempt.attemptId } : {}),
              input: {
                toolName: "harness.rerun.start",
                parentRunId: args.runId,
                rootRunId: prep.rootRunId,
                rerunAttempt: prep.rerunAttempt,
              },
              result: { runId: e.runId, status: e.status },
            });
          }
          throw e;
        }
      } else {
        try {
          result = await runDomainCoding({
            harnessRoot: context.harnessRoot,
            repoPath: prep.repoPath,
            repoId: prep.repoId,
            domain: prep.domain,
            goal: prep.goal,
            baseBranch: prep.baseBranch,
            codexRunner: createCodexCliRunner({ codexBin: process.env.HARNESS_CODEX_BIN ?? "codex" }),
            parentRunId: prep.parentRunId,
            rootRunId: prep.rootRunId,
            rerunAttempt: prep.rerunAttempt,
          });
        } catch (e) {
          if (args.hitchId !== undefined && e instanceof RunFinalizedError) {
            const parentAttempt = latestHitchAttemptForRun(db, args.hitchId, args.runId);
            recordHitchAttemptForOperationResult(db, {
              hitchId: args.hitchId,
              attemptType: "rerun",
              operationId,
              runId: e.runId,
              runStatus: e.status,
              errorMessage: e.message,
              ...(parentAttempt !== null ? { parentAttemptId: parentAttempt.attemptId } : {}),
              input: {
                toolName: "harness.rerun.start",
                parentRunId: args.runId,
                rootRunId: prep.rootRunId,
                rerunAttempt: prep.rerunAttempt,
              },
              result: { runId: e.runId, status: e.status },
            });
          }
          throw e;
        }
      }
      if (args.hitchId !== undefined) {
        const parentAttempt = latestHitchAttemptForRun(db, args.hitchId, args.runId);
        const attempt = recordHitchAttemptForOperationResult(db, {
          hitchId: args.hitchId,
          attemptType: "rerun",
          operationId,
          runId: result.runId,
          runStatus: result.status,
          ...(parentAttempt !== null ? { parentAttemptId: parentAttempt.attemptId } : {}),
          input: {
            toolName: "harness.rerun.start",
            parentRunId: args.runId,
            rootRunId: prep.rootRunId,
            rerunAttempt: prep.rerunAttempt,
          },
          result: { ...result },
        });
        return { ...result, hitchAttempt: attempt };
      }
      return result;
    },
  });
}

// (#83) Bounded MCP driver for the hitch convergence loop. Advances the hitch a
// capped number of orchestrator steps (coder rerun -> review -> convergence) and
// halts at close_ready WITHOUT opening a PR or closing the hitch — opening the PR
// stays a deliberate, separately-confirmed step (CLI `hitch orchestrate`).
const DEFAULT_ORCHESTRATE_STEPS = 20;
const MAX_ORCHESTRATE_STEPS = 50;

export async function orchestrateHitchTool(
  args: OrchestrateHitchArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  // Bounded: clamp to [1, MAX_ORCHESTRATE_STEPS]; a missing/invalid value falls
  // back to the default. The driver never opens a PR (stopAtCloseReady below), so
  // a large maxSteps can only burn coder/review budget, which the convergence
  // budgets already cap.
  const requested =
    typeof args.maxSteps === "number" && Number.isFinite(args.maxSteps)
      ? Math.trunc(args.maxSteps)
      : DEFAULT_ORCHESTRATE_STEPS;
  const maxSteps = Math.min(MAX_ORCHESTRATE_STEPS, Math.max(1, requested));
  const dbPath = harnessPaths(context.harnessRoot).dbPath;
  return runMcpOperation(context, {
    operationType: "hitch.orchestrate",
    target: { type: "goal", id: args.hitchId },
    idempotencyKey: args.idempotencyKey,
    input: { ...args, maxSteps },
    metadata: operationMetadata(context, "harness.hitch.orchestrate", args),
    hitchGate: { hitchId: args.hitchId, mutationKind: "hitch.orchestrate" },
    workWithDb: async (db) => {
      // Resolve the target repo SERVER-SIDE from the hitch's own project/domain —
      // never a client-supplied path (safety boundary: MCP must not accept an
      // arbitrary repo path). prepareProjectRun also compiles the policy the
      // per-run guardrails enforce.
      const session = new HitchRepository(db).requireSession(args.hitchId);
      if (session.projectId === null || session.domain === null) {
        throw new Error(
          `hitch ${args.hitchId} has no projectId/domain; harness.hitch.orchestrate ` +
            "only drives project-scoped hitches",
        );
      }
      const prepared = await prepareProjectRun({
        harnessRoot: context.harnessRoot,
        projectId: session.projectId,
        domain: session.domain,
      });
      const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
      const createdBy = `mcp:${context.clientName}`;
      const result = await new HitchOrchestrator({ dbPath }).run({
        hitchId: args.hitchId,
        runners: createOrchestratorRunners({
          dbPath,
          harnessRoot: context.harnessRoot,
          createdBy,
          coderRunner: createCodexCliRunner({ codexBin, sandbox: "workspace-write" }),
          reviewerRunner: createCodexCliRunner({ codexBin, sandbox: "read-only" }),
          // NO publisher: the MCP driver never opens a PR. stopAtCloseReady below
          // halts at close_ready; opening the PR / closing the hitch stays a
          // deliberate, separately-confirmed step.
          repoPath: prepared.repoPath,
          baseBranch: prepared.baseBranch,
          projectRuntime: {
            compiledPolicy: prepared.compiledPolicy,
            project: prepared.project,
            ...(prepared.projectContextPacks !== undefined
              ? { projectContextPacks: prepared.projectContextPacks }
              : {}),
          },
        }),
        maxSteps,
        createdBy,
        stopAtCloseReady: true,
      });
      return {
        hitchId: result.hitchId,
        outcome: result.outcome,
        finalDecision: result.finalDecision,
        stepCount: result.steps.length,
        steps: result.steps,
        ...(result.escalateReason !== undefined
          ? { escalateReason: result.escalateReason }
          : {}),
      };
    },
  });
}

export async function backlogCreateTool(
  args: BacklogCreateArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const visible = ensureProjectVisible(context.config, args.projectId);
  if (visible !== null) return visible;
  const paths = harnessPaths(context.harnessRoot);
  return runMcpOperation(context, {
    operationType: "backlog.create",
    target: { type: "backlog_domain", id: args.projectId ?? args.repoId ?? args.domain },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.backlog.create", args),
    work: async () => addBacklogItem(backlogContext(paths), args),
  });
}

export async function backlogRunTool(
  args: BacklogRunArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const paths = harnessPaths(context.harnessRoot);
  return runMcpOperation(context, {
    operationType: "backlog.run",
    target: { type: "backlog_item", id: args.itemId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.backlog.run", args),
    pendingExternalExecutor: true,
    work: async () => {
      const item = await resolveBacklogItemForRun(backlogContext(paths), args.itemId);
      return {
        accepted: true,
        executed: false,
        item,
        workflow: args.workflow ?? "run",
        note: "backlog execution is deferred to a CLI runner",
      };
    },
  });
}

export async function backlogUpdateTool(
  args: BacklogUpdateArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const paths = harnessPaths(context.harnessRoot);
  return runMcpOperation(context, {
    operationType: "backlog.update",
    target: { type: "backlog_item", id: args.itemId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.backlog.update", args),
    work: async () => updateBacklogItem(paths, args),
  });
}

export async function knowledgePromoteTool(
  args: KnowledgeDecisionArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const parsed = parseCandidateId(args.candidateId);
  if (parsed === null) return errorResult("invalid candidateId", { candidateId: args.candidateId });
  const paths = harnessPaths(context.harnessRoot);
  return runMcpOperation(context, {
    operationType: "knowledge.promote",
    target: { type: "knowledge_candidate", id: args.candidateId },
      idempotencyKey: args.idempotencyKey,
      input: args,
      metadata: operationMetadata(context, "harness.knowledge.promote", args),
      work: async () =>
        promoteKnowledgeDbFirst(knowledgeContext(paths), {
          runId: parsed.runId,
          index: parsed.index,
          reviewer: `mcp:${context.clientName}`,
        }),
    });
}

export async function knowledgeRejectTool(
  args: KnowledgeDecisionArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const parsed = parseCandidateId(args.candidateId);
  if (parsed === null) return errorResult("invalid candidateId", { candidateId: args.candidateId });
  if ((args.reason ?? "").trim() === "") {
    return errorResult("knowledge.reject requires reason", { candidateId: args.candidateId });
  }
  const paths = harnessPaths(context.harnessRoot);
  return runMcpOperation(context, {
    operationType: "knowledge.reject",
    target: { type: "knowledge_candidate", id: args.candidateId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.knowledge.reject", args),
    work: async () =>
      rejectKnowledgeDbFirst(knowledgeContext(paths), {
        runId: parsed.runId,
        index: parsed.index,
        reviewer: `mcp:${context.clientName}`,
        reason: args.reason as string,
      }),
  });
}

/**
 * Authorize an operational-knowledge WRITE for a restricted client
 * (`allowedProjects` non-empty). Operational entries are global-ish: a portable
 * (project-less) entry is injected into EVERY project's reviewer scope, so a
 * restricted client must not create/modify portable or other-project entries.
 *
 * Rules for a restricted client (no-op for unrestricted clients):
 *  - a requested project (record) must be one of the allowed projects;
 *  - the existing `ops/<key>` entry (if any) must already be scoped to an
 *    allowed, NON-portable project — so a restricted client cannot hijack /
 *    retarget a portable or other-project entry.
 */
function authorizeOpsWrite(
  context: McpToolContext,
  opts: { entryId: string; requestedProjectId?: string },
): HarnessMcpToolResult | null {
  const allowed = context.config.allowedProjects;
  if (allowed.length === 0) return null; // unrestricted: portable + any project ok
  if (
    opts.requestedProjectId !== undefined &&
    !allowed.includes(opts.requestedProjectId)
  ) {
    return permissionDenied("MCP permission denied: project_not_allowed", {
      reason: "project_not_allowed",
      projectId: opts.requestedProjectId,
    });
  }
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) return null;
  const probe = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  try {
    const existing = getOperationalKnowledge(probe.db, opts.entryId);
    if (
      existing !== null &&
      (existing.projectId === null || !allowed.includes(existing.projectId))
    ) {
      return permissionDenied("MCP permission denied: project_not_allowed", {
        reason: "project_not_allowed",
        entryId: opts.entryId,
      });
    }
  } finally {
    probe.close();
  }
  return null;
}

/**
 * Author operational knowledge over MCP (issue #57, roadmap G). A guarded
 * mutation: requires guarded-mutation mode + `ops_knowledge.record` in
 * allowedOperations, and runs through OperationRunner (idempotency / audit /
 * budget). The actor is recorded as `mcp:<clientName>`.
 */
export async function opsKnowledgeRecordTool(
  args: OpsKnowledgeRecordArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  // Resolve the canonical entry id the SAME way the core write will, so the
  // authorize/target/idempotency id cannot diverge from the written row via a
  // raw-vs-normalized key (e.g. "shared " vs "shared").
  let entryId: string;
  try {
    entryId = operationalEntryIdForKey(args.key);
  } catch (e) {
    if (e instanceof OperationalKnowledgeError) return errorResult(e.message);
    throw e;
  }
  // A restricted client must target one of its allowed projects — no portable
  // (global) writes (portable ops knowledge reaches every reviewer scope).
  if (
    context.config.allowedProjects.length > 0 &&
    args.projectId === undefined
  ) {
    return permissionDenied(
      "MCP permission denied: a project is required for operational writes by a scoped client",
      { reason: "project_required" },
    );
  }
  const denied = authorizeOpsWrite(context, {
    entryId,
    ...(args.projectId !== undefined ? { requestedProjectId: args.projectId } : {}),
  });
  if (denied !== null) return denied;
  return runMcpOperation(context, {
    operationType: "ops_knowledge.record",
    target: { type: "knowledge_entry", id: entryId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.ops_knowledge.record", args),
    workWithDb: async (db) =>
      recordOperationalKnowledge(db, {
        key: args.key,
        title: args.title,
        body: args.body,
        actor: `mcp:${context.clientName}`,
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
        ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      }),
  });
}

/** Deprecate an operational entry over MCP (issue #57, roadmap G). */
export async function opsKnowledgeDeprecateTool(
  args: OpsKnowledgeDeprecateArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  // A restricted client may only deprecate an existing entry scoped to one of
  // its allowed projects (never a portable / other-project entry).
  const denied = authorizeOpsWrite(context, { entryId: args.entryId });
  if (denied !== null) return denied;
  return runMcpOperation(context, {
    operationType: "ops_knowledge.deprecate",
    target: { type: "knowledge_entry", id: args.entryId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.ops_knowledge.deprecate", args),
    workWithDb: async (db) =>
      deprecateOperationalKnowledge(db, {
        entryId: args.entryId,
        actor: `mcp:${context.clientName}`,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      }),
  });
}

export async function reviewProcessTool(
  args: ReviewProcessArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (!isConfirmed(context)) {
    const preview = reviewProcessPreview(args, context);
    const boundArgs = bindReviewProcessArgs(args, preview);
    return confirmationResult(context, "harness.review.process", "review.process", boundArgs, preview, {
      type: "run",
      id: args.runId,
    });
  }
  const staleCheck = reviewProcessPreview(args, context);
  if (staleCheck.status === "error" || staleCheck.status === "permission_denied") {
    return staleCheck;
  }
  if (args.proposalId === undefined || args.sourceSha256 === undefined) {
    return errorResult("review.process confirmation is missing proposalId/sourceSha256 binding", {
      runId: args.runId,
    });
  }
  const paths = harnessPaths(context.harnessRoot);
  return runMcpOperation(context, {
    operationType: "review.process",
    target: { type: "run", id: args.runId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.review.process", args),
    hitchGate: {
      hitchId: args.hitchId,
      mutationKind: "review.process",
    },
    workWithDb: async (db) => {
      const result = await processReviewDecision({
        runsDir: paths.runsDir,
        locksDir: paths.locksDir,
        dbPath: paths.dbPath,
        runId: args.runId,
        proposalId: args.proposalId as number,
        sourceSha256: args.sourceSha256 as string,
      });
      if (args.hitchId === undefined) return result;
      const proposal = new ReviewProposalRepository(db).getById(
        args.proposalId as number,
      );
      if (proposal === null) {
        throw new Error(`review proposal ${String(args.proposalId)} not found after processing`);
      }
      const hitchIntegration = importReviewProposalToHitch({
        repository: new HitchRepository(db),
        hitchId: args.hitchId,
        proposal,
        processResult: result,
        createdBy: `mcp:${context.clientName}`,
      });
      return { ...result, hitchIntegration };
    },
  });
}

export async function cleanupApplyTool(
  args: RunArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (!isConfirmed(context)) {
    const preview = cleanupDryRunTool({ runId: args.runId }, context);
    return confirmationResult(context, "harness.cleanup.apply", "cleanup.apply", args, preview, {
      type: "run",
      id: args.runId,
    });
  }
  const paths = harnessPaths(context.harnessRoot);
  return runMcpOperation(context, {
    operationType: "cleanup.apply",
    target: { type: "run", id: args.runId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.cleanup.apply", args),
    work: async () =>
      cleanupRun({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        dbPath: paths.dbPath,
        runId: args.runId,
        scope: "workspace",
      }),
  });
}

export async function prCreateTool(
  args: RunArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (!isConfirmed(context)) {
    const preview = prPreviewTool({ runId: args.runId }, context);
    return confirmationResult(context, "harness.pr.create", "pr.create", args, preview, {
      type: "run",
      id: args.runId,
    });
  }
  const paths = harnessPaths(context.harnessRoot);
  const baseBranch = prBaseBranchForConfirmedCreate(args, context);
  if (typeof baseBranch !== "string") return baseBranch;
  return runMcpOperation(context, {
    operationType: "pr.create",
    target: { type: "run", id: args.runId },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.pr.create", args),
    work: async () =>
      createPullRequest({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        dbPath: paths.dbPath,
        runId: args.runId,
        base: baseBranch,
        draft: true,
        publisher: createGhPrPublisher(),
      }),
  });
}

export async function dbRepairApplyTool(
  args: DbRepairApplyArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (!isConfirmed(context)) {
    const preview = dbRepairFindingPreview(args, context);
    return confirmationResult(context, "harness.db.repair.apply", "db.repair.apply", args, preview, {
      type: "doctor_finding",
      id: String(args.findingId),
    });
  }
  return runMcpOperation(context, {
    operationType: "db.repair.apply",
    target: { type: "doctor_finding", id: String(args.findingId) },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.db.repair.apply", args),
    workWithDb: async (db) => {
      const finding = loadDoctorFinding(db, args.findingId);
      if (finding === null) throw new Error(`doctor finding ${args.findingId} not found`);
      return runRepair(db, finding, { dryRun: false, findingId: args.findingId });
    },
  });
}

export async function dbArchiveApplyTool(
  args: DbArchiveApplyArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (context.config.allowedProjects.length > 0) {
    return permissionDenied("db.archive.apply requires global MCP scope", {
      reason: "global_scope_required",
      allowedProjects: context.config.allowedProjects,
    });
  }
  if (!isConfirmed(context)) {
    const archiveId = args.archiveId ?? createArchiveId();
    const target = resolveArchiveOutPath(context, args.out, archiveId);
    if ("status" in target) return target;
    const boundArgs = { ...args, archiveId, out: target.outPath };
    const preview = dbArchiveApplyPreview(boundArgs, context, target);
    return confirmationResult(context, "harness.db.archive.apply", "db.archive.apply", boundArgs, preview, {
      type: "db",
      id: "archive",
    });
  }
  const archiveId = args.archiveId ?? createArchiveId();
  const target = resolveArchiveOutPath(context, args.out, archiveId);
  if ("status" in target) return target;
  const stale = staleArchiveConfirmation(context, target.outPath);
  if (stale !== null) return stale;
  return runMcpOperation(context, {
    operationType: "db.archive.apply",
    target: { type: "db", id: "archive" },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.db.archive.apply", args),
    work: async () => {
      const paths = harnessPaths(context.harnessRoot);
      mkdirSync(dirname(target.outPath), { recursive: true });
      const outPath = target.outPath;
      const backup = await backupDb({ dbPath: paths.dbPath, outPath });
      const handle = openManagedDb({ dbPath: paths.dbPath, lockPath: paths.dbLockPath });
      try {
        runMigrations(handle.db);
        return recordArchive(handle.db, {
          archiveId,
          path: outPath,
          rangeEnd: args.before,
          schemaVersion: backup.schemaVersion,
          sha256: fileSha256(outPath),
          metadata: {
            mode: "copy-only-full-db",
            bytes: backup.bytes,
            source: "mcp",
            beforeIsMetadataOnly: true,
          },
        });
      } finally {
        handle.close();
      }
    },
  });
}

export async function dbMigrateBlobsApplyTool(
  args: DbMigrateBlobsApplyArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (context.config.allowedProjects.length > 0) {
    return permissionDenied("db.migrate_blobs.apply requires global MCP scope", {
      reason: "global_scope_required",
      allowedProjects: context.config.allowedProjects,
    });
  }
  if (!isConfirmed(context)) {
    const preview = dbMigrateBlobsPreviewTool(
      {
        to: args.to,
        ...(args.storeId !== undefined ? { storeId: args.storeId } : {}),
        limit: args.limit ?? 50,
      },
      context,
    );
    return confirmationResult(context, "harness.db.migrate_blobs.apply", "db.migrate_blobs.apply", args, preview, {
      type: "db",
      id: "migrate_blobs",
    });
  }
  return runMcpOperation(context, {
    operationType: "db.migrate_blobs.apply",
    target: { type: "db", id: "migrate_blobs" },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.db.migrate_blobs.apply", args),
    workWithDb: async (db) => {
      const storeId = args.storeId ?? defaultLocalStoreId(db);
      const store = localStoreFromDb(db, storeId);
      const candidates = confirmedPreviewCandidates(context);
      if (args.to === "external") {
        const sha256s = previewCandidateStrings(candidates, "sha256");
        const artifactIds = previewCandidateStringList(candidates, "artifactIds");
        const result = await migrateSelectedBlobsToExternal(db, store, {
          storeId,
          sha256s,
        });
        const flippedArtifacts = flipSelectedArtifactsToExternal(db, storeId, artifactIds);
        return { ...result, flippedArtifacts };
      }
      return migrateExternalBlobsToDb(db, store, {
        storeId,
        artifactIds: previewCandidateStrings(candidates, "artifactId"),
      });
    },
  });
}

export async function dbGcBlobsApplyTool(
  args: DbGcBlobsApplyArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  if (context.config.allowedProjects.length > 0) {
    return permissionDenied("db.gc_blobs.apply requires global MCP scope", {
      reason: "global_scope_required",
      allowedProjects: context.config.allowedProjects,
    });
  }
  if (!isConfirmed(context)) {
    const preview = dbGcBlobsPreviewTool(
      {
        ...(args.storeId !== undefined ? { storeId: args.storeId } : {}),
        ...(args.deleteObjects !== undefined ? { deleteObjects: args.deleteObjects } : {}),
        limit: 100,
      },
      context,
    );
    return confirmationResult(context, "harness.db.gc_blobs.apply", "db.gc_blobs.apply", args, preview, {
      type: "db",
      id: "gc_blobs",
    });
  }
  return runMcpOperation(context, {
    operationType: "db.gc_blobs.apply",
    target: { type: "db", id: "gc_blobs" },
    idempotencyKey: args.idempotencyKey,
    input: args,
    metadata: operationMetadata(context, "harness.db.gc_blobs.apply", args),
    workWithDb: async (db) => {
      const storeId = args.storeId ?? defaultLocalStoreId(db);
      const sha256s = previewCandidateStrings(confirmedPreviewCandidates(context), "sha256");
      return gcExternalBlobs(db, localStoreFromDb(db, storeId), {
        apply: true,
        deleteObjects: args.deleteObjects === true,
        storeId,
        sha256s,
      });
    },
  });
}

interface ArchiveOutTarget {
  archiveDir: string;
  defaultOutPath: string;
  outPath: string;
  existingTarget: boolean;
}

function createArchiveId(): string {
  return `archive-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function resolveArchiveOutPath(
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

function dbArchiveApplyPreview(
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

function staleArchiveConfirmation(
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

function dbRepairFindingPreview(
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

function confirmedPreviewCandidates(context: McpToolContext): Record<string, unknown>[] {
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

function previewCandidateStrings(
  candidates: Record<string, unknown>[],
  key: string,
): string[] {
  return uniqueStrings(
    candidates
      .map((candidate) => candidate[key])
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

function previewCandidateStringList(
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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

async function runMcpOperation<T>(
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
        input: opts.input,
        metadata: opts.metadata,
        ...(opts.pendingExternalExecutor === true ? { pendingExternalExecutor: true } : {}),
        beforeStart: (db) => {
          if (opts.hitchGate?.hitchId !== undefined) {
            assertHitchCanStartMutation({
              repository: new HitchRepository(db),
              hitchId: opts.hitchGate.hitchId,
              mutationKind: opts.hitchGate.mutationKind,
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

function reviewProcessPreview(
  args: ReviewProcessArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const run = db
      .prepare("SELECT run_id, project_id, repo_id, status, domain FROM runs WHERE run_id = ?")
      .get(args.runId) as Record<string, unknown> | undefined;
    if (run === undefined) return errorResult(`run ${args.runId} not found`, { runId: args.runId });
    if (run.status !== "needs_review") {
      return errorResult(
        `run ${args.runId} status is "${String(run.status)}", only needs_review can be processed`,
        { runId: args.runId, status: run.status },
      );
    }
    if (args.hitchId !== undefined) {
      const linked = validateHitchRunLinkFromDb(
        db,
        context,
        args.hitchId,
        args.runId,
        {
          projectId: typeof run.project_id === "string" ? run.project_id : null,
          repoId: typeof run.repo_id === "string" ? run.repo_id : null,
          domain: typeof run.domain === "string" ? run.domain : null,
        },
      );
      if (linked !== null) return linked;
      const gate = evaluateHitchMutationGate({
        repository: new HitchRepository(db),
        hitchId: args.hitchId,
        mutationKind: "review.process",
        syncStatus: false,
      });
      if (!gate.allowed) {
        return permissionDenied(gate.message, {
          reason: gate.code,
          hitchId: args.hitchId,
          mutationKind: "review.process",
          convergence: gate.convergence,
        });
      }
    }
    const repo = new ReviewProposalRepository(db);
    const proposal =
      args.proposalId === undefined
        ? repo.getLatestActiveProposal(args.runId)
        : repo.getById(args.proposalId);
    if (proposal === null) {
      return errorResult(
        args.proposalId === undefined
          ? `no active review proposal found for ${args.runId}`
          : `review proposal ${args.proposalId} not found`,
        { runId: args.runId, proposalId: args.proposalId ?? null },
      );
    }
    const staleReason = staleReviewProposalReason(proposal, args);
    if (staleReason !== null) {
      return errorResult(staleReason, {
        runId: args.runId,
        proposalId: proposal.proposalId,
        sourceSha256: proposal.sourceSha256,
      });
    }
    const latestActive = repo.getLatestActiveProposal(args.runId);
    if (
      latestActive !== null &&
      latestActive.proposalId !== proposal.proposalId
    ) {
      return errorResult(
        `review proposal ${proposal.proposalId} is stale; latest active proposal is ${latestActive.proposalId}`,
        {
          runId: args.runId,
          proposalId: proposal.proposalId,
          latestProposalId: latestActive.proposalId,
        },
      );
    }
    return {
      status: "dry_run",
      summary: `would process review proposal ${proposal.proposalId} for ${args.runId}`,
      data: {
        run,
        ...(args.hitchId !== undefined ? { hitchId: args.hitchId } : {}),
        decision: args.decision,
        proposal: reviewProposalPreview(proposal),
        sourceSha256: proposal.sourceSha256,
      },
    };
  }) as HarnessMcpToolResult;
}

function staleReviewProposalReason(
  proposal: ReviewProposalRow,
  args: ReviewProcessArgs,
): string | null {
  if (proposal.runId !== args.runId) {
    return `review proposal ${proposal.proposalId} belongs to ${proposal.runId}, not ${args.runId}`;
  }
  if (proposal.supersededAt !== null) {
    return `review proposal ${proposal.proposalId} is superseded; rerun review before processing`;
  }
  if (proposal.processedAt !== null) {
    return `review proposal ${proposal.proposalId} is already processed`;
  }
  if (
    args.sourceSha256 !== undefined &&
    proposal.sourceSha256 !== args.sourceSha256
  ) {
    return `review proposal ${proposal.proposalId} sourceSha256 changed; expected ${args.sourceSha256}, got ${proposal.sourceSha256}`;
  }
  if (proposal.decision !== args.decision) {
    return `review proposal ${proposal.proposalId} decision is ${proposal.decision}, not ${args.decision}`;
  }
  return null;
}

function reviewProposalPreview(
  proposal: ReviewProposalRow,
): Record<string, unknown> {
  return {
    proposalId: proposal.proposalId,
    runId: proposal.runId,
    reviewer: proposal.reviewer,
    decision: proposal.decision,
    sourceSha256: proposal.sourceSha256,
    createdAt: proposal.createdAt,
    supersededAt: proposal.supersededAt,
    processedAt: proposal.processedAt,
  };
}

function bindReviewProcessArgs(
  args: ReviewProcessArgs,
  preview: HarnessMcpToolResult,
): ReviewProcessArgs {
  if (preview.status !== "dry_run") return args;
  const proposal = (preview.data as { proposal?: unknown } | undefined)?.proposal;
  if (typeof proposal !== "object" || proposal === null) return args;
  const row = proposal as { proposalId?: unknown; sourceSha256?: unknown };
  return {
    ...args,
    ...(typeof row.proposalId === "number" ? { proposalId: row.proposalId } : {}),
    ...(typeof row.sourceSha256 === "string" ? { sourceSha256: row.sourceSha256 } : {}),
  };
}

function validateHitchLinkForProject(
  context: McpToolContext,
  hitchId: string | undefined,
  projectId: string,
  domain?: string,
): HarnessMcpToolResult | null {
  if (hitchId === undefined) return null;
  return withReadonlyDb(context, ({ db }) => {
    const hitch = db
      .prepare("SELECT project_id, repo_id, domain FROM hitch_sessions WHERE hitch_id = ?")
      .get(hitchId) as HitchLinkRow | undefined;
    if (hitch === undefined) {
      return permissionDenied(`hitch not found: ${hitchId}`, { reason: "hitch_not_found", hitchId });
    }
    const denied = ensureProjectVisible(context.config, hitch.project_id);
    if (denied !== null) return denied;
    if (hitch.project_id !== null && hitch.project_id !== projectId) {
      return errorResult("hitch project does not match run project", {
        hitchId,
        hitchProjectId: hitch.project_id,
        runProjectId: projectId,
      });
    }
    if (domain !== undefined && hitch.domain !== null && hitch.domain !== domain) {
      return errorResult("hitch domain does not match run domain", {
        hitchId,
        hitchDomain: hitch.domain,
        runDomain: domain,
      });
    }
    return null;
  }) as HarnessMcpToolResult | null;
}

function validateHitchLinkForRun(
  context: McpToolContext,
  hitchId: string | undefined,
  runId: string,
): HarnessMcpToolResult | null {
  if (hitchId === undefined) return null;
  return withReadonlyDb(context, ({ db }) => {
    const run = db
      .prepare("SELECT project_id, repo_id, domain FROM runs WHERE run_id = ?")
      .get(runId) as RunLinkRow | undefined;
    if (run === undefined) return errorResult(`run not found: ${runId}`, { runId });
    return validateHitchRunLinkFromDb(db, context, hitchId, runId, {
      projectId: run.project_id,
      repoId: run.repo_id,
      domain: run.domain,
    });
  }) as HarnessMcpToolResult | null;
}

function validateHitchRunLinkFromDb(
  db: Database.Database,
  context: McpToolContext,
  hitchId: string,
  runId: string,
  run: { projectId: string | null; repoId: string | null; domain: string | null },
): HarnessMcpToolResult | null {
  const hitch = db
    .prepare("SELECT project_id, repo_id, domain FROM hitch_sessions WHERE hitch_id = ?")
    .get(hitchId) as HitchLinkRow | undefined;
  if (hitch === undefined) return permissionDenied(`hitch not found: ${hitchId}`, { reason: "hitch_not_found", hitchId });
  const denied = ensureProjectVisible(context.config, hitch.project_id);
  if (denied !== null) return denied;
  if (hitch.project_id !== null && run.projectId !== hitch.project_id) {
    return errorResult("hitch project does not match run project", {
      hitchId,
      runId,
      hitchProjectId: hitch.project_id,
      runProjectId: run.projectId,
    });
  }
  if (hitch.repo_id !== null && run.repoId !== hitch.repo_id) {
    return errorResult("hitch repo does not match run repo", {
      hitchId,
      runId,
      hitchRepoId: hitch.repo_id,
      runRepoId: run.repoId,
    });
  }
  if (hitch.domain !== null && run.domain !== hitch.domain) {
    return errorResult("hitch domain does not match run domain", {
      hitchId,
      runId,
      hitchDomain: hitch.domain,
      runDomain: run.domain,
    });
  }
  return null;
}

interface HitchLinkRow {
  project_id: string | null;
  repo_id: string | null;
  domain: string | null;
}

interface RunLinkRow {
  project_id: string | null;
  repo_id: string | null;
  domain: string | null;
}

function assertHitchRepoMatches(
  db: Database.Database,
  hitchId: string,
  repoId: string,
): void {
  const hitch = db
    .prepare("SELECT repo_id FROM hitch_sessions WHERE hitch_id = ?")
    .get(hitchId) as { repo_id: string | null } | undefined;
  if (hitch !== undefined && hitch.repo_id !== null && hitch.repo_id !== repoId) {
    throw new Error(
      `hitch repo does not match run repo: hitch=${hitchId} hitchRepo=${hitch.repo_id} runRepo=${repoId}`,
    );
  }
}

function prBaseBranchForConfirmedCreate(
  args: RunArgs,
  context: McpToolContext,
): string | HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare("SELECT run_id, project_id, base_branch FROM runs WHERE run_id = ?")
      .get(args.runId) as
      | { run_id: string; project_id: string | null; base_branch: string }
      | undefined;
    if (row === undefined) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, row.project_id);
    if (denied !== null) return denied;

    const confirmationId = context.confirmedConfirmationId;
    if (confirmationId !== undefined) {
      const confirmation = getMcpConfirmationRequest(context.harnessRoot, confirmationId);
      const preview = confirmation === null
        ? {}
        : parseJson<Record<string, unknown>>(confirmation.previewJson, {});
      const planned = (preview.data as { plannedPullRequest?: unknown } | undefined)
        ?.plannedPullRequest;
      if (typeof planned === "object" && planned !== null) {
        const expected = (planned as { baseBranch?: unknown }).baseBranch;
        if (typeof expected === "string" && expected !== row.base_branch) {
          return errorResult("pr.create confirmation is stale: base branch changed", {
            runId: args.runId,
            expectedBaseBranch: expected,
            currentBaseBranch: row.base_branch,
          });
        }
      }
    }
    return row.base_branch;
  }) as string | HarnessMcpToolResult;
}

function isConfirmed(context: McpToolContext): boolean {
  return context.confirmedConfirmationId !== undefined;
}

function operationMetadata(
  context: McpToolContext,
  toolName: string,
  args: MutationBaseArgs,
): Record<string, unknown> {
  const hitchId =
    typeof (args as unknown as { hitchId?: unknown }).hitchId === "string"
      ? (args as unknown as { hitchId: string }).hitchId
      : undefined;
  return {
    source: "mcp",
    clientName: context.clientName,
    sessionId: context.sessionId,
    toolName,
    idempotencyKey: args.idempotencyKey,
    ...(hitchId !== undefined ? { hitchId, hitch_id: hitchId } : {}),
    ...(args.actorNote !== undefined ? { actorNote: args.actorNote } : {}),
    ...(context.confirmedConfirmationId !== undefined
      ? { confirmationId: context.confirmedConfirmationId }
      : {}),
  };
}

function backlogContext(paths: ReturnType<typeof harnessPaths>): BacklogDbContext {
  return {
    backlogDir: paths.backlogDir,
    dbPath: paths.dbPath,
  };
}

function knowledgeContext(paths: ReturnType<typeof harnessPaths>) {
  return {
    runsDir: paths.runsDir,
    knowledgeDir: join(paths.root, "docs", "knowledge"),
    dbPath: paths.dbPath,
  };
}

function updateBacklogItem(
  paths: ReturnType<typeof harnessPaths>,
  args: BacklogUpdateArgs,
): Record<string, unknown> {
  const handle = openManagedDb({ dbPath: paths.dbPath, lockPath: paths.dbLockPath });
  try {
    runMigrations(handle.db);
    const repo = new BacklogRepository(handle.db);
    const existing = repo.getItem(args.itemId);
    if (existing === null) throw new Error(`backlog item ${args.itemId} not found`);
    if (existing.sourceMode !== "db-first") {
      throw new Error(`backlog item ${args.itemId} is ${existing.sourceMode}, expected db-first`);
    }
    const updates: string[] = [];
    const params: unknown[] = [];
    if (args.status !== undefined) {
      updates.push("status = ?");
      params.push(args.status);
    }
    if (args.title !== undefined) {
      updates.push("title = ?");
      params.push(args.title);
    }
    if (args.goal !== undefined) {
      updates.push("goal = ?");
      params.push(args.goal);
    }
    if (updates.length > 0) {
      updates.push("updated_at = ?");
      params.push(new Date().toISOString());
      updates.push("db_revision = db_revision + 1");
      updates.push("export_status = 'dirty'");
      updates.push("last_export_error = NULL");
      params.push(args.itemId);
      handle.db
        .prepare(`UPDATE backlog_items SET ${updates.join(", ")} WHERE item_id = ?`)
        .run(...params);
      exportBacklogItem(handle.db, args.itemId, { backlogDir: paths.backlogDir });
    }
    return { item: repo.getItem(args.itemId), changed: updates.length > 0 };
  } finally {
    handle.close();
  }
}

function parseCandidateId(candidateId: string): { runId: string; index: number } | null {
  const idx = candidateId.lastIndexOf(":");
  if (idx <= 0) return null;
  const runId = candidateId.slice(0, idx);
  const index = Number(candidateId.slice(idx + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { runId, index };
}

function loadDoctorFinding(db: Database.Database, findingId: number): DoctorFinding | null {
  const r = db
    .prepare(
      `SELECT finding_id, doctor_run_id, check_id, severity, status, message,
              repairable, details_json
         FROM doctor_findings WHERE finding_id = ?`,
    )
    .get(findingId) as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    checkId: r.check_id as string,
    severity: r.severity as DoctorFinding["severity"],
    status: r.status as DoctorFinding["status"],
    message: r.message as string,
    repairable: Boolean(r.repairable),
    details: parseJson(r.details_json as string, {}),
  };
}

function defaultLocalStoreId(db: Database.Database): string {
  const row = listBlobStores(db).find(
    (s) => s.storeType === "local" && s.status === "active",
  );
  if (row === undefined) {
    throw new Error("no active local blob store");
  }
  return row.storeId;
}

function localStoreFromDb(db: Database.Database, storeId: string): LocalBlobStore {
  const row = findBlobStore(db, storeId);
  if (row === null) throw new Error(`unknown blob store ${storeId}`);
  if (row.storeType !== "local") {
    throw new Error(`blob store ${storeId} is ${row.storeType}, expected local`);
  }
  const config = JSON.parse(row.configJson) as { root?: unknown };
  if (typeof config.root !== "string") {
    throw new Error(`blob store ${storeId} has no local root`);
  }
  return new LocalBlobStore({ root: config.root });
}

async function migrateSelectedBlobsToExternal(
  db: Database.Database,
  store: LocalBlobStore,
  opts: { storeId: string; sha256s: string[] },
): Promise<{
  jobId: string;
  direction: "db-to-external";
  storeId: string;
  candidatesCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  details: Array<{ sha256: string; status: "uploaded" | "skipped" | "failed"; error?: string }>;
}> {
  const selected = uniqueStrings(opts.sha256s);
  const jobId = `migr-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const details: Array<{ sha256: string; status: "uploaded" | "skipped" | "failed"; error?: string }> = [];
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const candidates =
    selected.length === 0
      ? []
      : (db
          .prepare(
            `SELECT sha256
               FROM artifact_blobs
              WHERE sha256 IN (${selected.map(() => "?").join(", ")})
                AND NOT EXISTS (
                  SELECT 1 FROM external_artifact_blobs e
                   WHERE e.sha256 = artifact_blobs.sha256
                )
              ORDER BY sha256 ASC`,
          )
          .all(...selected) as { sha256: string }[]);
  const candidateSet = new Set(candidates.map((c) => c.sha256));
  for (const sha of selected) {
    if (!candidateSet.has(sha)) {
      skipped++;
      details.push({ sha256: sha, status: "skipped" });
      continue;
    }
    try {
      const body = readArtifactBlob(db, sha);
      if (body === null) {
        failed++;
        details.push({ sha256: sha, status: "failed", error: "DB blob read returned null" });
        continue;
      }
      const put = await store.put({
        sha256: sha,
        body,
        contentEncoding: "identity",
      });
      const head = await store.head({ sha256: sha, uri: put.uri });
      if (head === null || head.sizeBytes !== put.storedBytes) {
        failed++;
        details.push({ sha256: sha, status: "failed", error: "head verify mismatch" });
        continue;
      }
      recordExternalBlob(db, {
        sha256: sha,
        storeId: opts.storeId,
        uri: put.uri,
        bytes: body.length,
        storedBytes: put.storedBytes,
        contentEncoding: "identity",
      });
      uploaded++;
      details.push({ sha256: sha, status: "uploaded" });
    } catch (e) {
      failed++;
      details.push({ sha256: sha, status: "failed", error: (e as Error).message });
    }
  }
  const completedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO blob_migration_jobs
       (job_id, direction, store_id, status, started_at, completed_at,
        input_json, result_json)
     VALUES (?, 'db-to-external', ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    opts.storeId,
    failed === 0 ? (uploaded > 0 ? "succeeded" : "skipped") : "partial",
    startedAt,
    completedAt,
    JSON.stringify({ selectedSha256s: selected }),
    JSON.stringify({ candidates: selected.length, uploaded, skipped, failed }),
  );
  return {
    jobId,
    direction: "db-to-external",
    storeId: opts.storeId,
    candidatesCount: selected.length,
    uploadedCount: uploaded,
    skippedCount: skipped,
    failedCount: failed,
    details,
  };
}

function flipSelectedArtifactsToExternal(
  db: Database.Database,
  storeId: string,
  artifactIds: string[],
): number {
  const selected = uniqueStrings(artifactIds);
  if (selected.length === 0) return 0;
  return db
    .prepare(
      `UPDATE artifacts
          SET storage = 'external',
              body_status = 'external_available'
        WHERE artifact_id IN (${selected.map(() => "?").join(", ")})
          AND storage = 'db'
          AND blob_sha256 IN (
            SELECT sha256 FROM external_artifact_blobs
            WHERE store_id = ? AND status = 'available'
          )`,
    )
    .run(...selected, storeId).changes;
}

async function migrateExternalBlobsToDb(
  db: Database.Database,
  store: LocalBlobStore,
  opts: { storeId: string; artifactIds: string[] },
): Promise<{ storeId: string; restored: number; failed: number; details: unknown[] }> {
  const selected = uniqueStrings(opts.artifactIds);
  const rows =
    selected.length === 0
      ? []
      : (db
          .prepare(
            `SELECT a.artifact_id, a.blob_sha256, e.uri
               FROM artifacts a
               INNER JOIN external_artifact_blobs e ON e.sha256 = a.blob_sha256
              WHERE a.artifact_id IN (${selected.map(() => "?").join(", ")})
                AND a.storage = 'external'
                AND e.store_id = ?
                AND e.status = 'available'
                AND a.blob_sha256 IS NOT NULL`,
          )
          .all(...selected, opts.storeId) as { artifact_id: string; blob_sha256: string; uri: string }[]);
  let restored = 0;
  let failed = 0;
  const details: unknown[] = [];
  for (const row of rows) {
    try {
      const body = await store.get({ sha256: row.blob_sha256, uri: row.uri });
      const actualSha = createHash("sha256").update(body).digest("hex");
      if (actualSha !== row.blob_sha256) {
        throw new Error(`external blob content mismatch: expected ${row.blob_sha256}, got ${actualSha}`);
      }
      storeArtifactBlob(db, body);
      db.prepare(
        `UPDATE artifacts
            SET storage = 'db', body_status = 'db_available'
          WHERE artifact_id = ?`,
      ).run(row.artifact_id);
      restored++;
      details.push({ artifactId: row.artifact_id, status: "restored" });
    } catch (e) {
      failed++;
      details.push({
        artifactId: row.artifact_id,
        status: "failed",
        error: (e as Error).message,
      });
    }
  }
  return { storeId: opts.storeId, restored, failed, details };
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function operationSummary(operation: {
  operationId: string;
  operationType: string | null;
  targetType: string | null;
  targetId: string | null;
  status: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    operationType: operation.operationType,
    targetType: operation.targetType,
    targetId: operation.targetId,
    status: operation.status,
    createdAt: operation.createdAt,
  };
}
