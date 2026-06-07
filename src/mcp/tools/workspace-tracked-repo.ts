import { existsSync } from "node:fs";
import { sep as pathSep } from "node:path";
import type Database from "better-sqlite3";
import {
  WorkspaceRepository,
  type WorkspaceRecord,
} from "../../db/repositories/workspaces.js";
import { normalizeWorktreePath } from "../../workspace/agent-workspace.js";
import {
  readWorkspaceStatusData,
  type WorkspaceStatusData,
} from "../../workspace/workspace-status-builder.js";
import { errorResult, type HarnessMcpToolResult } from "../schemas/outputs.js";

/**
 * Match `target` (a normalized path) to the tracked workspace it belongs to: an
 * exact worktree path, OR any subpath under one (a subdir/file inside the
 * worktree). Pure fs string logic — no git — so the DB-first guard holds. When
 * the path sits under multiple worktrees (shouldn't happen for non-nested
 * worktrees), the most specific (longest) worktree path wins. Operates on the
 * lightweight `{worktreePath}` list so it is cap-free.
 */
export function matchTrackedWorktree<T extends { worktreePath: string }>(
  rows: readonly T[],
  target: string,
): T | undefined {
  let best: T | undefined;
  let bestLen = -1;
  for (const r of rows) {
    const wt = normalizeWorktreePath(r.worktreePath);
    const isMatch = target === wt || target.startsWith(wt + pathSep);
    if (isMatch && wt.length > bestLen) {
      best = r;
      bestLen = wt.length;
    }
  }
  return best;
}

export interface TrackedRepoResolution {
  /** the canonical repo key of the matched repo */
  repoKey: string;
  /** an EXISTING, IN-SCOPE worktree of the repo, safe to run read-only git in */
  gitCwd: string;
  /** DB facts for the repo's workspaces (rows + per-goal info + checkpoint ts) */
  data: WorkspaceStatusData;
  /** project-scope predicate (undefined when the client is unrestricted) */
  include?: (record: WorkspaceRecord | null, goalProjectId: string | null) => boolean;
  /** linked-goal project of a row (for the scope predicate) */
  projectOf: (record: WorkspaceRecord) => string | null;
}

export type ResolveTrackedRepoResult =
  | { ok: TrackedRepoResolution }
  | { error: HarnessMcpToolResult };

/**
 * The DB-FIRST guard shared by every git-inclusive workspace read tool
 * (`status` / `inspect` / `conflicts` / `recover`): resolve a client-supplied
 * `repoPath` to a TRACKED repo and a safe git cwd WITHOUT running git on an
 * unknown path, scoped to `allowedProjects`.
 *
 *  - `repoPath` must sit inside a tracked workspace worktree (exact or subpath);
 *    otherwise → the "not tracked" error.
 *  - a path whose own workspace is OUT OF SCOPE returns the SAME "not tracked"
 *    error as an unknown path, so scope membership never leaks.
 *  - the git cwd is an EXISTING, IN-SCOPE worktree of the repo (the provided one
 *    preferred, else a live sibling), so a stale (deleted) path still resolves
 *    and git never runs in a worktree the client may not observe.
 *
 * Reads `db` synchronously; the caller closes the handle BEFORE the (async) git
 * work so no DB lock is held across git.
 */
export function resolveTrackedWorkspaceRepo(
  db: Database.Database,
  repoPath: string,
  allowed: readonly string[],
): ResolveTrackedRepoResult {
  const notTracked = (): { error: HarnessMcpToolResult } => ({
    error: errorResult(`${repoPath} is not a tracked workspace worktree`, {
      repoPath,
    }),
  });

  const target = normalizeWorktreePath(repoPath);
  // cap-free path match: a tracked worktree must never be missed by a row cap.
  const tracked = matchTrackedWorktree(
    new WorkspaceRepository(db).listWorktreePaths(),
    target,
  );
  if (tracked === undefined) return notTracked();

  const data = readWorkspaceStatusData(db, tracked.repoPath);
  const projectOf = (r: WorkspaceRecord): string | null =>
    r.goalId !== null ? (data.goalInfo.get(r.goalId)?.projectId ?? null) : null;
  const include =
    allowed.length === 0
      ? undefined
      : (r: WorkspaceRecord | null, projectId: string | null): boolean =>
          projectId !== null && allowed.includes(projectId);

  // re-find the matched ROW within the repo's (unbounded) rows for the scope
  // check + cwd selection.
  const matchedRow = matchTrackedWorktree(data.rows, target);
  if (matchedRow === undefined) return notTracked();
  // scope check on the MATCHED row BEFORE confirming it is tracked.
  if (include !== undefined && !include(matchedRow, projectOf(matchedRow))) {
    return notTracked();
  }

  // git cwd: the matched worktree, else any VISIBLE sibling that still exists on
  // disk — never an out-of-scope worktree the client may not observe.
  const visibleRows =
    include === undefined
      ? data.rows
      : data.rows.filter((r) => include(r, projectOf(r)));
  const gitCwd = [
    matchedRow.worktreePath,
    ...visibleRows.map((r) => r.worktreePath),
  ].find((p) => existsSync(p));
  if (gitCwd === undefined) {
    return {
      error: errorResult(`no live worktree on disk for ${repoPath}`, {
        repoPath,
      }),
    };
  }

  return {
    ok: {
      repoKey: tracked.repoPath,
      gitCwd,
      data,
      ...(include !== undefined ? { include } : {}),
      projectOf,
    },
  };
}
