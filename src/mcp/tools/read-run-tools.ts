// read-tools 公開 MCP tool factory（#125 A15 barrel 分割）。

import { RunRepository } from "../../db/repositories/runs.js";

import { ReviewProposalRepository } from "../../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../../db/repositories/review-consensus.js";

import type { HarnessMcpToolResult } from "../schemas/outputs.js";
import { errorResult, ok } from "../schemas/outputs.js";

import type { McpToolContext } from "../registry/tool-registry.js";

import { decodeCursor, encodeCursor, ensureProjectVisible, normalizeLimit, parseJson, withReadonlyDb } from "./tool-helpers.js";
import type { ArtifactGetArgs, RunGetArgs, RunListArgs } from "./read-types.js";
import { artifactBodyForResource, findArtifactWithArchives, findRunWithArchives, listArtifactRows, listRunPage, runResourceLinks, toArtifactMetadata, withArtifactSourceDb, withRunSourceDb } from "./read-helpers.js";

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
