/**
 * Cross-agent conflict pre-check (B#4). Given each agent workspace's set of
 * changed files, find pairs of agents that touch the SAME file — the early
 * warning for "we don't usually edit the same files" in a multi-agent run.
 * Pure: deterministic set intersection, no git/IO.
 */

export interface WorkspaceChangedFiles {
  agent: string;
  files: readonly string[];
}

export interface WorkspaceConflict {
  a: string;
  b: string;
  /** files changed by BOTH agents (sorted, deduped). */
  files: string[];
}

/**
 * All pairs of agents whose changed-file sets overlap, with the shared files.
 * Pairs are emitted once (a < b by agent name) and sorted for determinism.
 */
export function findWorkspaceConflicts(
  entries: readonly WorkspaceChangedFiles[],
): WorkspaceConflict[] {
  // normalize: one deduped file set per agent (skip agents with no changes).
  const sets = entries
    .map((e) => ({ agent: e.agent, files: new Set(e.files) }))
    .filter((e) => e.files.size > 0)
    .sort((x, y) => x.agent.localeCompare(y.agent));

  const conflicts: WorkspaceConflict[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      const shared = [...a.files].filter((f) => b.files.has(f)).sort();
      if (shared.length > 0) {
        conflicts.push({ a: a.agent, b: b.agent, files: shared });
      }
    }
  }
  return conflicts;
}
