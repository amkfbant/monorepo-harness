/**
 * Per-workspace progress projection (W3). A deterministic, scannable status for
 * each agent workspace, derived ONLY from git state + the linked goal's
 * convergence decision (never from the advisory checkpoint note). Used by
 * `harness workspace status` to give a human coordinating several agents an
 * at-a-glance view.
 */

export interface WorkspaceGitState {
  ahead: number;
  behind: number;
  baseResolved: boolean;
  dirtyCount: number;
}

export interface WorkspaceStatusInput {
  agent: string;
  branch: string;
  /** null for a stale entry (DB row whose git worktree is gone). */
  git: WorkspaceGitState | null;
  goalId: string | null;
  /** the goal's convergence decision; null if no goal or a dangling link. */
  goalDecision: string | null;
  objective: string | null;
  lastActiveAt: string | null;
  lastCheckpointAt: string | null;
  stale: boolean;
}

export interface WorkspaceStatus extends WorkspaceStatusInput {
  /** a short scannable label projected from the deterministic signals. */
  label: string;
}

/**
 * A single scannable label, by priority: a missing worktree or goal dominates,
 * then a blocked/needs-work goal, then the working-tree state. Pure.
 */
export function progressLabel(input: WorkspaceStatusInput): string {
  // A missing worktree (explicitly stale, or degenerate null git state) is
  // fail-closed: treat it as `stale` rather than letting it fall through to
  // `clean`, which would contradict how the CLI renders it.
  if (input.stale || input.git === null) return "stale";

  const d = input.goalDecision;
  if (input.goalId !== null && d === null) return "goal-missing";
  if (d !== null) {
    switch (d) {
      case "diverging":
      case "budget_exhausted":
      case "escalate":
        return "blocked";
      case "needs_fix":
      case "needs_classification":
        return "needs-work";
      case "close_ready":
        return "ready-to-close";
      case "continue":
        // the goal is active and needs review / close-check / deferral.
        return "in-progress";
      case "closed":
      case "cancel":
        break; // terminal goal → fall through to the working-tree state.
      default:
        // an unrecognized decision is fail-closed: surface it, never hide it.
        return "blocked";
    }
  }

  // No (live) goal, or a terminal goal: project the working-tree state.
  // (git is non-null here: a null worktree was handled fail-closed above.)
  const g = input.git;
  if (g.dirtyCount > 0) return "dirty";
  // an unresolved base hides ahead/behind — surface it rather than "clean".
  if (!g.baseResolved) return "base-unknown";
  if (g.ahead > 0) return "ahead";
  if (g.behind > 0) return "behind";
  return "clean";
}

export function summarizeWorkspace(
  input: WorkspaceStatusInput,
): WorkspaceStatus {
  return { ...input, label: progressLabel(input) };
}

/**
 * Whether a workspace's heartbeat is stale: no activity for at least
 * `thresholdMs`. Surfaces an abandoned / forgotten agent workspace to a human
 * coordinating several agents. A workspace that has never been active
 * (`lastActiveAt === null`) is NOT treated as stale here — there is no activity
 * window to judge. `now`/threshold are explicit so the check is deterministic.
 */
export function isHeartbeatStale(
  lastActiveAt: string | null,
  nowMs: number,
  thresholdMs: number,
): boolean {
  if (lastActiveAt === null) return false;
  const lastMs = Date.parse(lastActiveAt);
  if (Number.isNaN(lastMs)) return false;
  return nowMs - lastMs >= thresholdMs;
}
