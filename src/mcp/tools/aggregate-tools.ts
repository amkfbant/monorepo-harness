import {
  inboxSummary,
  metricsSummary,
  type AggregateFilter,
} from "../../db/repositories/aggregates.js";
import type { McpConfig } from "../security/config.js";
import {
  errorResult,
  ok,
  permissionDenied,
  type HarnessMcpToolResult,
} from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { ensureProjectVisible, withReadonlyDb } from "./tool-helpers.js";

export interface AggregateArgs {
  projectId?: string;
  repoId?: string;
  domain?: string;
  /** lower bound on the table's date column, in hours back from now */
  sinceHours?: number;
}

/**
 * Resolve the project to aggregate over under `allowedProjects` scope:
 *  - unrestricted client → the requested project (or none = repo-wide).
 *  - restricted client → the requested project IF allowed (else denied); when
 *    none is requested, default to the sole allowed project, or require one when
 *    several are allowed (a single-projectId aggregate can't span a subset).
 * Returns the effective projectId (or undefined for repo-wide), or an error.
 */
function resolveAggregateProject(
  config: McpConfig,
  argProjectId: string | undefined,
): { projectId: string | undefined } | { error: HarnessMcpToolResult } {
  const allowed = config.allowedProjects;
  if (argProjectId !== undefined) {
    const denied = ensureProjectVisible(config, argProjectId);
    if (denied !== null) return { error: denied };
    return { projectId: argProjectId };
  }
  if (allowed.length === 0) return { projectId: undefined }; // unrestricted
  if (allowed.length === 1) return { projectId: allowed[0] };
  return {
    error: permissionDenied(
      "MCP permission denied: specify a project (multiple allowed)",
      { reason: "project_required", allowedProjects: [...allowed] },
    ),
  };
}

function buildFilter(
  args: AggregateArgs,
  projectId: string | undefined,
): AggregateFilter | { error: HarnessMcpToolResult } {
  let since: string | undefined;
  if (args.sinceHours !== undefined) {
    if (!(args.sinceHours >= 0)) {
      return { error: errorResult("sinceHours must be non-negative") };
    }
    since = new Date(Date.now() - args.sinceHours * 3_600_000).toISOString();
  }
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
    ...(args.domain !== undefined ? { domain: args.domain } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

/**
 * "What should I look at now" over MCP: needs-review / changes-requested /
 * failed runs, plus a knowledge-candidate run count, scoped to `allowedProjects`.
 * Pure DB read (the DB read model), no git / filesystem. No time window — inbox
 * is current actionable state (the knowledge bucket is not window-aware).
 */
export function inboxTool(
  args: AggregateArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  const scoped = resolveAggregateProject(context.config, args.projectId);
  if ("error" in scoped) return scoped.error;
  const filter = buildFilter(args, scoped.projectId);
  if ("error" in filter) return filter.error;
  return withReadonlyDb(context, ({ db }) =>
    ok("inbox", inboxSummary(db, filter)),
  ) as HarnessMcpToolResult;
}

/**
 * Run / review metrics over MCP, scoped to `allowedProjects`: run counts by
 * status plus the review approved-rate (the DB read-model `metricsSummary`).
 * Pure DB read, no git / filesystem.
 */
export function metricsTool(
  args: AggregateArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  const scoped = resolveAggregateProject(context.config, args.projectId);
  if ("error" in scoped) return scoped.error;
  const filter = buildFilter(args, scoped.projectId);
  if ("error" in filter) return filter.error;
  return withReadonlyDb(context, ({ db }) =>
    ok("metrics", metricsSummary(db, filter)),
  ) as HarnessMcpToolResult;
}
