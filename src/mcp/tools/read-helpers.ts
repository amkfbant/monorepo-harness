// read-tools の内部 read-query / 変換 helper 層。tool module から呼ばれる。

import type Database from "better-sqlite3";
import { openDbReadonly } from "../../db/connection.js";

import { readArtifactBlob } from "../../db/artifact-blobs.js";
import { findBlobStore } from "../../db/blob-stores.js";
import { RunRepository } from "../../db/repositories/runs.js";
import { LocalBlobStore } from "../../storage/local-blob-store.js";
import { BacklogRepository } from "../../db/repositories/backlog.js";

import { type OperationFullRecord } from "../../db/repositories/operations.js";

import type { McpToolContext } from "../registry/tool-registry.js";
import { redactMcpAuditValue } from "../audit/redaction.js";
import { attachedArchivePaths, artifactIdToUri, ensureProjectVisible, parseJson, tableExists } from "./tool-helpers.js";
import type { ArtifactGetArgs, ArtifactRow, ArtifactSource, OperationListArgs, RunListArgs, RunSource } from "./read-types.js";

export function listRunPage(
  db: Database.Database,
  args: RunListArgs,
  context: McpToolContext,
  limit: number,
  offset: number,
): {
  runs: Array<Record<string, unknown>>;
  total: number;
} {
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(args.projectId);
  } else if (context.config.allowedProjects.length > 0) {
    where.push(
      `project_id IN (${context.config.allowedProjects.map(() => "?").join(", ")})`,
    );
    params.push(...context.config.allowedProjects);
  }
  if (args.domain !== undefined) {
    where.push("domain = ?");
    params.push(args.domain);
  }
  if (args.statuses !== undefined) {
    if (args.statuses.length === 0) {
      where.push("0 = 1");
    } else {
      where.push(`status IN (${args.statuses.map(() => "?").join(", ")})`);
      params.push(...args.statuses);
    }
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT run_id, repo_id, project_id, domain, status, safety_status,
              reviewer, started_at, finished_at, rerun_attempt, pr_url
         FROM runs ${whereSql}
        ORDER BY (started_at IS NULL), started_at DESC, run_id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];
  const total = (
    db.prepare(`SELECT count(*) AS n FROM runs ${whereSql}`).get(...params) as {
      n: number;
    }
  ).n;
  return {
    runs: rows.map((r) => ({
      runId: r.run_id,
      repoId: r.repo_id,
      projectId: (r.project_id as string | null) ?? null,
      domain: r.domain,
      status: r.status,
      safetyStatus: (r.safety_status as string | null) ?? null,
      reviewer: (r.reviewer as string | null) ?? null,
      startedAt: (r.started_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      rerunAttempt: (r.rerun_attempt as number | null) ?? null,
      prUrl: (r.pr_url as string | null) ?? null,
    })),
    total,
  };
}

export function listOperationPage(
  db: Database.Database,
  args: OperationListArgs,
  context: McpToolContext,
  limit: number,
  offset: number,
): {
  operations: OperationFullRecord[];
  total: number;
} {
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.targetType !== undefined) {
    where.push("target_type = ?");
    params.push(args.targetType);
  }
  if (args.targetId !== undefined) {
    where.push("target_id = ?");
    params.push(args.targetId);
  }
  if (args.status !== undefined) {
    where.push("status = ?");
    params.push(args.status);
  }
  if (context.config.allowedProjects.length > 0) {
    where.push(projectScopedOperationPredicate(context.config.allowedProjects));
    params.push(
      ...context.config.allowedProjects,
      ...context.config.allowedProjects,
      ...context.config.allowedProjects,
      ...context.config.allowedProjects,
      ...context.config.allowedProjects,
      ...context.config.allowedProjects,
      ...context.config.allowedProjects,
      ...context.config.allowedProjects,
      ...context.config.allowedProjects,
    );
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM operations ${whereSql}
        ORDER BY created_at DESC, operation_id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];
  const total = (
    db
      .prepare(`SELECT count(*) AS n FROM operations ${whereSql}`)
      .get(...params) as { n: number }
  ).n;
  return {
    operations: rows.map(toOperationFullRecord),
    total,
  };
}

export function projectScopedOperationPredicate(allowedProjects: string[]): string {
  const placeholders = allowedProjects.map(() => "?").join(", ");
  return `(
    (target_type = 'run' AND EXISTS (
      SELECT 1 FROM runs r
       WHERE r.run_id = operations.target_id
         AND r.project_id IN (${placeholders})
    ))
    OR (target_type = 'backlog_item' AND EXISTS (
      SELECT 1 FROM backlog_items b
       WHERE b.item_id = operations.target_id
         AND b.project_id IN (${placeholders})
    ))
    OR (target_type = 'knowledge_entry' AND EXISTS (
      SELECT 1 FROM knowledge_entries k
       WHERE k.entry_id = operations.target_id
         AND k.project_id IN (${placeholders})
    ))
    OR (target_type = 'knowledge_candidate' AND EXISTS (
      SELECT 1 FROM knowledge_candidates kc
       WHERE kc.candidate_id = operations.target_id
         AND kc.project_id IN (${placeholders})
    ))
    OR (target_type = 'goal' AND EXISTS (
      SELECT 1 FROM hitch_sessions gs
       WHERE gs.hitch_id = operations.target_id
         AND gs.project_id IN (${placeholders})
    ))
    OR (target_type = 'goal_finding' AND EXISTS (
      SELECT 1 FROM hitch_findings gf
      JOIN hitch_sessions gs ON gs.hitch_id = gf.hitch_id
       WHERE gf.finding_id = operations.target_id
         AND gs.project_id IN (${placeholders})
    ))
    OR (target_type = 'project_domain' AND (
      target_id IN (${placeholders})
      OR substr(
        target_id,
        1,
        CASE instr(target_id, ':')
          WHEN 0 THEN length(target_id)
          ELSE instr(target_id, ':') - 1
        END
      ) IN (${placeholders})
    ))
    OR (target_type = 'backlog_domain' AND target_id IN (${placeholders}))
  )`;
}

export function domainsForProject(db: Database.Database, projectId: string): Array<Record<string, unknown>> {
  const rows = db
    .prepare(
      `SELECT domain_key, project_id, repo_id, domain_id, root, kind, title
         FROM domains WHERE project_id = ? ORDER BY domain_id`,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(toDomain);
}

export function allVisibleDomains(db: Database.Database, context: McpToolContext): Array<Record<string, unknown>> {
  const allowed = context.config.allowedProjects;
  if (allowed.length === 0) {
    return (
      db
        .prepare(
          `SELECT domain_key, project_id, repo_id, domain_id, root, kind, title
             FROM domains ORDER BY project_id, domain_id`,
        )
        .all() as Record<string, unknown>[]
    ).map(toDomain);
  }
  if (allowed.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT domain_key, project_id, repo_id, domain_id, root, kind, title
         FROM domains
        WHERE project_id IN (${allowed.map(() => "?").join(", ")})
        ORDER BY project_id, domain_id`,
    )
    .all(...allowed) as Record<string, unknown>[];
  return rows.map(toDomain);
}

export function toDomain(r: Record<string, unknown>): Record<string, unknown> {
  return {
    domainKey: r.domain_key,
    projectId: (r.project_id as string | null) ?? null,
    repoId: r.repo_id,
    domainId: r.domain_id,
    root: r.root,
    kind: (r.kind as string | null) ?? null,
    title: (r.title as string | null) ?? null,
  };
}

export function latestEffectivePolicySnapshot(
  db: Database.Database,
  projectId: string,
  domain: string,
  includeYaml = false,
): Record<string, unknown> | null {
  if (!tableExists(db, "effective_policy_snapshots")) return null;
  const row = db
    .prepare(
      `SELECT snapshot_id, run_id, project_id, repo_id, domain,
              template_revision_id,
              ${includeYaml ? "generated_policy_yaml," : ""}
              generated_policy_sha256,
              provenance_json, created_at
         FROM effective_policy_snapshots
        WHERE project_id = ? AND domain = ?
        ORDER BY created_at DESC, snapshot_id DESC
        LIMIT 1`,
    )
    .get(projectId, domain) as Record<string, unknown> | undefined;
  return row === undefined ? null : toPolicySnapshot(row);
}

export function toPolicySnapshot(r: Record<string, unknown>): Record<string, unknown> {
  return {
    snapshotId: r.snapshot_id,
    runId: (r.run_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    repoId: (r.repo_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    templateRevisionId: (r.template_revision_id as number | null) ?? null,
    generatedPolicyYaml: (r.generated_policy_yaml as string | null) ?? undefined,
    generatedPolicySha256: r.generated_policy_sha256,
    provenance: parseJson(r.provenance_json as string | null, {}),
    createdAt: r.created_at,
  };
}

export function findRunWithArchives(
  db: Database.Database,
  runId: string,
): RunSource | null {
  const run = new RunRepository(db).getRun(runId);
  if (run !== null) return { run, archived: false };
  for (const archivePath of attachedArchivePaths(db)) {
    const archiveDb = openDbReadonly(archivePath);
    try {
      const run = new RunRepository(archiveDb).getRun(runId);
      if (run !== null) return { run, archived: true, archivePath };
    } finally {
      archiveDb.close();
    }
  }
  return null;
}

export function withRunSourceDb<T>(
  mainDb: Database.Database,
  source: RunSource,
  read: (db: Database.Database) => T,
): T {
  if (!source.archived) return read(mainDb);
  const archiveDb = openDbReadonly(source.archivePath as string);
  try {
    return read(archiveDb);
  } finally {
    archiveDb.close();
  }
}

export function listArtifactRows(db: Database.Database, runId: string): ArtifactRow[] {
  return db
    .prepare(
      `SELECT artifact_id, run_id, kind, relative_path, content_type, bytes,
              sha256, storage, blob_sha256, body_status, created_at,
              redacted, secret_suspect, original_bytes, original_sha256
         FROM artifacts WHERE run_id = ?
         ORDER BY relative_path, artifact_id`,
    )
    .all(runId) as ArtifactRow[];
}

export function findArtifactWithArchives(
  db: Database.Database,
  args: ArtifactGetArgs,
): ArtifactSource | null {
  const artifact = findArtifact(db, args);
  if (artifact !== null) return { artifact, archived: false };
  for (const archivePath of attachedArchivePaths(db)) {
    const archiveDb = openDbReadonly(archivePath);
    try {
      const artifact = findArtifact(archiveDb, args);
      if (artifact !== null) return { artifact, archived: true, archivePath };
    } finally {
      archiveDb.close();
    }
  }
  return null;
}

export function withArtifactSourceDb<T>(
  mainDb: Database.Database,
  source: ArtifactSource,
  read: (db: Database.Database) => T,
): T {
  if (!source.archived) return read(mainDb);
  const archiveDb = openDbReadonly(source.archivePath as string);
  try {
    return read(archiveDb);
  } finally {
    archiveDb.close();
  }
}

export function findArtifact(
  db: Database.Database,
  args: ArtifactGetArgs,
): ArtifactRow | null {
  const row =
    args.runId === undefined
      ? db
          .prepare(
            `SELECT artifact_id, run_id, kind, relative_path, content_type, bytes,
                    sha256, storage, blob_sha256, body_status, created_at,
                    redacted, secret_suspect, original_bytes, original_sha256
               FROM artifacts
              WHERE artifact_id = ?
              LIMIT 1`,
          )
          .get(args.artifactId)
      : db
          .prepare(
            `SELECT artifact_id, run_id, kind, relative_path, content_type, bytes,
                    sha256, storage, blob_sha256, body_status, created_at,
                    redacted, secret_suspect, original_bytes, original_sha256
               FROM artifacts
              WHERE run_id = ? AND (artifact_id = ? OR relative_path = ?)
              LIMIT 1`,
          )
          .get(args.runId, args.artifactId, args.artifactId);
  return (row as ArtifactRow | undefined) ?? null;
}

export function toArtifactMetadata(
  row: ArtifactRow,
  context: McpToolContext,
  db: Database.Database,
): Record<string, unknown> {
  const bodyAvailable =
    row.storage === "db" && row.blob_sha256 !== null && row.redacted !== 1;
  const secretRedacted =
    row.secret_suspect === 1 && !context.config.resources.includeSecretSuspect;
  const canReturnSmallText =
    bodyAvailable &&
    !secretRedacted &&
    context.config.resources.artifactBody === "small-text" &&
    (row.content_type?.startsWith("text/") ||
      row.content_type === "application/json" ||
      row.content_type === "application/x-ndjson") &&
    row.bytes <= context.config.limits.maxArtifactBytesPerToolResult;
  let bodyPreview: Record<string, unknown> | null = null;
  if (canReturnSmallText && row.blob_sha256 !== null) {
    bodyPreview = {
      mode: "small-text",
      text: readArtifactBodyPreview(db, context, row.blob_sha256),
    };
  } else {
    bodyPreview = {
      mode: context.config.resources.artifactBody,
      omitted: true,
      reason: secretRedacted
        ? "secret_suspect"
        : row.redacted === 1
          ? "redacted"
          : bodyAvailable
            ? "use_resource"
            : "body_unavailable",
    };
  }
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    kind: row.kind,
    relativePath: row.relative_path,
    contentType: row.content_type,
    bytes: row.bytes,
    sha256: row.sha256,
    storage: row.storage,
    blobSha256: row.blob_sha256,
    bodyStatus: row.body_status,
    createdAt: row.created_at,
    redacted: row.redacted === 1,
    secretSuspect: row.secret_suspect === 1,
    originalBytes: row.original_bytes,
    originalSha256: row.original_sha256,
    resourceUri: artifactIdToUri(row.artifact_id),
    bodyPreview,
  };
}

export function artifactBodyForResource(
  row: ArtifactRow,
  context: McpToolContext,
  db: Database.Database,
): Record<string, unknown> {
  const mode = context.config.resources.artifactBody;
  const secretRedacted =
    row.secret_suspect === 1 && !context.config.resources.includeSecretSuspect;
  if (mode === "disabled") {
    return { mode, omitted: true, reason: "disabled" };
  }
  if (secretRedacted) {
    return { mode, omitted: true, reason: "secret_suspect" };
  }
  if (row.redacted === 1) {
    return { mode, omitted: true, reason: "redacted" };
  }
  if (mode === "summary-only") {
    return { mode, omitted: true, reason: "summary_only" };
  }
  if (
    (row.storage !== "db" && row.storage !== "external") ||
    row.blob_sha256 === null
  ) {
    return { mode, omitted: true, reason: "body_unavailable" };
  }
  if (!isTextArtifact(row.content_type)) {
    return { mode, omitted: true, reason: "binary_or_unknown_content_type" };
  }
  const body =
    row.storage === "external"
      ? readExternalArtifactBlob(db, row.blob_sha256)
      : readArtifactBlob(db, row.blob_sha256);
  if (body === null) {
    return { mode, omitted: true, reason: "blob_missing" };
  }
  const maxBytes = context.config.resources.maxResourceBytes;
  const preview = body.subarray(0, maxBytes);
  return {
    mode,
    text: preview.toString("utf8"),
    bytesReturned: preview.length,
    originalBytes: body.length,
    truncated: body.length > preview.length,
  };
}

export function readExternalArtifactBlob(
  db: Database.Database,
  blobSha256: string,
): Buffer | null {
  if (!tableExists(db, "external_artifact_blobs") || !tableExists(db, "blob_stores")) {
    return null;
  }
  const external = db
    .prepare(
      `SELECT sha256, store_id, uri, status
         FROM external_artifact_blobs
        WHERE sha256 = ?`,
    )
    .get(blobSha256) as
    | { sha256: string; store_id: string; uri: string; status: string }
    | undefined;
  if (external === undefined || external.status !== "available") return null;
  const storeRow = findBlobStore(db, external.store_id);
  if (storeRow === null || storeRow.storeType !== "local") return null;
	  const config = parseJson<{ root?: unknown }>(storeRow.configJson, {});
	  if (typeof config.root !== "string") return null;
	  try {
	    return new LocalBlobStore({ root: config.root }).getSync({
	      sha256: blobSha256,
	      uri: external.uri,
	    });
	  } catch {
	    return null;
	  }
	}

export function isTextArtifact(contentType: string | null): boolean {
  if (contentType === null) return false;
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/x-ndjson" ||
    normalized === "application/yaml" ||
    normalized === "application/x-yaml" ||
    normalized.endsWith("+json")
  );
}

export function readArtifactBodyPreview(
  db: Database.Database,
  context: McpToolContext,
  blobSha256: string,
): string | null {
  const body = readArtifactBlob(db, blobSha256);
  if (body === null) return null;
  return body
    .subarray(0, context.config.limits.maxArtifactBytesPerToolResult)
    .toString("utf8");
}

export function runResourceLinks(runId: string): Array<{ uri: string; name: string; mimeType: string }> {
  const encoded = encodeURIComponent(runId);
  return [
    { uri: `harness://run/${encoded}`, name: "Run", mimeType: "application/json" },
    {
      uri: `harness://run/${encoded}/timeline`,
      name: "Run timeline",
      mimeType: "application/json",
    },
    {
      uri: `harness://run/${encoded}/artifacts`,
      name: "Run artifacts",
      mimeType: "application/json",
    },
    {
      uri: `harness://run/${encoded}/review`,
      name: "Run review",
      mimeType: "application/json",
    },
  ];
}

export function toKnowledgeSummary(r: Record<string, unknown>): Record<string, unknown> {
  return {
    entryId: r.entry_id,
    projectId: (r.project_id as string | null) ?? null,
    repoId: (r.repo_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    kind: r.kind,
    path: (r.path as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
    sourceCandidateId: (r.source_candidate_id as string | null) ?? null,
    currentRevisionId: (r.current_revision_id as number | null) ?? null,
  };
}

export function projectIdForOperation(
  db: Database.Database,
  op: OperationFullRecord,
): string | null | undefined {
  if (op.targetType === "run" && op.targetId !== null) {
    return new RunRepository(db).getRun(op.targetId)?.projectId ?? null;
  }
  if (op.targetType === "backlog_item" && op.targetId !== null) {
    return new BacklogRepository(db).getItem(op.targetId)?.projectId ?? null;
  }
  if (op.targetType === "knowledge_entry" && op.targetId !== null) {
    const row = db
      .prepare("SELECT project_id FROM knowledge_entries WHERE entry_id = ?")
      .get(op.targetId) as { project_id: string | null } | undefined;
    return row?.project_id ?? null;
  }
  if (op.targetType === "knowledge_candidate" && op.targetId !== null) {
    const row = db
      .prepare("SELECT project_id FROM knowledge_candidates WHERE candidate_id = ?")
      .get(op.targetId) as { project_id: string | null } | undefined;
    return row?.project_id ?? null;
  }
  if (op.targetType === "goal" && op.targetId !== null) {
    const row = db
      .prepare("SELECT project_id FROM hitch_sessions WHERE hitch_id = ?")
      .get(op.targetId) as { project_id: string | null } | undefined;
    return row?.project_id ?? projectIdFromOperationInput(op.inputJson) ?? null;
  }
  if (op.targetType === "goal_finding" && op.targetId !== null) {
    const row = db
      .prepare(
        `SELECT s.project_id
           FROM hitch_findings f
           JOIN hitch_sessions s ON s.hitch_id = f.hitch_id
          WHERE f.finding_id = ?`,
      )
      .get(op.targetId) as { project_id: string | null } | undefined;
    return row?.project_id ?? null;
  }
  if (op.targetType === "project_domain" && op.targetId !== null) {
    return projectIdFromProjectDomainTarget(op.targetId);
  }
  if (op.targetType === "backlog_domain" && op.targetId !== null) {
    const directProject = db
      .prepare("SELECT project_id FROM projects WHERE project_id = ?")
      .get(op.targetId) as { project_id: string } | undefined;
    if (directProject !== undefined) return directProject.project_id;
    const inputProjectId = projectIdFromOperationInput(op.inputJson);
    if (inputProjectId !== undefined) return inputProjectId;
    return null;
  }
  return undefined;
}

export function projectIdFromProjectDomainTarget(targetId: string): string {
  const separator = targetId.indexOf(":");
  return separator === -1 ? targetId : targetId.slice(0, separator);
}

export function projectIdFromOperationInput(inputJson: string | null): string | undefined {
  const input = parseJson<Record<string, unknown> | null>(inputJson, null);
  return typeof input?.projectId === "string" ? input.projectId : undefined;
}

export function isVisibleProject(
  context: McpToolContext,
  projectId: string | null | undefined,
): boolean {
  return ensureProjectVisible(context.config, projectId) === null;
}

export function toOperationData(op: OperationFullRecord): Record<string, unknown> {
  return {
    operationId: op.operationId,
    operationType: op.operationType,
    targetType: op.targetType,
    targetId: op.targetId,
    actor: op.actor,
    idempotencyKey:
      op.idempotencyKey === null
        ? null
        : redactMcpAuditValue(op.idempotencyKey, "idempotencyKey"),
    dryRun: op.dryRun,
    status: op.status,
    input: redactMcpAuditValue(parseJson(op.inputJson, null)),
    result: redactMcpAuditValue(parseJson(op.resultJson, null)),
    errorCode: op.errorCode,
    errorMessage:
      op.errorMessage === null
        ? null
        : String(redactMcpAuditValue(op.errorMessage)),
    createdAt: op.createdAt,
    startedAt: op.startedAt,
    completedAt: op.completedAt,
    metadata: redactMcpAuditValue(parseJson(op.metadataJson, {})),
  };
}

export function toOperationFullRecord(r: Record<string, unknown>): OperationFullRecord {
  return {
    operationId: r.operation_id as string,
    operationType: (r.operation_type as string | null) ?? null,
    targetType: (r.target_type as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    actor: (r.actor as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    dryRun: Boolean(r.dry_run),
    status: (r.status as OperationFullRecord["status"]) ?? "succeeded",
    inputJson: (r.input_json as string | null) ?? null,
    resultJson: (r.result_json as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    metadataJson: (r.metadata_json as string | null) ?? "{}",
  };
}
