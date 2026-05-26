import { existsSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";
import { harnessPaths } from "../../config/paths.js";
import { DEFAULT_CHECKS, type DoctorFinding } from "../../db/doctor.js";
import { findRepairFor } from "../../db/repair.js";
import { PullRequestRepository } from "../../db/repositories/pull-requests.js";
import { checkProject } from "../../project/checker.js";
import { ProjectError } from "../../project/errors.js";
import {
  loadDomainRegistry,
  selectDefaultRegistryId,
} from "../../project/domain-registry.js";
import { inspectProject } from "../../project/inspector.js";
import { loadProjectById } from "../../project/profile-resolver.js";
import { prepareProjectRun } from "../../project/run-project.js";
import { scanRepoSignals } from "../../project/repo-signals.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import {
  ensureProjectVisible,
  normalizeLimit,
  parseJson,
  tableExists,
  withReadonlyDb,
} from "./tool-helpers.js";

interface ProjectArgs {
  projectId: string;
}

interface RunDryRunArgs {
  projectId: string;
  domain: string;
  goal: string;
  contextPack?: string;
}

interface RunArgs {
  runId: string;
}

interface DbPreviewArgs {
  limit?: number;
  to?: "external" | "db";
  storeId?: string;
  deleteObjects?: boolean;
}

interface RunRow {
  run_id: string;
  repo_id: string;
  project_id: string | null;
  repo_path: string | null;
  domain: string;
  workflow: string;
  base_branch: string;
  base_sha: string | null;
  run_branch: string | null;
  status: string;
  safety_status: string | null;
  pr_url: string | null;
  pr_number: number | null;
  started_at: string | null;
  finished_at: string | null;
  state_version?: number;
}

export async function projectInspectTool(
  args: ProjectArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  try {
    const resolved = await loadProjectById(context.harnessRoot, args.projectId);
    if (resolved.repoPath === null) {
      return errorResult(`project ${args.projectId} has no repo path`, {
        projectId: args.projectId,
        profileSource: resolved.profileSource,
        profileRevisionId: resolved.profileRevisionId ?? null,
      });
    }
    const repoError = validateRepoPath(resolved.repoPath);
    if (repoError !== null) return repoError;
    const signals = await scanRepoSignals(resolved.repoPath);
    const registryId = selectDefaultRegistryId(signals);
    const registry = await loadDomainRegistry(
      harnessPaths(context.harnessRoot).templatesDir,
      registryId,
    );
    const inspection = inspectProject(signals, registry);
    return {
      status: "ok",
      summary: `project ${args.projectId} inspection`,
      data: {
        projectId: args.projectId,
        profileSource: resolved.profileSource,
        profileRevisionId: resolved.profileRevisionId ?? null,
        repoPath: resolved.repoPath,
        inspection,
      },
    };
  } catch (e) {
    return projectToolError(`project ${args.projectId} inspection failed`, e);
  }
}

export async function projectCheckTool(
  args: ProjectArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  try {
    const report = await checkProject({
      harnessRoot: context.harnessRoot,
      projectId: args.projectId,
      generatedAt: new Date().toISOString(),
    });
    return {
      status: "dry_run",
      summary: `project ${args.projectId} check ${report.status}`,
      data: {
        dryRun: true,
        report,
      },
      warnings: report.items
        .filter((i) => i.level === "warn")
        .map((i) => `${i.label}: ${i.detail ?? "warning"}`),
    };
  } catch (e) {
    return projectToolError(`project ${args.projectId} check failed`, e);
  }
}

export async function runDryRunTool(
  args: RunDryRunArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  try {
    const prepared = await prepareProjectRun({
      harnessRoot: context.harnessRoot,
      projectId: args.projectId,
      domain: args.domain,
    });
    const dbPreview = withReadonlyDb(context, ({ db }) => ({
      project: projectPreview(db, args.projectId),
      domain: domainPreview(db, args.projectId, args.domain),
      profileRevision: currentProfileRevisionPreview(db, args.projectId),
      effectivePolicySnapshot: latestEffectivePolicySnapshot(
        db,
        args.projectId,
        args.domain,
      ),
      domainLock: activeDomainLock(db, args.projectId, args.domain),
      recentRuns: recentRunsForDomain(db, args.projectId, args.domain),
    })) as
      | HarnessMcpToolResult
      | {
          project: Record<string, unknown> | null;
          domain: Record<string, unknown> | null;
          profileRevision: Record<string, unknown> | null;
          effectivePolicySnapshot: Record<string, unknown> | null;
          domainLock: Record<string, unknown> | null;
          recentRuns: Array<Record<string, unknown>>;
        };
    if ("status" in dbPreview) return dbPreview;
    const selectedContextPack =
      args.contextPack !== undefined
        ? prepared.projectContextPacks?.packIds.includes(args.contextPack) === true
        : true;
    return {
      status: "dry_run",
      summary: `would run ${args.projectId}/${args.domain}`,
      data: {
        dryRun: true,
        wouldRun: {
          projectId: args.projectId,
          repoId: prepared.repoId,
          domain: args.domain,
          goal: args.goal,
          baseBranch: prepared.baseBranch,
          repoPath: prepared.repoPath,
          contextPack: args.contextPack ?? null,
          selectedContextPack,
        },
        profileRevision: dbPreview.profileRevision,
        project: dbPreview.project,
        domain: dbPreview.domain,
        effectivePolicySnapshot: dbPreview.effectivePolicySnapshot,
        domainLock: dbPreview.domainLock,
        recentRuns: dbPreview.recentRuns,
        policy: {
          read: prepared.resolvedPolicy.read,
          write: prepared.resolvedPolicy.write,
          denyWrite: prepared.resolvedPolicy.denyWrite,
          codex: prepared.resolvedPolicy.codex,
          commandDefaults: prepared.resolvedPolicy.commandDefaults,
        },
        candidateCommands: prepared.resolvedPolicy.allowedCommands,
        contextPacks:
          prepared.projectContextPacks === undefined
            ? {
                packIds: [],
                fileCount: 0,
                includedFileCount: 0,
                totalBytes: 0,
                capped: false,
                findings: [],
              }
            : contextPackSummary(prepared.projectContextPacks.manifestYaml),
      },
      warnings:
        args.contextPack !== undefined && !selectedContextPack
          ? [`contextPack '${args.contextPack}' is not referenced by the selected domain`]
          : [],
      nextActions: [
        {
          label: "Start run",
          tool: "harness.run.start",
          arguments: {
            projectId: args.projectId,
            domain: args.domain,
            goal: args.goal,
            idempotencyKey: "<uuid>",
          },
        },
      ],
    };
  } catch (e) {
    return projectToolError(`run dry-run failed for ${args.projectId}/${args.domain}`, e);
  }
}

export function cleanupDryRunTool(
  args: RunArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const run = getRunRow(db, args.runId);
    if (run === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, run.project_id);
    if (denied !== null) return denied;
    const materializations = activeMaterializations(db, args.runId);
    const locks = activeLocksForRun(db, args.runId);
    const cleanupHistory = cleanupActionsForRun(db, args.runId);
    const artifactCount = countRows(db, "artifacts", "run_id = ?", [args.runId]);
    const plannedActions: Array<Record<string, unknown>> = [
      ...materializations.map((m) => ({
        action: "mark_materialization_cleaned",
        materializationId: m.materializationId,
        path: m.path,
      })),
      ...locks.map((l) => ({
        action: "release_domain_lock",
        lockId: l.lockId,
        domainKey: l.domainKey,
      })),
    ];
    if (plannedActions.length === 0) {
      plannedActions.push({ action: "noop", reason: "no active cleanup targets" });
    }
    return {
      status: "dry_run",
      summary: `would cleanup run ${args.runId}`,
      data: {
        dryRun: true,
        run: toRunPreview(run),
        plannedActions,
        activeMaterializations: materializations,
        activeLocks: locks,
        cleanupHistory,
        artifactCount,
      },
      nextActions: [
        {
          label: "Apply cleanup",
          tool: "harness.cleanup.apply",
          arguments: { runId: args.runId, idempotencyKey: "<uuid>" },
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function prPreviewTool(
  args: RunArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const run = getRunRow(db, args.runId);
    if (run === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, run.project_id);
    if (denied !== null) return denied;
    const existing = new PullRequestRepository(db).findByRun(args.runId);
    const existingComplete =
      existing !== null &&
      existing.status === "created" &&
      existing.url !== null &&
      existing.externalPrId !== null;
    const branch = run.run_branch ?? `harness/${args.runId}`;
    const title = `Harness run ${args.runId}: ${run.domain}`;
    const plannedPullRequest = existingComplete
      ? null
      : {
          provider: "git",
          repo: run.repo_id,
          branch,
          baseBranch: run.base_branch,
          title,
          draft: true,
        };
    const createAction = {
      label: "Create PR",
      tool: "harness.pr.create",
      arguments: { runId: args.runId, idempotencyKey: "<uuid>" },
    };
    return {
      status: "dry_run",
      summary: existingComplete
        ? `PR already recorded for run ${args.runId}`
        : existing === null
          ? `would create PR for run ${args.runId}`
          : `would retry PR creation for run ${args.runId}`,
      data: {
        dryRun: true,
        run: toRunPreview(run),
        existingPullRequest: existing,
        plannedPullRequest,
      },
      warnings:
        existing === null
          ? []
          : [`pull_requests already has status '${existing.status}' for this run`],
      nextActions: existingComplete ? [] : [createAction],
    };
  }) as HarnessMcpToolResult;
}

export function dbRepairDryRunTool(
  args: DbPreviewArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const findings = filterFindingsByAllowedProjects(
      db,
      DEFAULT_CHECKS.flatMap((check) => check.run(db)),
      context.config.allowedProjects,
    );
    const flagged = findings.filter((f) => f.status === "flagged");
    const repairable = flagged
      .map((finding) => ({ finding, action: findRepairFor(finding) }))
      .filter(
        (entry): entry is { finding: DoctorFinding; action: NonNullable<ReturnType<typeof findRepairFor>> } =>
          entry.action !== null,
      )
      .slice(0, limit);
    const planned = repairable.map(({ finding, action }) => ({
      finding,
      repair: action.apply(db, finding, { dryRun: true }),
    }));
    return {
      status: "dry_run",
      summary: `would repair ${planned.length} DB finding(s)`,
      data: {
        dryRun: true,
        counts: {
          checks: DEFAULT_CHECKS.length,
          flagged: flagged.length,
          repairable: repairable.length,
        },
        plannedRepairs: planned,
      },
      warnings: flagged
        .filter((f) => !f.repairable)
        .slice(0, 10)
        .map((f) => `${f.checkId}: ${f.message}`),
    };
  }) as HarnessMcpToolResult;
}

export function dbArchivePreviewTool(
  args: DbPreviewArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const archiveCatalog = tableExists(db, "archive_catalog")
      ? (db
          .prepare(
            `SELECT archive_id, path, created_at, range_start, range_end,
                    schema_version, sha256, status, metadata_json
               FROM archive_catalog
              ORDER BY created_at DESC, archive_id DESC
              LIMIT ?`,
          )
          .all(limit) as Record<string, unknown>[])
      : [];
    const candidates = archiveCandidateRuns(
      db,
      limit,
      context.config.allowedProjects,
    );
    return {
      status: "dry_run",
      summary: `would consider ${candidates.length} run(s) for archive`,
      data: {
        dryRun: true,
        candidates,
        attachedArchives:
          context.config.allowedProjects.length === 0
            ? archiveCatalog.map((r) => ({
                archiveId: r.archive_id,
                path: r.path,
                createdAt: r.created_at,
                rangeStart: (r.range_start as string | null) ?? null,
                rangeEnd: (r.range_end as string | null) ?? null,
                schemaVersion: r.schema_version,
                sha256: (r.sha256 as string | null) ?? null,
                status: r.status,
                metadata: parseJson(r.metadata_json as string | null, {}),
              }))
            : [],
      },
      warnings:
        context.config.allowedProjects.length === 0
          ? []
          : [
              "archive catalog details omitted because allowedProjects is scoped",
              "global DB archive apply is disabled for project-scoped MCP clients",
            ],
      nextActions:
        context.config.allowedProjects.length === 0
          ? [
              {
                label: "Create archive",
                tool: "harness.db.archive.apply",
                arguments: {
                  before: "<ISO timestamp>",
                  idempotencyKey: "<uuid>",
                },
              },
            ]
          : [],
    };
  }) as HarnessMcpToolResult;
}

export function dbMigrateBlobsPreviewTool(
  args: DbPreviewArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const direction = args.to ?? "external";
    const stores = tableExists(db, "blob_stores")
      ? (db
          .prepare(
            `SELECT store_id, store_type, status, config_json, metadata_json
               FROM blob_stores
              ORDER BY store_id`,
          )
          .all() as Record<string, unknown>[])
      : [];
    const defaultStore =
      stores.find((s) => s.store_id === args.storeId) ??
      stores.find((s) => s.status === "active") ??
      stores[0] ??
      null;
    const candidates =
      direction === "external"
        ? blobMigrationCandidates(db, limit, context.config.allowedProjects)
        : externalToDbMigrationCandidates(
            db,
            defaultStore?.store_id as string | undefined,
            limit,
            context.config.allowedProjects,
          );
    const directionLabel = direction === "external" ? "db-to-external" : "external-to-db";
    return {
      status: "dry_run",
      summary: `would migrate ${candidates.length} artifact blob(s) ${directionLabel}`,
      data: {
        dryRun: true,
        direction: directionLabel,
        defaultStore:
          defaultStore === null
            ? null
            : {
                storeId: defaultStore.store_id,
                storeType: defaultStore.store_type,
                status: defaultStore.status,
                config: parseJson(defaultStore.config_json as string | null, {}),
                metadata: parseJson(defaultStore.metadata_json as string | null, {}),
              },
        candidates,
      },
      warnings:
        defaultStore === null
          ? ["no blob store is configured; apply would require a blob store"]
          : [],
      nextActions: [
        {
          label: "Migrate blobs",
          tool: "harness.db.migrate_blobs.apply",
          arguments: {
            to: direction,
            ...(defaultStore?.store_id !== undefined ? { storeId: defaultStore.store_id } : {}),
            idempotencyKey: "<uuid>",
          },
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function dbGcBlobsPreviewTool(
  args: DbPreviewArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const stores = tableExists(db, "blob_stores")
      ? (db
          .prepare(
            `SELECT store_id, store_type, status, config_json, metadata_json
               FROM blob_stores
              ORDER BY store_id`,
          )
          .all() as Record<string, unknown>[])
      : [];
    const store =
      stores.find((s) => s.store_id === args.storeId) ??
      stores.find((s) => s.status === "active") ??
      stores[0] ??
      null;
    const candidates = blobGcCandidates(db, store?.store_id as string | undefined, limit);
    const scoped = context.config.allowedProjects.length > 0;
    return {
      status: "dry_run",
      summary: `would GC ${candidates.length} external artifact blob(s)`,
      data: {
        dryRun: true,
        operation: "external-blob-gc",
        storeId: store?.store_id ?? args.storeId ?? null,
        deleteObjects: args.deleteObjects === true,
        candidates,
      },
      warnings: [
        ...(args.deleteObjects === true
          ? ["confirmed execution will also delete external blob objects best-effort"]
          : []),
        ...(scoped
          ? [
              "external blob GC is a global maintenance operation",
              "apply is disabled for project-scoped MCP clients",
            ]
          : []),
      ],
      nextActions: scoped
        ? []
        : [
            {
              label: "GC blobs",
              tool: "harness.db.gc_blobs.apply",
              arguments: {
                ...(store?.store_id !== undefined ? { storeId: store.store_id } : {}),
                ...(args.deleteObjects === true ? { deleteObjects: true } : {}),
                idempotencyKey: "<uuid>",
              },
            },
          ],
    };
  }) as HarnessMcpToolResult;
}

function validateRepoPath(repoPath: string): HarnessMcpToolResult | null {
  if (!existsSync(repoPath)) {
    return errorResult(`repo path does not exist: ${repoPath}`, { repoPath });
  }
  if (!statSync(repoPath).isDirectory()) {
    return errorResult(`repo path is not a directory: ${repoPath}`, { repoPath });
  }
  return null;
}

function projectToolError(summary: string, e: unknown): HarnessMcpToolResult {
  return errorResult(summary, {
    error:
      e instanceof ProjectError || e instanceof Error
        ? e.message
        : String(e),
  });
}

function projectPreview(
  db: Database.Database,
  projectId: string,
): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT project_id, repo_id, profile_path, profile_version,
              description, repo_path, base_branch, package_manager,
              current_profile_revision_id
         FROM projects
        WHERE project_id = ?`,
    )
    .get(projectId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    projectId: row.project_id,
    repoId: row.repo_id,
    profilePath: (row.profile_path as string | null) ?? null,
    profileVersion: (row.profile_version as number | null) ?? null,
    description: (row.description as string | null) ?? null,
    repoPath: (row.repo_path as string | null) ?? null,
    baseBranch: (row.base_branch as string | null) ?? null,
    packageManager: (row.package_manager as string | null) ?? null,
    currentProfileRevisionId:
      (row.current_profile_revision_id as number | null) ?? null,
  };
}

function domainPreview(
  db: Database.Database,
  projectId: string,
  domain: string,
): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT domain_key, project_id, repo_id, domain_id, root, kind, title
         FROM domains
        WHERE project_id = ? AND domain_id = ?`,
    )
    .get(projectId, domain) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    domainKey: row.domain_key,
    projectId: row.project_id,
    repoId: row.repo_id,
    domainId: row.domain_id,
    root: row.root,
    kind: (row.kind as string | null) ?? null,
    title: (row.title as string | null) ?? null,
  };
}

function currentProfileRevisionPreview(
  db: Database.Database,
  projectId: string,
): Record<string, unknown> | null {
  if (!tableExists(db, "project_profile_revisions")) return null;
  const row = db
    .prepare(
      `SELECT r.revision_id, r.project_id, r.version, r.body_sha256,
              r.actor, r.reason, r.created_at, r.supersedes_revision_id
         FROM project_profile_revisions r
         INNER JOIN projects p ON p.current_profile_revision_id = r.revision_id
        WHERE p.project_id = ?`,
    )
    .get(projectId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    revisionId: row.revision_id,
    projectId: row.project_id,
    version: row.version,
    bodySha256: row.body_sha256,
    actor: row.actor,
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at,
    supersedesRevisionId:
      (row.supersedes_revision_id as number | null) ?? null,
  };
}

function latestEffectivePolicySnapshot(
  db: Database.Database,
  projectId: string,
  domain: string,
): Record<string, unknown> | null {
  if (!tableExists(db, "effective_policy_snapshots")) return null;
  const row = db
    .prepare(
      `SELECT snapshot_id, run_id, project_id, repo_id, domain,
              template_revision_id, generated_policy_sha256,
              provenance_json, created_at
         FROM effective_policy_snapshots
        WHERE project_id = ? AND domain = ?
        ORDER BY created_at DESC, snapshot_id DESC
        LIMIT 1`,
    )
    .get(projectId, domain) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    snapshotId: row.snapshot_id,
    runId: (row.run_id as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    repoId: (row.repo_id as string | null) ?? null,
    domain: (row.domain as string | null) ?? null,
    templateRevisionId:
      (row.template_revision_id as number | null) ?? null,
    generatedPolicySha256: row.generated_policy_sha256,
    provenance: parseJson(row.provenance_json as string | null, {}),
    createdAt: row.created_at,
  };
}

function activeDomainLock(
  db: Database.Database,
  projectId: string,
  domain: string,
): Record<string, unknown> | null {
  if (!tableExists(db, "domain_locks")) return null;
  const domainRow = db
    .prepare(
      `SELECT domain_key
         FROM domains
        WHERE project_id = ? AND domain_id = ?`,
    )
    .get(projectId, domain) as { domain_key: string } | undefined;
  if (domainRow === undefined) return null;
  const row = db
    .prepare(
      `SELECT lock_id, domain_key, repo_id, domain, holder_run_id,
              acquired_at, expires_at, released_at
         FROM domain_locks
        WHERE released_at IS NULL
          AND domain = ?
          AND domain_key = ?
        ORDER BY acquired_at DESC, lock_id DESC
        LIMIT 1`,
    )
    .get(domain, domainRow.domain_key) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) return null;
  return {
    available: false,
    lockId: row.lock_id,
    domainKey: row.domain_key,
    repoId: row.repo_id,
    domain: row.domain,
    holderRunId: (row.holder_run_id as string | null) ?? null,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

function recentRunsForDomain(
  db: Database.Database,
  projectId: string,
  domain: string,
): Array<Record<string, unknown>> {
  return (
    db
      .prepare(
        `SELECT run_id, status, safety_status, started_at, finished_at
           FROM runs
          WHERE project_id = ? AND domain = ?
          ORDER BY (started_at IS NULL), started_at DESC, run_id DESC
          LIMIT 5`,
      )
      .all(projectId, domain) as Record<string, unknown>[]
  ).map((r) => ({
    runId: r.run_id,
    status: r.status,
    safetyStatus: (r.safety_status as string | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  }));
}

function contextPackSummary(manifestYaml: string): Record<string, unknown> {
  const manifest = parseYaml(manifestYaml) as
    | {
        packs?: unknown;
        totalBytes?: unknown;
        capped?: unknown;
        findings?: unknown;
        files?: Array<{ included?: unknown; bytes?: unknown }>;
      }
    | null;
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  return {
    packIds: Array.isArray(manifest?.packs) ? manifest.packs : [],
    fileCount: files.length,
    includedFileCount: files.filter((f) => f.included === true).length,
    totalBytes:
      typeof manifest?.totalBytes === "number" ? manifest.totalBytes : 0,
    capped: manifest?.capped === true,
    findings: Array.isArray(manifest?.findings) ? manifest.findings : [],
  };
}

function getRunRow(db: Database.Database, runId: string): RunRow | null {
  const row = db
    .prepare(
      `SELECT run_id, repo_id, project_id, repo_path, domain, workflow,
              base_branch, base_sha, run_branch, status, safety_status,
              pr_url, pr_number, started_at, finished_at, state_version
         FROM runs
        WHERE run_id = ?`,
    )
    .get(runId) as RunRow | undefined;
  return row ?? null;
}

function toRunPreview(run: RunRow): Record<string, unknown> {
  return {
    runId: run.run_id,
    repoId: run.repo_id,
    projectId: run.project_id,
    repoPath: run.repo_path,
    domain: run.domain,
    workflow: run.workflow,
    baseBranch: run.base_branch,
    baseSha: run.base_sha,
    runBranch: run.run_branch,
    status: run.status,
    safetyStatus: run.safety_status,
    prUrl: run.pr_url,
    prNumber: run.pr_number,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    stateVersion: run.state_version ?? null,
  };
}

function activeMaterializations(
  db: Database.Database,
  runId: string,
): Array<Record<string, unknown>> {
  if (!tableExists(db, "run_materializations")) return [];
  return (
    db
      .prepare(
        `SELECT materialization_id, purpose, path, reason, created_at,
                expires_at, metadata_json
           FROM run_materializations
          WHERE run_id = ? AND status = 'active'
          ORDER BY created_at DESC, materialization_id DESC`,
      )
      .all(runId) as Record<string, unknown>[]
  ).map((r) => ({
    materializationId: r.materialization_id,
    purpose: r.purpose,
    path: r.path,
    reason: r.reason,
    createdAt: r.created_at,
    expiresAt: (r.expires_at as string | null) ?? null,
    metadata: parseJson(r.metadata_json as string | null, {}),
  }));
}

function activeLocksForRun(
  db: Database.Database,
  runId: string,
): Array<Record<string, unknown>> {
  if (!tableExists(db, "domain_locks")) return [];
  return (
    db
      .prepare(
        `SELECT lock_id, domain_key, repo_id, domain, acquired_at, expires_at
           FROM domain_locks
          WHERE holder_run_id = ? AND released_at IS NULL
          ORDER BY acquired_at DESC, lock_id DESC`,
      )
      .all(runId) as Record<string, unknown>[]
  ).map((r) => ({
    lockId: r.lock_id,
    domainKey: r.domain_key,
    repoId: r.repo_id,
    domain: r.domain,
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
  }));
}

function cleanupActionsForRun(
  db: Database.Database,
  runId: string,
): Array<Record<string, unknown>> {
  if (!tableExists(db, "cleanup_actions")) return [];
  return (
    db
      .prepare(
        `SELECT action_type, target, status, executed_at, error_message
           FROM cleanup_actions
          WHERE run_id = ?
          ORDER BY executed_at DESC, id DESC
          LIMIT 20`,
      )
      .all(runId) as Record<string, unknown>[]
  ).map((r) => ({
    actionType: r.action_type,
    target: (r.target as string | null) ?? null,
    status: r.status,
    executedAt: r.executed_at,
    errorMessage: (r.error_message as string | null) ?? null,
  }));
}

function countRows(
  db: Database.Database,
  table: string,
  whereSql: string,
  params: unknown[],
): number {
  if (!tableExists(db, table)) return 0;
  return (
    db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${whereSql}`).get(
      ...params,
    ) as { n: number }
  ).n;
}

function archiveCandidateRuns(
  db: Database.Database,
  limit: number,
  allowedProjects: string[],
): Array<Record<string, unknown>> {
  const where = ["status IN ('approved', 'rejected', 'failed', 'cancelled')"];
  const params: unknown[] = [];
  if (allowedProjects.length > 0) {
    where.push(`project_id IN (${allowedProjects.map(() => "?").join(", ")})`);
    params.push(...allowedProjects);
  }
  return (
    db
      .prepare(
        `SELECT run_id, repo_id, project_id, domain, status,
                started_at, finished_at, updated_at
           FROM runs
          WHERE ${where.join(" AND ")}
          ORDER BY COALESCE(finished_at, updated_at, started_at) ASC, run_id ASC
          LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[]
  ).map((r) => ({
    runId: r.run_id,
    repoId: r.repo_id,
    projectId: (r.project_id as string | null) ?? null,
    domain: r.domain,
    status: r.status,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    updatedAt: r.updated_at,
  }));
}

function blobMigrationCandidates(
  db: Database.Database,
  limit: number,
  allowedProjects: string[],
): Array<Record<string, unknown>> {
  if (!tableExists(db, "artifact_blobs") || !tableExists(db, "external_artifact_blobs")) {
    return [];
  }
  const projectFilter =
    allowedProjects.length === 0
      ? {
          artifactJoin: "LEFT JOIN artifacts a ON a.blob_sha256 = b.sha256",
          runJoin: "",
          where: "",
          params: [] as unknown[],
        }
      : {
          artifactJoin: "INNER JOIN artifacts a ON a.blob_sha256 = b.sha256",
          runJoin: "INNER JOIN runs r ON r.run_id = a.run_id",
          where: `AND r.project_id IN (${allowedProjects.map(() => "?").join(", ")})`,
          params: [...allowedProjects] as unknown[],
        };
  return (
    db
      .prepare(
        `SELECT b.sha256, b.bytes, b.stored_bytes, b.content_encoding,
                count(DISTINCT a.artifact_id) AS artifact_count,
                group_concat(DISTINCT a.artifact_id) AS artifact_ids
           FROM artifact_blobs b
           ${projectFilter.artifactJoin}
           ${projectFilter.runJoin}
          WHERE NOT EXISTS (
            SELECT 1 FROM external_artifact_blobs e WHERE e.sha256 = b.sha256
          )
            ${projectFilter.where}
          GROUP BY b.sha256, b.bytes, b.stored_bytes, b.content_encoding
          ORDER BY b.stored_bytes DESC, b.sha256 ASC
          LIMIT ?`,
      )
      .all(...projectFilter.params, limit) as Record<string, unknown>[]
  ).map((r) => ({
    sha256: r.sha256,
    bytes: r.bytes,
    storedBytes: r.stored_bytes,
    contentEncoding: r.content_encoding,
    artifactCount: r.artifact_count,
    artifactIds:
      typeof r.artifact_ids === "string" && r.artifact_ids.length > 0
        ? r.artifact_ids.split(",")
        : [],
  }));
}

function externalToDbMigrationCandidates(
  db: Database.Database,
  storeId: string | undefined,
  limit: number,
  allowedProjects: string[],
): Array<Record<string, unknown>> {
  if (!tableExists(db, "artifacts") || !tableExists(db, "external_artifact_blobs")) {
    return [];
  }
  const params: unknown[] = [];
  const where = [
    "a.storage = 'external'",
    "a.blob_sha256 IS NOT NULL",
    "e.status = 'available'",
  ];
  if (storeId !== undefined) {
    where.push("e.store_id = ?");
    params.push(storeId);
  }
  if (allowedProjects.length > 0) {
    where.push(`r.project_id IN (${allowedProjects.map(() => "?").join(", ")})`);
    params.push(...allowedProjects);
  }
  return (
    db
      .prepare(
        `SELECT a.artifact_id, a.run_id, a.blob_sha256, e.store_id, e.uri
           FROM artifacts a
           INNER JOIN external_artifact_blobs e ON e.sha256 = a.blob_sha256
           LEFT JOIN runs r ON r.run_id = a.run_id
          WHERE ${where.join(" AND ")}
          ORDER BY a.artifact_id ASC
          LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[]
  ).map((r) => ({
    artifactId: r.artifact_id,
    runId: (r.run_id as string | null) ?? null,
    sha256: r.blob_sha256,
    storeId: r.store_id,
    uri: r.uri,
  }));
}

function blobGcCandidates(
  db: Database.Database,
  storeId: string | undefined,
  limit: number,
): Array<Record<string, unknown>> {
  if (!tableExists(db, "external_artifact_blobs")) return [];
  const params: unknown[] = [];
  const where = [
    `NOT EXISTS (
       SELECT 1 FROM artifacts a WHERE a.blob_sha256 = e.sha256
     )`,
  ];
  if (storeId !== undefined) {
    where.push("e.store_id = ?");
    params.push(storeId);
  }
  return (
    db
      .prepare(
        `SELECT e.sha256, e.store_id, e.uri, e.status
           FROM external_artifact_blobs e
          WHERE ${where.join(" AND ")}
          ORDER BY e.sha256 ASC
          LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[]
  ).map((r) => ({
    sha256: r.sha256,
    storeId: r.store_id,
    uri: r.uri,
    status: r.status,
  }));
}

function filterFindingsByAllowedProjects(
  db: Database.Database,
  findings: DoctorFinding[],
  allowedProjects: string[],
): DoctorFinding[] {
  if (allowedProjects.length === 0) return findings;
  return findings.filter((finding) => {
    const projects = projectIdsForDoctorFinding(db, finding);
    return projects.some((projectId) => allowedProjects.includes(projectId));
  });
}

export function projectIdsForDoctorFinding(
  db: Database.Database,
  finding: DoctorFinding,
): string[] {
  const details = finding.details ?? {};
  const out = new Set<string>();
  addProjectFromValue(db, out, details.project_id);
  addProjectFromValue(db, out, details.projectId);
  addRunProjectFromValue(db, out, details.run_id);
  addRunProjectFromValue(db, out, details.runId);
  addRunProjectFromValue(db, out, details.holder_run_id);
  addArtifactProjectFromValue(db, out, details.artifact_id);
  addArtifactProjectFromValue(db, out, details.artifactId);
  addOperationProjectFromValue(db, out, details.operation_id);
  addOperationProjectFromValue(db, out, details.operationId);
  addTargetProjectFromValues(db, out, details.target_type, details.target_id);
  addTargetProjectFromValues(db, out, details.targetType, details.targetId);
  addAssetProjectFromValues(db, out, details.asset_type, details.asset_id);
  addAssetProjectFromValues(db, out, details.assetType, details.assetId);
  return [...out];
}

function addProjectFromValue(
  _db: Database.Database,
  out: Set<string>,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) out.add(value);
}

function addRunProjectFromValue(
  db: Database.Database,
  out: Set<string>,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length === 0) return;
  const row = db
    .prepare("SELECT project_id FROM runs WHERE run_id = ?")
    .get(value) as { project_id: string | null } | undefined;
  if (row?.project_id !== null && row?.project_id !== undefined) {
    out.add(row.project_id);
  }
}

function addArtifactProjectFromValue(
  db: Database.Database,
  out: Set<string>,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length === 0) return;
  const rows = db
    .prepare(
      `SELECT DISTINCT r.project_id
         FROM artifacts a
         INNER JOIN runs r ON r.run_id = a.run_id
        WHERE a.artifact_id = ?
          AND r.project_id IS NOT NULL`,
    )
    .all(value) as { project_id: string }[];
  for (const row of rows) out.add(row.project_id);
}

function addOperationProjectFromValue(
  db: Database.Database,
  out: Set<string>,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length === 0) return;
  const row = db
    .prepare(
      `SELECT target_type, target_id
         FROM operations
        WHERE operation_id = ?`,
    )
    .get(value) as
    | { target_type: string | null; target_id: string | null }
    | undefined;
  if (row !== undefined) {
    addTargetProjectFromValues(db, out, row.target_type, row.target_id);
  }
}

function addTargetProjectFromValues(
  db: Database.Database,
  out: Set<string>,
  targetType: unknown,
  targetId: unknown,
): void {
  if (typeof targetType !== "string" || typeof targetId !== "string") return;
  if (targetType === "run") {
    addRunProjectFromValue(db, out, targetId);
    return;
  }
  const table =
    targetType === "backlog_item"
      ? "backlog_items"
      : targetType === "knowledge_entry"
        ? "knowledge_entries"
        : targetType === "knowledge_candidate"
          ? "knowledge_candidates"
          : null;
  const idColumn =
    targetType === "backlog_item"
      ? "item_id"
      : targetType === "knowledge_entry"
        ? "entry_id"
        : targetType === "knowledge_candidate"
          ? "candidate_id"
          : null;
  if (table === null || idColumn === null || !tableExists(db, table)) return;
  const row = db
    .prepare(`SELECT project_id FROM ${table} WHERE ${idColumn} = ?`)
    .get(targetId) as { project_id: string | null } | undefined;
  if (row?.project_id !== null && row?.project_id !== undefined) {
    out.add(row.project_id);
  }
}

function addAssetProjectFromValues(
  _db: Database.Database,
  out: Set<string>,
  assetType: unknown,
  assetId: unknown,
): void {
  if (assetType === "project_profile" && typeof assetId === "string") {
    out.add(assetId);
  }
}
