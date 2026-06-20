// mutation-tools 公開 MCP tool（review/cleanup/pr/db-apply 系）。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";

import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, permissionDenied } from "../schemas/outputs.js";

import type { McpToolContext } from "../registry/tool-registry.js";

import { cleanupDryRunTool, dbGcBlobsPreviewTool, dbMigrateBlobsPreviewTool, prPreviewTool } from "./dry-run-tools.js";

import { processReviewDecision } from "../../core/review-processor.js";

import { importReviewProposalToHitch, selectProcessedProposalForReviewImport } from "../../hitch/review-integration.js";
import { HitchRepository } from "../../hitch/repository.js";

import { cleanupRun } from "../../core/cleanup.js";
import { createPullRequest } from "../../core/pr-creator.js";
import { createGhPrPublisher } from "../../core/gh-pr-publisher.js";

import { runRepair } from "../../db/repair.js";
import { backupDb } from "../../db/maintenance.js";
import { recordArchive } from "../../db/archive-catalog.js";

import { gcExternalBlobs } from "../../storage/blob-migration.js";

import type { DbArchiveApplyArgs, DbGcBlobsApplyArgs, DbMigrateBlobsApplyArgs, DbRepairApplyArgs, ReviewProcessArgs, RunArgs } from "./mutation-types.js";
import { confirmationResult, confirmedPreviewCandidates, createArchiveId, dbArchiveApplyPreview, dbRepairFindingPreview, previewCandidateStringList, previewCandidateStrings, resolveArchiveOutPath, runMcpOperation, staleArchiveConfirmation } from "./mutation-helpers-high.js";
import { bindReviewProcessArgs, defaultLocalStoreId, fileSha256, flipSelectedArtifactsToExternal, isConfirmed, loadDoctorFinding, localStoreFromDb, migrateExternalBlobsToDb, migrateSelectedBlobsToExternal, operationMetadata, prBaseBranchForConfirmedCreate, reviewProcessPreview } from "./mutation-helpers-low.js";

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
      const proposal = selectProcessedProposalForReviewImport({
        db,
        runId: args.runId,
      });
      if (proposal === null) {
        throw new Error(`no processed review proposal found for ${args.runId} after processing`);
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

