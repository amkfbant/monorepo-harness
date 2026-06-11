import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { openDbReadonly } from "../../db/connection.js";
import { readSchemaVersion } from "../../db/migrations.js";
import { SCHEMA_VERSION } from "../../db/schema.js";
import { dbStats } from "../../db/maintenance.js";
import { readArtifactBlob } from "../../db/artifact-blobs.js";
import { findBlobStore } from "../../db/blob-stores.js";
import { RunRepository, type RunDetail } from "../../db/repositories/runs.js";
import { LocalBlobStore } from "../../storage/local-blob-store.js";
import {
  BacklogRepository,
  getItemWithRuns,
} from "../../db/repositories/backlog.js";
import { ReviewProposalRepository } from "../../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../../db/repositories/review-consensus.js";
import {
  getOperation,
  listOperationEvents,
  type OperationFullRecord,
} from "../../db/repositories/operations.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, ok } from "../schemas/outputs.js";
import { knowledgeEntriesHasCategory } from "../../db/repositories/knowledge-entry-revisions.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { redactMcpAuditValue } from "../audit/redaction.js";
import {
  attachedArchivePaths,
  artifactIdToUri,
  cappedText,
  decodeCursor,
  encodeCursor,
  ensureProjectVisible,
  normalizeLimit,
  parseJson,
  tableExists,
  withReadonlyDb,
} from "./tool-helpers.js";

interface ListArgs {
  limit?: number;
  cursor?: string | null;
}

interface RunListArgs extends ListArgs {
  projectId?: string;
  domain?: string;
  statuses?: string[];
}

interface RunGetArgs {
  runId: string;
  includeArtifacts?: boolean;
  includeTimeline?: boolean;
}

interface ArtifactGetArgs {
  runId?: string;
  artifactId: string;
}

interface ProjectGetArgs {
  projectId: string;
}

interface DomainListArgs {
  projectId?: string;
}

interface PolicyEffectiveArgs {
  projectId: string;
  domain: string;
}

interface PolicySnapshotArgs {
  snapshotId: number;
}

interface BacklogListArgs extends ListArgs {
  projectId?: string;
  repoId?: string;
  status?: "open" | "doing" | "done" | "deferred";
}

interface BacklogGetArgs {
  itemId: string;
}

interface KnowledgeSearchArgs {
  query: string;
  projectId?: string;
  domain?: string;
  limit?: number;
}

interface KnowledgeGetArgs {
  entryId: string;
  includeBody?: boolean;
  maxBytes?: number;
}

interface OperationListArgs {
  targetType?: string;
  targetId?: string;
  status?: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  limit?: number;
  cursor?: string | null;
}

interface OperationGetArgs {
  operationId: string;
}

interface ArtifactRow {
  artifact_id: string;
  run_id: string | null;
  kind: string;
  relative_path: string | null;
  content_type: string | null;
  bytes: number;
  sha256: string;
  storage: string;
  blob_sha256: string | null;
  body_status: string | null;
  created_at: string | null;
  redacted: number;
  secret_suspect: number;
  original_bytes: number | null;
  original_sha256: string | null;
}

interface RunSource {
  run: RunDetail;
  archived: boolean;
  archivePath?: string;
}

interface ArtifactSource {
  artifact: ArtifactRow;
  archived: boolean;
  archivePath?: string;
}

export function projectListTool(
  args: { includeArchived?: boolean },
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const allowed = context.config.allowedProjects;
    const rows = db
      .prepare(
        `SELECT project_id, repo_id, profile_path, profile_version,
                description, repo_path, base_branch, package_manager,
                created_at, updated_at, current_profile_revision_id
           FROM projects
          ORDER BY project_id`,
      )
      .all() as Record<string, unknown>[];
    const projects = rows
      .filter((r) =>
        allowed.length === 0
          ? true
          : allowed.includes(r.project_id as string),
      )
      .map((r) => ({
        projectId: r.project_id as string,
        repoId: r.repo_id as string,
        currentProfileRevisionId:
          (r.current_profile_revision_id as number | null) ?? null,
        description: (r.description as string | null) ?? null,
        repoPath: (r.repo_path as string | null) ?? null,
        baseBranch: (r.base_branch as string | null) ?? null,
        packageManager: (r.package_manager as string | null) ?? null,
        domains: domainsForProject(db, r.project_id as string).map((d) => d.domainId),
        health: "unknown",
      }));
    return ok(`listed ${projects.length} project(s)`, {
      projects,
      includeArchived: args.includeArchived === true,
    });
  }) as HarnessMcpToolResult;
}

export function projectGetTool(
  args: ProjectGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare(
        `SELECT project_id, repo_id, profile_path, profile_version,
                description, repo_path, base_branch, package_manager,
                created_at, updated_at, current_profile_revision_id
           FROM projects WHERE project_id = ?`,
      )
      .get(args.projectId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return errorResult(`project not found: ${args.projectId}`);
    }
    const domains = domainsForProject(db, args.projectId);
    return {
      status: "ok",
      summary: `project ${args.projectId}`,
      data: {
        project: {
          projectId: row.project_id,
          repoId: row.repo_id,
          currentProfileRevisionId:
            (row.current_profile_revision_id as number | null) ?? null,
          profilePath: (row.profile_path as string | null) ?? null,
          profileVersion: (row.profile_version as number | null) ?? null,
          description: (row.description as string | null) ?? null,
          repoPath: (row.repo_path as string | null) ?? null,
          baseBranch: (row.base_branch as string | null) ?? null,
          packageManager: (row.package_manager as string | null) ?? null,
          createdAt: (row.created_at as string | null) ?? null,
          updatedAt: (row.updated_at as string | null) ?? null,
        },
        domains,
      },
      resourceLinks: [
        {
          uri: `harness://project/${encodeURIComponent(args.projectId)}`,
          name: "Project",
          mimeType: "application/json",
        },
        {
          uri: `harness://project/${encodeURIComponent(args.projectId)}/profile`,
          name: "Project profile",
          mimeType: "application/json",
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function domainListTool(
  args: DomainListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const domains =
      args.projectId === undefined
        ? allVisibleDomains(db, context)
        : domainsForProject(db, args.projectId);
    return ok(`listed ${domains.length} domain(s)`, { domains });
  }) as HarnessMcpToolResult;
}

export async function policyGetEffectiveTool(
  args: PolicyEffectiveArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId);
  if (denied !== null) return denied;
  return withReadonlyDb(context, ({ db }) => {
    const snapshot = latestEffectivePolicySnapshot(
      db,
      args.projectId,
      args.domain,
      true,
    );
    if (snapshot === null) {
      return errorResult(
        `no effective policy snapshot for ${args.projectId}/${args.domain}`,
        { projectId: args.projectId, domain: args.domain },
      );
    }
    return {
      status: "ok",
      summary: `effective policy for ${args.projectId}/${args.domain}`,
      data: {
        projectId: snapshot.projectId,
        repoId: snapshot.repoId,
        domain: args.domain,
        snapshot,
      },
      resourceLinks: [
        {
          uri: `harness://project/${encodeURIComponent(args.projectId)}/policy/effective`,
          name: "Effective policy",
          mimeType: "application/json",
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function policySnapshotGetTool(
  args: PolicySnapshotArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare(
        `SELECT snapshot_id, run_id, project_id, repo_id, domain,
                template_revision_id, generated_policy_yaml,
                generated_policy_sha256, provenance_json, created_at
           FROM effective_policy_snapshots
          WHERE snapshot_id = ?`,
      )
      .get(args.snapshotId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return errorResult(`policy snapshot not found: ${args.snapshotId}`);
    }
    const denied = ensureProjectVisible(
      context.config,
      (row.project_id as string | null) ?? null,
    );
    if (denied !== null) return denied;
    return ok(`policy snapshot ${args.snapshotId}`, {
      snapshot: toPolicySnapshot(row),
    });
  }) as HarnessMcpToolResult;
}

export function runListTool(
  args: RunListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const offset = decodeCursor(args.cursor);
    const page = listRunPage(db, args, context, limit, offset);
    const runs = page.runs;
    const total = page.total;
    const nextOffset = offset + runs.length;
    return ok(`listed ${runs.length} run(s)`, {
      runs,
      page: {
        limit,
        offset,
        total,
        nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      },
    });
  }) as HarnessMcpToolResult;
}

export function runGetTool(
  args: RunGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const found = findRunWithArchives(db, args.runId);
    if (found === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, found.run.projectId);
    if (denied !== null) return denied;
    const data: Record<string, unknown> = {
      run: found.run,
      archived: found.archived,
    };
    withRunSourceDb(db, found, (sourceDb) => {
      if (args.includeTimeline === true) {
        data.timeline = new RunRepository(sourceDb).getTimeline(args.runId);
      }
      if (args.includeArtifacts === true) {
        data.artifacts = listArtifactRows(sourceDb, args.runId).map((r) =>
          toArtifactMetadata(r, context, sourceDb),
        );
      }
    });
    return {
      status: "ok",
      summary: `run ${args.runId}`,
      data,
      resourceLinks: runResourceLinks(args.runId),
    };
  }) as HarnessMcpToolResult;
}

export function runTimelineTool(
  args: { runId: string },
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const found = findRunWithArchives(db, args.runId);
    if (found === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, found.run.projectId);
    if (denied !== null) return denied;
    const timeline = withRunSourceDb(db, found, (sourceDb) =>
      new RunRepository(sourceDb).getTimeline(args.runId),
    );
    return ok(`run ${args.runId} timeline`, {
      runId: args.runId,
      archived: found.archived,
      timeline,
    });
  }) as HarnessMcpToolResult;
}

export function runArtifactsTool(
  args: { runId: string },
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const found = findRunWithArchives(db, args.runId);
    if (found === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, found.run.projectId);
    if (denied !== null) return denied;
    const artifacts = withRunSourceDb(db, found, (sourceDb) =>
      listArtifactRows(sourceDb, args.runId).map((r) =>
        toArtifactMetadata(r, context, sourceDb),
      ),
    );
    return ok(`run ${args.runId} artifacts`, {
      runId: args.runId,
      archived: found.archived,
      artifacts,
    });
  }) as HarnessMcpToolResult;
}

export function runArtifactGetTool(
  args: ArtifactGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const found = findArtifactWithArchives(db, args);
    if (found === null) return errorResult(`artifact not found: ${args.artifactId}`);
    const projectId =
      found.artifact.run_id === null
        ? null
        : withArtifactSourceDb(db, found, (sourceDb) =>
            new RunRepository(sourceDb).getRun(found.artifact.run_id as string)
              ?.projectId ?? null,
          );
    const denied = ensureProjectVisible(context.config, projectId);
    if (denied !== null) return denied;
    return ok(`artifact ${found.artifact.artifact_id}`, {
      artifact: withArtifactSourceDb(db, found, (sourceDb) =>
        toArtifactMetadata(found.artifact, context, sourceDb),
      ),
      archived: found.archived,
    });
  }) as HarnessMcpToolResult;
}

export function runArtifactResourceTool(
  args: ArtifactGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const found = findArtifactWithArchives(db, args);
    if (found === null) return errorResult(`artifact not found: ${args.artifactId}`);
    const projectId =
      found.artifact.run_id === null
        ? null
        : withArtifactSourceDb(db, found, (sourceDb) =>
            new RunRepository(sourceDb).getRun(found.artifact.run_id as string)
              ?.projectId ?? null,
          );
    const denied = ensureProjectVisible(context.config, projectId);
    if (denied !== null) return denied;
    const artifact = withArtifactSourceDb(db, found, (sourceDb) =>
      toArtifactMetadata(found.artifact, context, sourceDb),
    );
    const body = withArtifactSourceDb(db, found, (sourceDb) =>
      artifactBodyForResource(found.artifact, context, sourceDb),
    );
    return ok(`artifact resource ${found.artifact.artifact_id}`, {
      artifact,
      body,
      archived: found.archived,
    });
  }) as HarnessMcpToolResult;
}

export function reviewQueueTool(
  args: RunListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return runListTool(
    { ...args, statuses: args.statuses ?? ["needs_review"] },
    context,
  );
}

export function reviewProposalsTool(
  args: { runId: string },
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const found = findRunWithArchives(db, args.runId);
    if (found === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, found.run.projectId);
    if (denied !== null) return denied;
    const proposals = withRunSourceDb(db, found, (sourceDb) =>
      new ReviewProposalRepository(sourceDb).listForRun(args.runId, {
        includeArchived: false,
      }),
    );
    return ok(`run ${args.runId} review proposals`, {
      runId: args.runId,
      archived: found.archived,
      proposals,
    });
  }) as HarnessMcpToolResult;
}

export function reviewConsensusTool(
  args: { runId: string },
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const found = findRunWithArchives(db, args.runId);
    if (found === null) return errorResult(`run not found: ${args.runId}`);
    const denied = ensureProjectVisible(context.config, found.run.projectId);
    if (denied !== null) return denied;
    const consensus = withRunSourceDb(db, found, (sourceDb) => {
      const repo = new ReviewConsensusRepository(sourceDb);
      return {
        active: repo.findActive(args.runId),
        history: repo.listHistory(args.runId).map((r) => ({
          ...r,
          summary: parseJson(r.summaryJson, {}),
          sourceProposalIds: parseJson(r.sourceProposalsJson, []),
        })),
      };
    });
    return ok(`run ${args.runId} review consensus`, {
      runId: args.runId,
      archived: found.archived,
      ...consensus,
    });
  }) as HarnessMcpToolResult;
}

export function backlogListTool(
  args: BacklogListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const offset = decodeCursor(args.cursor);
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
    if (args.repoId !== undefined) {
      where.push("repo_id = ?");
      params.push(args.repoId);
    }
    if (args.status !== undefined) {
      where.push("status = ?");
      params.push(args.status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT item_id FROM backlog_items ${whereSql}
          ORDER BY created_at DESC, item_id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as { item_id: string }[];
    const total = (
      db
        .prepare(`SELECT count(*) AS n FROM backlog_items ${whereSql}`)
        .get(...params) as { n: number }
    ).n;
    const items = rows
      .map((r) => getItemWithRuns(db, r.item_id))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const nextOffset = offset + items.length;
    return ok(`listed ${items.length} backlog item(s)`, {
      items,
      page: {
        limit,
        offset,
        total,
        nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      },
    });
  }) as HarnessMcpToolResult;
}

export function backlogGetTool(
  args: BacklogGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const item = getItemWithRuns(db, args.itemId);
    if (item === null) return errorResult(`backlog item not found: ${args.itemId}`);
    const denied = ensureProjectVisible(context.config, item.projectId ?? null);
    if (denied !== null) return denied;
    return {
      status: "ok",
      summary: `backlog item ${args.itemId}`,
      data: { item },
      resourceLinks: [
        {
          uri: `harness://backlog/${encodeURIComponent(args.itemId)}`,
          name: "Backlog item",
          mimeType: "application/json",
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function knowledgeSearchTool(
  args: KnowledgeSearchArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    // `harness.knowledge.*` is the CODEBASE knowledge surface. Operational
    // knowledge (category='operational', issue #57) is excluded here. On a
    // pre-v19 schema every row is codebase, so the filter is dropped (the
    // column does not exist yet) rather than throwing.
    const where = ["(entry_id LIKE ? OR title LIKE ? OR body LIKE ?)"];
    if (knowledgeEntriesHasCategory(db)) where.unshift("category = 'codebase'");
    const q = `%${args.query}%`;
    const params: unknown[] = [q, q, q];
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
    const rows = db
      .prepare(
        `SELECT entry_id, project_id, repo_id, domain, kind, path, title,
                created_at, source_candidate_id, current_revision_id
           FROM knowledge_entries
          WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC, entry_id
          LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[];
    const entries = rows.map(toKnowledgeSummary);
    return ok(`found ${entries.length} knowledge entr${entries.length === 1 ? "y" : "ies"}`, {
      entries,
    });
  }) as HarnessMcpToolResult;
}

export function knowledgeGetTool(
  args: KnowledgeGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    // pre-v19: no category column, all rows are codebase → drop the predicate.
    const categoryClause = knowledgeEntriesHasCategory(db)
      ? " AND category = 'codebase'"
      : "";
    const row = db
      .prepare(
        `SELECT entry_id, project_id, repo_id, domain, kind, path, title,
                body, frontmatter_json, created_at, source_candidate_id,
                current_revision_id
           FROM knowledge_entries
          WHERE entry_id = ?${categoryClause}`,
      )
      .get(args.entryId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return errorResult(`knowledge entry not found: ${args.entryId}`);
    }
    const denied = ensureProjectVisible(
      context.config,
      (row.project_id as string | null) ?? null,
    );
    if (denied !== null) return denied;
    const body = row.body as string;
    const maxBytes = Math.min(
      args.maxBytes ?? context.config.limits.maxArtifactBytesPerToolResult,
      context.config.limits.maxArtifactBytesPerToolResult,
    );
    const bodyResult = args.includeBody === true ? cappedText(body, maxBytes) : null;
    return {
      status: "ok",
      summary: `knowledge entry ${args.entryId}`,
      data: {
        entry: {
          ...toKnowledgeSummary(row),
          frontmatter: parseJson(row.frontmatter_json as string | null, {}),
          bodyBytes: Buffer.byteLength(body, "utf8"),
          ...(bodyResult === null
            ? { bodyPreview: { omitted: true, reason: "body omitted by default" } }
            : bodyResult.capped
              ? {
                  bodyPreview: {
                    omitted: true,
                    capped: true,
                    bytes: bodyResult.bytes,
                    maxBytes,
                    text: bodyResult.text,
                  },
                }
              : { body }),
        },
      },
      resourceLinks: [
        {
          uri: `harness://knowledge/${encodeURIComponent(args.entryId)}`,
          name: "Knowledge entry",
          mimeType: "application/json",
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function dbStatusTool(
  _args: Record<string, never>,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db, dbPath }) => {
    const stats = dbStats(dbPath);
    return ok("harness DB status", {
      dbPath,
      exists: true,
      schemaVersion: readSchemaVersion(db),
      latestSchemaVersion: SCHEMA_VERSION,
      sizeBytes: statSync(dbPath).size,
      walBytes: stats.walBytes,
      totalRows: stats.totalRows,
      tableRows: stats.tableRows,
      blobs: stats.blobs,
      truncation: stats.truncation,
    });
  }) as HarnessMcpToolResult;
}

export function doctorSummaryTool(
  _args: Record<string, never>,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    if (!tableExists(db, "doctor_runs")) {
      return errorResult("doctor tables are not available in this DB schema");
    }
    const latest = db
      .prepare(
        `SELECT doctor_run_id, started_at, completed_at, status, summary_json
           FROM doctor_runs
          ORDER BY started_at DESC, doctor_run_id DESC
          LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (latest === undefined) {
      return {
        status: "ok",
        summary: "no doctor run recorded",
        data: { latest: null },
        nextActions: [{ label: "Run doctor", command: "harness db doctor" }],
      };
    }
    const findings = db
      .prepare(
        `SELECT finding_id, check_id, severity, status, message,
                repairable, details_json
           FROM doctor_findings
          WHERE doctor_run_id = ?
          ORDER BY finding_id`,
      )
      .all(latest.doctor_run_id) as Record<string, unknown>[];
    return ok(`latest doctor run ${latest.doctor_run_id}`, {
      latest: {
        doctorRunId: latest.doctor_run_id,
        startedAt: latest.started_at,
        completedAt: latest.completed_at,
        status: latest.status,
        summary: parseJson(latest.summary_json as string, {}),
        findings: findings.map((f) => ({
          findingId: f.finding_id,
          checkId: f.check_id,
          severity: f.severity,
          status: f.status,
          message: f.message,
          repairable: f.repairable === 1,
          details: parseJson(f.details_json as string, {}),
        })),
      },
    });
  }) as HarnessMcpToolResult;
}

export function operationListTool(
  args: OperationListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const limit = normalizeLimit(args.limit);
    const offset = decodeCursor(args.cursor);
    const page = listOperationPage(db, args, context, limit, offset);
    const operations = page.operations;
    const nextOffset = offset + operations.length;
    return ok(`listed ${operations.length} operation(s)`, {
      operations: operations.map(toOperationData),
      page: {
        limit,
        offset,
        total: page.total,
        nextCursor: nextOffset < page.total ? encodeCursor(nextOffset) : null,
      },
    });
  }) as HarnessMcpToolResult;
}

export function operationGetTool(
  args: OperationGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const operation = getOperation(db, args.operationId);
    if (operation === null) {
      return errorResult(`operation not found: ${args.operationId}`);
    }
    const denied = ensureProjectVisible(
      context.config,
      projectIdForOperation(db, operation),
    );
    if (denied !== null) return denied;
    return {
      status: "ok",
      summary: `operation ${args.operationId}`,
      data: {
        operation: toOperationData(operation),
        events: listOperationEvents(db, args.operationId).map((e) => ({
          ...e,
          message:
            e.message === null
              ? null
              : String(redactMcpAuditValue(e.message)),
          data: redactMcpAuditValue(parseJson(e.dataJson, {})),
        })),
      },
      resourceLinks: [
        {
          uri: `harness://operation/${encodeURIComponent(args.operationId)}`,
          name: "Operation",
          mimeType: "application/json",
        },
      ],
    };
  }) as HarnessMcpToolResult;
}

export function resolveRunProjectId(
  args: { runId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.runId === undefined || context.config.allowedProjects.length === 0) {
    return undefined;
  }
  const result = withReadonlyDb(context, ({ db }) => {
    const found = findRunWithArchives(db, args.runId as string);
    return found?.run.projectId ?? null;
  });
  return typeof result === "object" && result !== null && "status" in result
    ? null
    : (result as string | null | undefined);
}

export function resolveBacklogProjectId(
  args: { itemId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.itemId === undefined || context.config.allowedProjects.length === 0) {
    return undefined;
  }
  const result = withReadonlyDb(context, ({ db }) => {
    const item = new BacklogRepository(db).getItem(args.itemId as string);
    return item?.projectId ?? null;
  });
  return typeof result === "object" && result !== null && "status" in result
    ? null
    : (result as string | null | undefined);
}

export function resolveKnowledgeProjectId(
  args: { entryId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.entryId === undefined || context.config.allowedProjects.length === 0) {
    return undefined;
  }
  const result = withReadonlyDb(context, ({ db }) => {
    // codebase-only: this pre-dispatch scope check guards `harness.knowledge.get`
    // (a codebase surface). Resolving an operational entry here would leak its
    // existence / project via a `project_not_allowed` reply; treat it as absent
    // so the get falls through to the category-filtered not-found. On a pre-v19
    // schema all rows are codebase, so the filter is dropped.
    const categoryClause = knowledgeEntriesHasCategory(db)
      ? " AND category = 'codebase'"
      : "";
    const row = db
      .prepare(
        `SELECT project_id FROM knowledge_entries WHERE entry_id = ?${categoryClause}`,
      )
      .get(args.entryId) as { project_id: string | null } | undefined;
    return row?.project_id ?? null;
  });
  return typeof result === "object" && result !== null && "status" in result
    ? null
    : (result as string | null | undefined);
}

function listRunPage(
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

function listOperationPage(
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

function projectScopedOperationPredicate(allowedProjects: string[]): string {
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

function domainsForProject(db: Database.Database, projectId: string): Array<Record<string, unknown>> {
  const rows = db
    .prepare(
      `SELECT domain_key, project_id, repo_id, domain_id, root, kind, title
         FROM domains WHERE project_id = ? ORDER BY domain_id`,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(toDomain);
}

function allVisibleDomains(db: Database.Database, context: McpToolContext): Array<Record<string, unknown>> {
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

function toDomain(r: Record<string, unknown>): Record<string, unknown> {
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

function latestEffectivePolicySnapshot(
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

function toPolicySnapshot(r: Record<string, unknown>): Record<string, unknown> {
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

function findRunWithArchives(
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

function withRunSourceDb<T>(
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

function listArtifactRows(db: Database.Database, runId: string): ArtifactRow[] {
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

function findArtifactWithArchives(
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

function withArtifactSourceDb<T>(
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

function findArtifact(
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

function toArtifactMetadata(
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

function artifactBodyForResource(
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

function readExternalArtifactBlob(
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

function isTextArtifact(contentType: string | null): boolean {
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

function readArtifactBodyPreview(
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

function runResourceLinks(runId: string): Array<{ uri: string; name: string; mimeType: string }> {
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

function toKnowledgeSummary(r: Record<string, unknown>): Record<string, unknown> {
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

function projectIdForOperation(
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

function projectIdFromProjectDomainTarget(targetId: string): string {
  const separator = targetId.indexOf(":");
  return separator === -1 ? targetId : targetId.slice(0, separator);
}

function projectIdFromOperationInput(inputJson: string | null): string | undefined {
  const input = parseJson<Record<string, unknown> | null>(inputJson, null);
  return typeof input?.projectId === "string" ? input.projectId : undefined;
}

function isVisibleProject(
  context: McpToolContext,
  projectId: string | null | undefined,
): boolean {
  return ensureProjectVisible(context.config, projectId) === null;
}

function toOperationData(op: OperationFullRecord): Record<string, unknown> {
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

function toOperationFullRecord(r: Record<string, unknown>): OperationFullRecord {
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
