import {
  listOperationalKnowledge,
  getOperationalKnowledge,
  type OperationalKnowledgeEntry,
} from "../../core/operational-knowledge.js";
import {
  errorResult,
  ok,
  type HarnessMcpToolResult,
} from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import {
  cappedText,
  ensureProjectVisible,
  normalizeLimit,
  withReadonlyDb,
} from "./tool-helpers.js";

/**
 * MCP read tools for operational knowledge (issue #57, SP3).
 *
 * The complement to `harness.knowledge.*` (codebase knowledge): these surface
 * the DB-canonical operational category so an MCP-connected operating agent can
 * RECALL toolchain / CI / environment / harness-usage learnings. Read-only —
 * authoring stays on the CLI (recording over MCP is a deferred mutation, see
 * docs/future-features.md). Scoping mirrors the codebase knowledge tools:
 * `allowedProjects` restricts which project-scoped entries are visible, and
 * portable (project-less) entries are always visible.
 */

export interface OpsKnowledgeSearchArgs {
  query?: string;
  projectId?: string;
  repoId?: string;
  domain?: string;
  includeDeprecated?: boolean;
  limit?: number;
}

export interface OpsKnowledgeGetArgs {
  entryId: string;
  includeBody?: boolean;
  maxBytes?: number;
}

/** Summary view (no body) — body is fetched via `ops_knowledge.get`. */
function toSummary(e: OperationalKnowledgeEntry): Record<string, unknown> {
  return {
    entryId: e.entryId,
    kind: e.kind,
    tags: e.tags,
    projectId: e.projectId,
    repoId: e.repoId,
    domain: e.domain,
    title: e.title,
    deprecated: e.deprecated,
    updatedAt: e.updatedAt,
  };
}

/** True when a project-scoped entry is visible under the client's allowlist. */
function visibleUnderAllowlist(
  allowedProjects: readonly string[],
  projectId: string | null,
): boolean {
  if (allowedProjects.length === 0) return true; // unrestricted
  if (projectId === null) return true; // portable entries are always visible
  return allowedProjects.includes(projectId);
}

export function opsKnowledgeSearchTool(
  args: OpsKnowledgeSearchArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const entries = listOperationalKnowledge(db, {
      includeDeprecated: args.includeDeprecated === true,
      ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
      ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
      ...(args.domain !== undefined ? { domain: args.domain } : {}),
    });
    const allowed = context.config.allowedProjects;
    const needle = args.query?.toLowerCase();
    const matched = entries.filter((e) => {
      if (!visibleUnderAllowlist(allowed, e.projectId)) return false;
      if (needle === undefined || needle === "") return true;
      return (
        e.title.toLowerCase().includes(needle) ||
        e.body.toLowerCase().includes(needle) ||
        e.entryId.toLowerCase().includes(needle)
      );
    });
    const limit = normalizeLimit(args.limit);
    const page = matched.slice(0, limit).map(toSummary);
    return ok(
      `found ${page.length} operational knowledge entr${page.length === 1 ? "y" : "ies"}`,
      { entries: page },
    );
  }) as HarnessMcpToolResult;
}

export function opsKnowledgeGetTool(
  args: OpsKnowledgeGetArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const entry = getOperationalKnowledge(db, args.entryId);
    if (entry === null) {
      return errorResult(`operational knowledge entry not found: ${args.entryId}`);
    }
    // Portable (project-less) entries are always visible — match the search
    // path's `visibleUnderAllowlist`. Only project-scoped entries are gated by
    // `allowedProjects` (ensureProjectVisible denies a null projectId, which
    // would wrongly hide portable entries that search already returns).
    if (entry.projectId !== null) {
      const denied = ensureProjectVisible(context.config, entry.projectId);
      if (denied !== null) return denied;
    }
    const maxBytes = Math.min(
      args.maxBytes ?? context.config.limits.maxArtifactBytesPerToolResult,
      context.config.limits.maxArtifactBytesPerToolResult,
    );
    const bodyResult =
      args.includeBody === true ? cappedText(entry.body, maxBytes) : null;
    return {
      status: "ok",
      summary: `operational knowledge entry ${args.entryId}`,
      data: {
        entry: {
          ...toSummary(entry),
          bodyBytes: Buffer.byteLength(entry.body, "utf8"),
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
              : { body: bodyResult.text }),
        },
      },
    } as HarnessMcpToolResult;
  }) as HarnessMcpToolResult;
}

/**
 * Pre-dispatch project resolver for `ops_knowledge.get` — resolves the entry's
 * project so the registry can apply `allowedProjects` before the handler runs.
 * Scoped to operational entries so it never resolves a codebase entry.
 */
export function resolveOpsKnowledgeProjectId(
  args: { entryId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.entryId === undefined || context.config.allowedProjects.length === 0) {
    return undefined;
  }
  const result = withReadonlyDb(context, ({ db }) => {
    const entry = getOperationalKnowledge(db, args.entryId as string);
    return entry?.projectId ?? null;
  });
  return typeof result === "object" && result !== null && "status" in result
    ? null
    : (result as string | null | undefined);
}
