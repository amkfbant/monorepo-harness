// read-tools 公開 MCP tool factory（#125 A15 barrel 分割）。

import { getItemWithRuns } from "../../db/repositories/backlog.js";

import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, ok } from "../schemas/outputs.js";
import { knowledgeEntriesHasCategory } from "../../db/repositories/knowledge-entry-revisions.js";
import type { McpToolContext } from "../registry/tool-registry.js";

import { cappedText, decodeCursor, encodeCursor, ensureProjectVisible, normalizeLimit, parseJson, withReadonlyDb } from "./tool-helpers.js";
import type { BacklogGetArgs, BacklogListArgs, KnowledgeGetArgs, KnowledgeSearchArgs } from "./read-types.js";
import { toKnowledgeSummary } from "./read-helpers.js";

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
