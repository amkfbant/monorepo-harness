import { posix as pathPosix } from "node:path";
import { getCurrentProjectProfile } from "../../db/repositories/project-profile-revisions.js";
import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, ok } from "../schemas/outputs.js";
import type { McpToolContext } from "./tool-registry.js";
import {
  backlogGetTool,
  dbStatusTool,
  doctorSummaryTool,
  knowledgeGetTool,
  knowledgeSearchTool,
  operationGetTool,
  projectGetTool,
  reviewConsensusTool,
  reviewProposalsTool,
  runArtifactResourceTool,
  runArtifactsTool,
  runGetTool,
  runTimelineTool,
} from "../tools/read-tools.js";
import { goalStatusTool } from "../tools/goal-tools.js";
import {
  artifactIdFromUriSegment,
  ensureProjectVisible,
  parseJson,
  withReadonlyDb,
} from "../tools/tool-helpers.js";

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceReadTarget {
  uri: string;
  toolName: string;
  permissionArgs: Record<string, unknown>;
  additionalOperations: string[];
  mimeType: string;
  read: (context: McpToolContext) => Promise<HarnessMcpToolResult> | HarnessMcpToolResult;
}

export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export const MCP_STATIC_RESOURCES: McpResourceDefinition[] = [
  {
    uri: "harness://db/status",
    name: "DB status",
    description: "Harness DB schema, row, blob, and storage status.",
    mimeType: "application/json",
  },
  {
    uri: "harness://doctor/latest",
    name: "Latest doctor summary",
    description: "Latest harness DB/project health summary.",
    mimeType: "application/json",
  },
];

export const MCP_RESOURCE_TEMPLATES: McpResourceTemplateDefinition[] = [
  {
    uriTemplate: "harness://project/{projectId}",
    name: "Project",
    description: "Project metadata and domain summary.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://project/{projectId}/profile",
    name: "Project profile",
    description: "Project profile source and revision metadata.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://project/{projectId}/policy/effective",
    name: "Effective project policy",
    description: "Latest effective policy snapshots for a project.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://project/{projectId}/domain/{domain}",
    name: "Project domain",
    description: "One project domain row.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://run/{runId}",
    name: "Run",
    description: "Run summary.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://run/{runId}/timeline",
    name: "Run timeline",
    description: "Run lifecycle events.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://run/{runId}/review",
    name: "Run review context",
    description: "Review decisions and proposals for a run.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://run/{runId}/artifacts",
    name: "Run artifacts",
    description: "Run artifact metadata.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://run/{runId}/artifact/{relativePath}",
    name: "Run artifact by path",
    description: "Run artifact metadata and safe body summary by relative path.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://artifact/{artifactIdBase64}",
    name: "Artifact",
    description: "Artifact metadata and safe body summary by encoded artifact id.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://backlog/{itemId}",
    name: "Backlog item",
    description: "Backlog item details.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://goal/{hitchId}",
    name: "Goal",
    description: "Goal convergence status, findings, and decisions.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://knowledge/{entryId}",
    name: "Knowledge entry",
    description: "Promoted knowledge entry.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://knowledge/search/{query}",
    name: "Knowledge search",
    description: "Search promoted knowledge entries.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "harness://operation/{operationId}",
    name: "Operation",
    description: "Operation status and timeline.",
    mimeType: "application/json",
  },
];

export function resolveMcpResourceRead(uri: string): McpResourceReadTarget | null {
  const parsed = parseHarnessUri(uri);
  if (parsed === null) {
    return errorTarget(uri, "invalid harness resource URI");
  }
  const { host, segments } = parsed;
  if (host === "db" && segments.length === 1 && segments[0] === "status") {
    return toolTarget(uri, "harness.db.status", {}, (context) =>
      dbStatusTool({}, context),
    );
  }
  if (host === "doctor" && segments.length === 1 && segments[0] === "latest") {
    return toolTarget(uri, "harness.doctor.summary", {}, (context) =>
      doctorSummaryTool({}, context),
    );
  }
  if (host === "project") return resolveProjectResource(uri, segments);
  if (host === "run") return resolveRunResource(uri, segments);
  if (host === "artifact") return resolveArtifactResource(uri, segments);
  if (host === "backlog") return resolveBacklogResource(uri, segments);
  if (host === "goal") return resolveGoalResource(uri, segments);
  if (host === "knowledge") return resolveKnowledgeResource(uri, segments);
  if (host === "operation") return resolveOperationResource(uri, segments);
  return errorTarget(uri, `unknown harness resource host: ${host}`);
}

export function resourceContentFromResult(
  uri: string,
  mimeType: string,
  result: HarnessMcpToolResult,
  maxBytes: number,
): McpResourceContent {
  const payload = {
    ...result,
    resource: {
      uri,
      truncated: false,
      maxResourceBytes: maxBytes,
    },
  };
  const text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { uri, mimeType, text };
  }
  const capped = {
    status: result.status,
    summary: `${result.summary} (resource truncated)`,
    data: {
      omitted: true,
      originalBytes: Buffer.byteLength(text, "utf8"),
      maxResourceBytes: maxBytes,
    },
    resource: {
      uri,
      truncated: true,
      maxResourceBytes: maxBytes,
    },
  };
  return { uri, mimeType, text: JSON.stringify(capped, null, 2) };
}

function resolveProjectResource(
  uri: string,
  segments: string[],
): McpResourceReadTarget {
  const projectId = firstSegment(segments);
  if (projectId === null) return errorTarget(uri, "missing project id");
  if (segments.length === 1) {
    return toolTarget(uri, "harness.project.get", { projectId }, (context) =>
      projectGetTool({ projectId }, context),
    );
  }
  if (segments.length === 2 && segments[1] === "profile") {
    return toolTarget(
      uri,
      "harness.project.get",
      { projectId },
      (context) => projectProfileResource(projectId, context),
    );
  }
  if (
    segments.length === 3 &&
    segments[1] === "policy" &&
    segments[2] === "effective"
  ) {
    return toolTarget(
      uri,
      "harness.project.get",
      { projectId },
      (context) => projectPolicyResource(projectId, context),
      ["policy.get_effective"],
    );
  }
  if (segments.length >= 3 && segments[1] === "domain") {
    const domain = joinRemainder(segments, 2);
    if (domain === null) return errorTarget(uri, "missing domain");
    return toolTarget(
      uri,
      "harness.domain.list",
      { projectId },
      (context) => projectDomainResource(projectId, domain, context),
    );
  }
  return errorTarget(uri, "unknown project resource shape");
}

function resolveRunResource(
  uri: string,
  segments: string[],
): McpResourceReadTarget {
  const runId = firstSegment(segments);
  if (runId === null) return errorTarget(uri, "missing run id");
  if (segments.length === 1) {
    return toolTarget(uri, "harness.run.get", { runId }, (context) =>
      runGetTool({ runId }, context),
    );
  }
  if (segments.length === 2 && segments[1] === "timeline") {
    return toolTarget(uri, "harness.run.timeline", { runId }, (context) =>
      runTimelineTool({ runId }, context),
    );
  }
  if (segments.length === 2 && segments[1] === "review") {
    return toolTarget(
      uri,
      "harness.review.proposals",
      { runId },
      (context) => runReviewResource(runId, context),
      ["review.consensus"],
    );
  }
  if (segments.length === 2 && segments[1] === "artifacts") {
    return toolTarget(uri, "harness.run.artifacts", { runId }, (context) =>
      runArtifactsTool({ runId }, context),
    );
  }
  if (segments.length >= 3 && segments[1] === "artifact") {
    const relativePath = normalizeRelativePath(joinRemainder(segments, 2));
    if (relativePath === null) {
      return errorTarget(uri, "invalid artifact relativePath");
    }
    return toolTarget(
      uri,
      "harness.run.artifact.get",
      { runId, artifactId: relativePath },
      (context) =>
        runArtifactResourceTool({ runId, artifactId: relativePath }, context),
    );
  }
  return errorTarget(uri, "unknown run resource shape");
}

function resolveArtifactResource(
  uri: string,
  segments: string[],
): McpResourceReadTarget {
  if (segments.length !== 1 || segments[0] === "") {
    return errorTarget(uri, "missing artifact id");
  }
  const artifactId = artifactIdFromUriSegment(segments[0] as string);
  if (artifactId === null || artifactId.length === 0) {
    return errorTarget(uri, "invalid artifact id encoding");
  }
  return toolTarget(
    uri,
    "harness.run.artifact.get",
    { artifactId },
    (context) => runArtifactResourceTool({ artifactId }, context),
  );
}

function resolveBacklogResource(
  uri: string,
  segments: string[],
): McpResourceReadTarget {
  const itemId = joinRemainder(segments, 0);
  if (itemId === null) return errorTarget(uri, "missing backlog item id");
  return toolTarget(uri, "harness.backlog.get", { itemId }, (context) =>
    backlogGetTool({ itemId }, context),
  );
}

function resolveGoalResource(
  uri: string,
  segments: string[],
): McpResourceReadTarget {
  if (segments.length !== 1 || segments[0] === undefined || segments[0].length === 0) {
    return errorTarget(uri, "expected harness://goal/{hitchId}");
  }
  const hitchId = segments[0];
  return toolTarget(uri, "harness.goal.status", { hitchId }, (context) =>
    goalStatusTool({ hitchId }, context),
  );
}

function resolveKnowledgeResource(
  uri: string,
  segments: string[],
): McpResourceReadTarget {
  if (segments[0] === "search") {
    const query = joinRemainder(segments, 1);
    if (query === null) return errorTarget(uri, "missing knowledge search query");
    return toolTarget(uri, "harness.knowledge.search", { query }, (context) =>
      knowledgeSearchTool({ query }, context),
    );
  }
  const entryId = joinRemainder(segments, 0);
  if (entryId === null) return errorTarget(uri, "missing knowledge entry id");
  return toolTarget(uri, "harness.knowledge.get", { entryId }, (context) =>
    knowledgeGetTool(
      {
        entryId,
        includeBody: true,
        maxBytes: context.config.resources.maxResourceBytes,
      },
      context,
    ),
  );
}

function resolveOperationResource(
  uri: string,
  segments: string[],
): McpResourceReadTarget {
  const operationId = firstSegment(segments);
  if (operationId === null || segments.length !== 1) {
    return errorTarget(uri, "missing operation id");
  }
  return toolTarget(uri, "harness.operation.get", { operationId }, (context) =>
    operationGetTool({ operationId }, context),
  );
}

function parseHarnessUri(
  uri: string,
): { host: string; segments: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "harness:" || parsed.hostname.length === 0) {
    return null;
  }
  const rawSegments = parsed.pathname.split("/").slice(1);
  const segments: string[] = [];
  for (const segment of rawSegments) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return { host: parsed.hostname, segments };
}

function firstSegment(segments: string[]): string | null {
  const value = segments[0];
  return value === undefined || value.length === 0 ? null : value;
}

function joinRemainder(segments: string[], start: number): string | null {
  const value = segments.slice(start).join("/");
  return value.length === 0 ? null : value;
}

function normalizeRelativePath(path: string | null): string | null {
  if (path === null || path.length === 0 || path.includes("\0")) return null;
  if (pathPosix.isAbsolute(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return null;
  }
  const normalized = pathPosix.normalize(path);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return null;
  }
  return normalized;
}

function toolTarget(
  uri: string,
  toolName: string,
  permissionArgs: Record<string, unknown>,
  read: (context: McpToolContext) => Promise<HarnessMcpToolResult> | HarnessMcpToolResult,
  additionalOperations: string[] = [],
): McpResourceReadTarget {
  return {
    uri,
    toolName,
    permissionArgs,
    additionalOperations,
    mimeType: "application/json",
    read,
  };
}

function errorTarget(uri: string, summary: string): McpResourceReadTarget {
  return toolTarget(uri, "harness.resource.read", {}, () =>
    errorResult(summary, { uri }),
  );
}

function projectProfileResource(
  projectId: string,
  context: McpToolContext,
): HarnessMcpToolResult {
  const denied = ensureProjectVisible(context.config, projectId);
  if (denied !== null) return denied;
  return withReadonlyDb(context, ({ db }) => {
    const project = db
      .prepare(
        `SELECT project_id, repo_id, profile_path, profile_version,
                current_profile_revision_id
           FROM projects
          WHERE project_id = ?`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    if (project === undefined) return errorResult(`project not found: ${projectId}`);
    const current = getCurrentProjectProfile(db, projectId);
    const legacy =
      current === null
        ? (db
            .prepare(
              `SELECT project_id, version, source_yaml, source_sha256, loaded_at
                 FROM project_profiles
                WHERE project_id = ?
                ORDER BY version DESC
                LIMIT 1`,
            )
            .get(projectId) as Record<string, unknown> | undefined)
        : undefined;
    return ok(`project ${projectId} profile`, {
      project: {
        projectId: project.project_id,
        repoId: project.repo_id,
        profilePath: (project.profile_path as string | null) ?? null,
        profileVersion: (project.profile_version as number | null) ?? null,
        currentProfileRevisionId:
          (project.current_profile_revision_id as number | null) ?? null,
      },
      current:
        current === null
          ? null
          : {
              revisionId: current.revisionId,
              version: current.version,
              bodyYaml: current.bodyYaml,
              bodySha256: current.bodySha256,
              parsed: parseJson(current.parsedJson, {}),
              actor: current.actor,
              reason: current.reason,
              createdAt: current.createdAt,
              supersedesRevisionId: current.supersedesRevisionId,
              sourcePath: current.sourcePath,
            },
      legacy:
        legacy === undefined
          ? null
          : {
              version: legacy.version,
              sourceYaml: legacy.source_yaml,
              sourceSha256: legacy.source_sha256,
              loadedAt: legacy.loaded_at,
            },
    });
  }) as HarnessMcpToolResult;
}

function projectPolicyResource(
  projectId: string,
  context: McpToolContext,
): HarnessMcpToolResult {
  const denied = ensureProjectVisible(context.config, projectId);
  if (denied !== null) return denied;
  return withReadonlyDb(context, ({ db }) => {
    const project = db
      .prepare("SELECT project_id FROM projects WHERE project_id = ?")
      .get(projectId);
    if (project === undefined) return errorResult(`project not found: ${projectId}`);
    const rows = db
      .prepare(
        `SELECT snapshot_id, run_id, project_id, repo_id, domain,
                template_revision_id, generated_policy_yaml,
                generated_policy_sha256, provenance_json, created_at
           FROM effective_policy_snapshots
          WHERE project_id = ?
          ORDER BY created_at DESC, snapshot_id DESC
          LIMIT 50`,
      )
      .all(projectId) as Record<string, unknown>[];
    return ok(`project ${projectId} effective policy snapshots`, {
      projectId,
      snapshots: rows.map(toPolicySnapshotResource),
    });
  }) as HarnessMcpToolResult;
}

function projectDomainResource(
  projectId: string,
  domain: string,
  context: McpToolContext,
): HarnessMcpToolResult {
  const denied = ensureProjectVisible(context.config, projectId);
  if (denied !== null) return denied;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare(
        `SELECT domain_key, project_id, repo_id, domain_id, root, kind, title
           FROM domains
          WHERE project_id = ? AND domain_id = ?
          LIMIT 1`,
      )
      .get(projectId, domain) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return errorResult(`domain not found: ${projectId}/${domain}`, {
        projectId,
        domain,
      });
    }
    return ok(`project ${projectId} domain ${domain}`, {
      domain: {
        domainKey: row.domain_key,
        projectId: row.project_id,
        repoId: row.repo_id,
        domainId: row.domain_id,
        root: row.root,
        kind: (row.kind as string | null) ?? null,
        title: (row.title as string | null) ?? null,
      },
    });
  }) as HarnessMcpToolResult;
}

function runReviewResource(
  runId: string,
  context: McpToolContext,
): HarnessMcpToolResult {
  const proposals = reviewProposalsTool({ runId }, context);
  if (proposals.status !== "ok") return proposals;
  const consensus = reviewConsensusTool({ runId }, context);
  if (consensus.status !== "ok") return consensus;
  return ok(`run ${runId} review context`, {
    runId,
    proposals: (proposals.data as Record<string, unknown>).proposals ?? [],
    consensus: consensus.data ?? {},
  });
}

function toPolicySnapshotResource(r: Record<string, unknown>): Record<string, unknown> {
  return {
    snapshotId: r.snapshot_id,
    runId: (r.run_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    repoId: (r.repo_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    templateRevisionId: (r.template_revision_id as number | null) ?? null,
    generatedPolicyYaml: r.generated_policy_yaml,
    generatedPolicySha256: r.generated_policy_sha256,
    provenance: parseJson(r.provenance_json as string | null, {}),
    createdAt: r.created_at,
  };
}
