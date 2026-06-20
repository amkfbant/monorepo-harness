// mutation-tools 公開 MCP tool（run/orchestrate/backlog/knowledge 系）。

import { existsSync } from "node:fs";

import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";

import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, permissionDenied } from "../schemas/outputs.js";

import type { McpToolContext } from "../registry/tool-registry.js";
import { ensureProjectVisible } from "./tool-helpers.js";

import { prepareProjectRun } from "../../project/run-project.js";
import { RunFinalizedError, runDomainCoding } from "../../core/workflow-runner.js";
import { createCodexCliRunner } from "../../codex/codex-cli-runner.js";
import { codexBinaryVersion } from "../../codex/codex-version.js";
import { runReviewerAgent } from "../../core/reviewer-agent.js";
import { prepareRerunFromReview } from "../../core/rerun.js";
import { addBacklogItem, resolveBacklogItemForRun } from "../../core/backlog-db.js";

import { promoteKnowledgeDbFirst, rejectKnowledgeDbFirst } from "../../core/knowledge-db.js";
import { recordOperationalKnowledge, deprecateOperationalKnowledge, getOperationalKnowledge, operationalEntryIdForKey, OperationalKnowledgeError } from "../../core/operational-knowledge.js";

import { latestHitchAttemptForRun, recordHitchAttemptForOperationResult } from "../../hitch/operation-integration.js";

import { HitchRepository } from "../../hitch/repository.js";
import { HitchOrchestrator } from "../../hitch/orchestrator.js";
import { createOrchestratorRunners } from "../../hitch/orchestrator-runners.js";

import type { BacklogCreateArgs, BacklogRunArgs, BacklogUpdateArgs, KnowledgeDecisionArgs, OpsKnowledgeDeprecateArgs, OpsKnowledgeRecordArgs, OrchestrateHitchArgs, ReviewAutoArgs, RunArgs, RunStartArgs } from "./mutation-types.js";
import { defaultMcpReviewerId } from "./mutation-types.js";
import { runMcpOperation } from "./mutation-helpers-high.js";
import { assertHitchRepoMatches, backlogContext, knowledgeContext, operationMetadata, parseCandidateId, updateBacklogItem, validateHitchLinkForProject, validateHitchLinkForRun } from "./mutation-helpers-low.js";

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
      const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
      let result: Awaited<ReturnType<typeof runDomainCoding>>;
      try {
        result = await runDomainCoding({
          harnessRoot: context.harnessRoot,
          repoPath: prepared.repoPath,
          repoId: prepared.repoId,
          domain: prepared.domain,
          goal: args.goal,
          baseBranch: prepared.baseBranch,
          codexRunner: createCodexCliRunner({ codexBin }),
          codexBinaryVersion: codexBinaryVersion(codexBin),
          compiledPolicy: prepared.compiledPolicy,
          reviewRuleResolution: prepared.reviewRuleResolution,
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
      const reviewer = args.reviewer ?? defaultMcpReviewerId(context.clientName);
      const result = await runReviewerAgent({
        runsDir: harnessPaths(context.harnessRoot).runsDir,
        runId: args.runId,
        dbPath: harnessPaths(context.harnessRoot).dbPath,
        reviewerName: reviewer,
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
            reviewer,
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
      const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
      const resolvedCodexBinaryVersion = codexBinaryVersion(codexBin);
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
            codexRunner: createCodexCliRunner({ codexBin }),
            codexBinaryVersion: resolvedCodexBinaryVersion,
            parentRunId: prep.parentRunId,
            rootRunId: prep.rootRunId,
            rerunAttempt: prep.rerunAttempt,
            compiledPolicy: prepared.compiledPolicy,
            reviewRuleResolution: prepared.reviewRuleResolution,
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
            codexRunner: createCodexCliRunner({ codexBin }),
            codexBinaryVersion: resolvedCodexBinaryVersion,
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
          coderCodexBinaryVersion: codexBinaryVersion(codexBin),
          reviewerRunner: createCodexCliRunner({ codexBin, sandbox: "read-only" }),
          // NO publisher: the MCP driver never opens a PR. stopAtCloseReady below
          // halts at close_ready; opening the PR / closing the hitch stays a
          // deliberate, separately-confirmed step.
          repoPath: prepared.repoPath,
          baseBranch: prepared.baseBranch,
          projectRuntime: {
            compiledPolicy: prepared.compiledPolicy,
            reviewRuleResolution: prepared.reviewRuleResolution,
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
