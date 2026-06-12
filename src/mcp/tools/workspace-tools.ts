import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";
import {
  OperationInFlightError,
  OperationReplayedFailureError,
  runOperation,
} from "../../operations/operation-runner.js";
import { ConvergenceService } from "../../hitch/convergence.js";
import { HitchRepository } from "../../hitch/repository.js";
import {
  WorkspaceRepository,
  type WorkspaceRecord,
} from "../../db/repositories/workspaces.js";
import {
  assembleWorkspaceStatuses,
  readWorkspaceStatusData,
} from "../../workspace/workspace-status-builder.js";
import {
  pickVerifiedGitCwd,
  resolveTrackedWorkspaceRepo,
  type TrackedRepoResolution,
} from "./workspace-tracked-repo.js";
import {
  errorResult,
  ok,
  permissionDenied,
  type HarnessMcpToolResult,
} from "../schemas/outputs.js";
import { redactMcpAuditValue } from "../audit/redaction.js";
import {
  assertMutationBudget,
  McpMutationBudgetExceededError,
} from "../security/limits.js";
import { modeForClient } from "../security/permissions.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { normalizeLimit, withReadonlyDb } from "./tool-helpers.js";

export interface WorkspaceListArgs {
  agent?: string;
  limit?: number;
}

/**
 * Read-only MCP coordination view of the per-agent workspaces (the DB index):
 * which agents exist, on what branch, their linked hitch + its convergence
 * decision, objective, heartbeat, and last checkpoint. Pure DB read — git
 * state (dirty / ahead-behind) and the mutating create/remove/checkpoint and
 * git-inclusive inspect/recover surfaces are deliberately CLI-only for now
 * (they need filesystem/git access and, for mutations, a confirmation gate).
 */
export function workspaceListTool(
  args: WorkspaceListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new WorkspaceRepository(db);
    const hitchRepo = new HitchRepository(db);
    const limit = normalizeLimit(args.limit, 200);
    // filter by agent IN the query so the limit cannot drop a match.
    const rows = repo.listAll({
      limit,
      ...(args.agent !== undefined ? { agent: args.agent } : {}),
    });

    // Memoize per hitchId: a workspace's project (for scoping) and the hitch's
    // convergence decision both come from the same session lookup.
    const hitchCache = new Map<
      string,
      { decision: string | null; projectId: string | null }
    >();
    const hitchInfo = (
      hitchId: string | null,
    ): { decision: string | null; projectId: string | null } => {
      if (hitchId === null) return { decision: null, projectId: null };
      const cached = hitchCache.get(hitchId);
      if (cached !== undefined) return cached;
      const session = hitchRepo.getSession(hitchId);
      const info =
        session === null
          ? { decision: null, projectId: null }
          : {
              decision: new ConvergenceService(hitchRepo).evaluate(hitchId)
                .decision,
              projectId: session.projectId,
            };
      hitchCache.set(hitchId, info);
      return info;
    };

    // Project scoping: a client restricted to `allowedProjects` must not see
    // workspaces outside it. A workspace's project is its linked hitch's
    // project_id; an unlinked or dangling workspace has no project, so it is
    // omitted for a restricted client (fail-closed).
    const allowed = context.config.allowedProjects;
    const restricted = allowed.length > 0;
    const kept = rows
      .map((r) => ({ r, info: hitchInfo(r.hitchId) }))
      .filter(
        ({ info }) =>
          !restricted ||
          (info.projectId !== null && allowed.includes(info.projectId)),
      );

    const checkpointAt = repo.latestCheckpointAtForWorkspaces(
      kept.map(({ r }) => r.workspaceId),
    );
    const workspaces = kept.map(({ r, info }) => ({
      agent: r.agent,
      repoPath: r.repoPath,
      branch: r.branch,
      worktreePath: r.worktreePath,
      status: r.status,
      hitchId: r.hitchId,
      hitchDecision: info.decision,
      objective: r.objective,
      lastActiveAt: r.lastActiveAt,
      lastCheckpointAt: checkpointAt.get(r.workspaceId) ?? null,
    }));
    return ok(`listed ${workspaces.length} workspace(s)`, { workspaces });
  }) as HarnessMcpToolResult;
}

export interface WorkspaceStatusArgs {
  repoPath: string;
  base?: string;
  staleAfterHours?: number;
}

/**
 * Git-inclusive status of every workspace of ONE repo, over MCP. `repoPath` is a
 * path inside a tracked worktree — its `worktreePath` from `workspace.list`, or
 * any subdir/file under it. It must resolve to a repo the harness already tracks
 * (≥1 workspace row) so this read tool never runs git against an arbitrary,
 * unknown path. Returns the same shape as the CLI `workspace status` (label +
 * git state + hitch + heartbeat), scoped to `allowedProjects` like
 * `workspace.list` — a path whose workspace is out of scope is rejected with the
 * SAME "not tracked" error as an unknown path, so scope membership never leaks.
 */
export async function workspaceStatusTool(
  args: WorkspaceStatusArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    return errorResult("harness DB is not initialized", { dbPath: paths.dbPath });
  }

  // DB-FIRST guard (shared): resolve `repoPath` to a tracked repo + candidate git
  // cwds, scoped to allowedProjects, WITHOUT running git on an unknown path.
  let resolution: TrackedRepoResolution;
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  try {
    const resolved = resolveTrackedWorkspaceRepo(
      handle.db,
      args.repoPath,
      context.config.allowedProjects,
    );
    if ("error" in resolved) return resolved.error;
    resolution = resolved.ok;
  } finally {
    handle.close();
  }
  // confirm a candidate still belongs to this repo before running git in it.
  const gitCwd = await pickVerifiedGitCwd(resolution);
  if (gitCwd === undefined) {
    return errorResult(`no live worktree on disk for ${args.repoPath}`, {
      repoPath: args.repoPath,
    });
  }
  const { data, include } = resolution;

  const staleHours =
    args.staleAfterHours !== undefined && args.staleAfterHours >= 0
      ? args.staleAfterHours
      : 24;
  const statuses = await assembleWorkspaceStatuses(
    { repoPath: gitCwd, workspacesDir: gitCwd },
    data,
    {
      base: args.base ?? "main",
      nowMs: Date.now(),
      staleThresholdMs: staleHours * 3_600_000,
      repoKey: resolution.repoKey, // verify each worktree belongs to this repo
      ...(include !== undefined ? { include } : {}),
    },
  );
  return ok(`status for ${statuses.length} workspace(s)`, {
    workspaces: statuses,
  });
}

export interface WorkspaceCheckpointArgs {
  repoPath: string;
  agent: string;
  note?: string;
  hitchId?: string;
  objective?: string;
  idempotencyKey: string;
  actorNote?: string;
}

/**
 * `allowedProjects` scoping for a workspace mutation. Authorizes the EXISTING
 * workspace's linked-hitch project FIRST (a restricted client may not touch an
 * unlinked / dangling / out-of-scope workspace — and an absent workspace is
 * denied rather than leaking its existence). When `args.hitchId` re-links a new
 * hitch, that hitch's project must ALSO be allowed. Read-only; runs on the write
 * handle (after migrate) before the mutation. Returns permission_denied or null.
 */
function checkWorkspaceProjectScope(
  db: Database.Database,
  allowed: readonly string[],
  args: WorkspaceCheckpointArgs,
): HarnessMcpToolResult | null {
  const wsRepo = new WorkspaceRepository(db);
  const hitchRepo = new HitchRepository(db);
  const projectAllowed = (hitchId: string | null): boolean => {
    if (hitchId === null) return false;
    const projectId = hitchRepo.getSession(hitchId)?.projectId ?? null;
    return projectId !== null && allowed.includes(projectId);
  };
  const deny = (): HarnessMcpToolResult =>
    permissionDenied("MCP permission denied: project_not_allowed", {
      reason: "project_not_allowed",
    });

  const existing = wsRepo.get(args.repoPath, args.agent);
  if (existing === null || !projectAllowed(existing.hitchId)) return deny();
  if (args.hitchId !== undefined && !projectAllowed(args.hitchId)) return deny();
  return null;
}

/**
 * Save an advisory checkpoint for a workspace over MCP (DB-only: note + hitch
 * link + objective + heartbeat — no git snapshot). A low-risk mutation: it
 * needs `workspace.checkpoint` allowlisted but no confirmation. The mutating
 * create/remove (filesystem worktree ops + a confirmation gate) stay CLI-only.
 */
export async function workspaceCheckpointTool(
  args: WorkspaceCheckpointArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  // mutation gate: guarded-mutation mode + operation allowlisted.
  if (modeForClient(context.config, context.clientName) !== "guarded-mutation") {
    return permissionDenied("MCP permission denied: mutation_disabled_for_client", {
      operation: "workspace.checkpoint",
      reason: "mutation_disabled_for_client",
    });
  }
  if (!context.config.allowedOperations.includes("workspace.checkpoint")) {
    return permissionDenied("MCP permission denied: operation_not_allowlisted", {
      operation: "workspace.checkpoint",
      reason: "operation_not_allowlisted",
    });
  }
  const paths = harnessPaths(context.harnessRoot);
  if (!existsSync(paths.dbPath)) {
    return errorResult("harness DB is not initialized", { dbPath: paths.dbPath });
  }

  const operationId = `op-${randomUUID()}`;
  const handle = openManagedDb({
    dbPath: paths.dbPath,
    lockPath: paths.dbLockPath,
  });
  try {
    runMigrations(handle.db);
    // project scoping on the WRITE handle (after migrate), BEFORE the mutation:
    // authorize the existing workspace's project first, then any re-linked hitch.
    if (context.config.allowedProjects.length > 0) {
      const denied = checkWorkspaceProjectScope(
        handle.db,
        context.config.allowedProjects,
        args,
      );
      if (denied !== null) return denied;
    }
    const outcome = await runOperation(
      handle.db,
      {
        operationId,
        operationType: "workspace.checkpoint",
        target: { type: "workspace", id: `${args.repoPath}:${args.agent}` },
        actor: `mcp:${context.clientName}`,
        idempotencyKey: args.idempotencyKey,
        dryRun: false,
        input: redactMcpAuditValue(args),
        metadata: redactMcpAuditValue({
          source: "mcp",
          toolName: "harness.workspace.checkpoint",
          clientName: context.clientName,
          sessionId: context.sessionId,
          ...(args.actorNote !== undefined ? { actorNote: args.actorNote } : {}),
        }) as Record<string, unknown>,
        beforeStart: (db) => {
          assertMutationBudget(db, context.config, {
            clientName: context.clientName,
            operationType: "workspace.checkpoint",
            targetId: `${args.repoPath}:${args.agent}`,
            idempotencyKey: args.idempotencyKey,
          });
        },
      },
      async () => {
        const repo = new WorkspaceRepository(handle.db);
        const record = repo.get(args.repoPath, args.agent);
        if (record === null) {
          throw new Error(
            `no workspace for agent "${args.agent}" in ${args.repoPath}`,
          );
        }
        if (args.hitchId !== undefined) {
          repo.linkHitch(args.repoPath, args.agent, args.hitchId);
        }
        if (args.objective !== undefined) {
          repo.setObjective(args.repoPath, args.agent, args.objective);
        }
        // always refresh the heartbeat, even for a note-only checkpoint.
        repo.touch(args.repoPath, args.agent);
        return repo.recordCheckpoint({
          workspaceId: record.workspaceId,
          note: args.note ?? null,
          headSha: null,
          dirtyCount: 0,
          hitchId: args.hitchId ?? record.hitchId,
          createdBy: `mcp:${context.clientName}`,
        });
      },
    );
    return {
      status: "operation_started",
      summary: `workspace.checkpoint ${outcome.replayed ? "replayed" : "started"}`,
      operationId: outcome.operation.operationId,
      data: {
        operation: {
          operationId: outcome.operation.operationId,
          operationType: outcome.operation.operationType,
          targetType: outcome.operation.targetType,
          targetId: outcome.operation.targetId,
          status: outcome.operation.status,
        },
        result: outcome.result,
        replayed: outcome.replayed,
      },
      resourceLinks: [
        {
          uri: `harness://operation/${outcome.operation.operationId}`,
          name: `operation ${outcome.operation.operationId}`,
          mimeType: "application/json",
        },
      ],
    };
  } catch (e) {
    if (e instanceof McpMutationBudgetExceededError) {
      const budget = e.decision;
      return permissionDenied(e.message, {
        limit: budget.limit ?? budget.reason,
        max: budget.max ?? null,
        resetAt: budget.resetAt ?? null,
      });
    }
    if (e instanceof OperationInFlightError) {
      return errorResult(e.message, {
        operationId: e.operationId,
        reason: "operation_in_flight",
      });
    }
    if (e instanceof OperationReplayedFailureError) {
      return errorResult(e.message, {
        operationId: e.operationId,
        reason: "idempotency_replayed_failure",
      });
    }
    return errorResult((e as Error).message, { operationId });
  } finally {
    handle.close();
  }
}
