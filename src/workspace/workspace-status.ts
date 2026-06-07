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
  if (input.stale) return "stale";

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
  const g = input.git;
  if (g === null) return "clean";
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
