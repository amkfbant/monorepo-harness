// read-tools 公開 MCP tool factory（#125 A15 barrel 分割）。

import { BacklogRepository } from "../../db/repositories/backlog.js";

import { knowledgeEntriesHasCategory } from "../../db/repositories/knowledge-entry-revisions.js";
import type { McpToolContext } from "../registry/tool-registry.js";

import { withReadonlyDb } from "./tool-helpers.js";
import { findRunWithArchives } from "./read-helpers.js";

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
