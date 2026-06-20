// dry-run-tools の preview / 集計 helper 層。tool module から呼ばれる。

import { existsSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";

import { ProjectError } from "../../project/errors.js";

import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult } from "../schemas/outputs.js";

import { parseJson, tableExists } from "./tool-helpers.js";
import type { RunRow } from "./dry-run-types.js";

export function validateRepoPath(repoPath: string): HarnessMcpToolResult | null {
  if (!existsSync(repoPath)) {
    return errorResult(`repo path does not exist: ${repoPath}`, { repoPath });
  }
  if (!statSync(repoPath).isDirectory()) {
    return errorResult(`repo path is not a directory: ${repoPath}`, { repoPath });
  }
  return null;
}

export function projectToolError(summary: string, e: unknown): HarnessMcpToolResult {
  return errorResult(summary, {
    error:
      e instanceof ProjectError || e instanceof Error
        ? e.message
        : String(e),
  });
}

export function projectPreview(
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

export function domainPreview(
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

export function currentProfileRevisionPreview(
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

export function latestEffectivePolicySnapshot(
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

export function activeDomainLock(
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

export function recentRunsForDomain(
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

export function contextPackSummary(manifestYaml: string): Record<string, unknown> {
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

export function getRunRow(db: Database.Database, runId: string): RunRow | null {
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

export function toRunPreview(run: RunRow): Record<string, unknown> {
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

export function activeMaterializations(
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

export function activeLocksForRun(
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

export function cleanupActionsForRun(
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

export function countRows(
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

export function archiveCandidateRuns(
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

export function blobMigrationCandidates(
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

export function externalToDbMigrationCandidates(
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

export function blobGcCandidates(
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
