// mutation-tools の検証/context/blob-migration helper 層（leaf-ward）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";

import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, permissionDenied } from "../schemas/outputs.js";

import type { McpToolContext } from "../registry/tool-registry.js";
import { ensureProjectVisible, withReadonlyDb, parseJson } from "./tool-helpers.js";

import { getMcpConfirmationRequest } from "../security/confirmation.js";

import type { BacklogDbContext } from "../../core/backlog-db.js";
import { BacklogRepository } from "../../db/repositories/backlog.js";
import { ReviewProposalRepository, type ReviewProposalRow } from "../../db/repositories/review-proposals.js";
import { exportBacklogItem } from "../../db/export-files.js";

import { HitchRepository } from "../../hitch/repository.js";

import { evaluateHitchMutationGate } from "../../hitch/mutation-gate.js";

import type { DoctorFinding } from "../../db/doctor.js";

import { findBlobStore, listBlobStores, recordExternalBlob } from "../../db/blob-stores.js";
import { LocalBlobStore } from "../../storage/local-blob-store.js";

import { readArtifactBlob, storeArtifactBlob } from "../../db/artifact-blobs.js";
import type { BacklogUpdateArgs, MutationBaseArgs, ReviewProcessArgs, RunArgs } from "./mutation-types.js";
import { uniqueStrings } from "./mutation-types.js";

export function reviewProcessPreview(
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
        syncCreatedBy: `mcp:${context.clientName}`,
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

export function staleReviewProposalReason(
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

export function reviewProposalPreview(
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

export function bindReviewProcessArgs(
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

export function validateHitchLinkForProject(
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

export function validateHitchLinkForRun(
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

export function validateHitchRunLinkFromDb(
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

export interface HitchLinkRow {
  project_id: string | null;
  repo_id: string | null;
  domain: string | null;
}

export interface RunLinkRow {
  project_id: string | null;
  repo_id: string | null;
  domain: string | null;
}

export function assertHitchRepoMatches(
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

export function prBaseBranchForConfirmedCreate(
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

export function isConfirmed(context: McpToolContext): boolean {
  return context.confirmedConfirmationId !== undefined;
}

export function operationMetadata(
  context: McpToolContext,
  toolName: string,
  args: MutationBaseArgs,
): Record<string, unknown> {
  const hitchId = hasStringHitchId(args) ? args.hitchId : undefined;
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

export function hasStringHitchId(value: unknown): value is { hitchId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { hitchId?: unknown }).hitchId === "string"
  );
}

export function backlogContext(paths: ReturnType<typeof harnessPaths>): BacklogDbContext {
  return {
    backlogDir: paths.backlogDir,
    dbPath: paths.dbPath,
  };
}

export function knowledgeContext(paths: ReturnType<typeof harnessPaths>) {
  return {
    runsDir: paths.runsDir,
    knowledgeDir: join(paths.root, "docs", "knowledge"),
    dbPath: paths.dbPath,
  };
}

export function updateBacklogItem(
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

export function parseCandidateId(candidateId: string): { runId: string; index: number } | null {
  const idx = candidateId.lastIndexOf(":");
  if (idx <= 0) return null;
  const runId = candidateId.slice(0, idx);
  const index = Number(candidateId.slice(idx + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { runId, index };
}

export function loadDoctorFinding(db: Database.Database, findingId: number): DoctorFinding | null {
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

export function defaultLocalStoreId(db: Database.Database): string {
  const row = listBlobStores(db).find(
    (s) => s.storeType === "local" && s.status === "active",
  );
  if (row === undefined) {
    throw new Error("no active local blob store");
  }
  return row.storeId;
}

export function localStoreFromDb(db: Database.Database, storeId: string): LocalBlobStore {
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

export async function migrateSelectedBlobsToExternal(
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

export function flipSelectedArtifactsToExternal(
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

export async function migrateExternalBlobsToDb(
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

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function operationSummary(operation: {
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
