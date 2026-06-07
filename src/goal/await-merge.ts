/**
 * Pure poll-loop that drives a `close_ready` goal's open PR to a merge — the
 * deterministic core behind `harness goal await-merge`. It owns NO side effects:
 * each iteration calls an injected `pollOnce` (which re-evaluates convergence and
 * runs at most the single close/merge step), sleeps, and re-checks. State
 * transitions remain harness-only inside `pollOnce`; this loop just decides when
 * to keep waiting vs stop. Decoupled from the orchestrator's own outcome naming
 * so it stays trivially testable with a virtual clock.
 */

/** One probe of the goal's merge readiness (mapped from an orchestrate step). */
export type AwaitMergeStep =
  /** the PR merged → goal closed */
  | { kind: "merged"; prUrl?: string }
  /** PR open, awaiting CI (recheckable) — keep polling */
  | { kind: "awaiting"; prUrl?: string }
  /** the merge gate hard-blocked / a runner threw → human needed */
  | { kind: "escalated"; reason?: string }
  /** the goal is not `close_ready` (e.g. needs_fix/continue) → nothing to await */
  | { kind: "not_awaiting"; decision: string };

export type AwaitMergeOutcome =
  | { outcome: "merged"; polls: number; prUrl?: string }
  | { outcome: "escalated"; polls: number; reason?: string }
  | { outcome: "timeout"; polls: number }
  | { outcome: "not_awaiting"; polls: number; decision: string };

/** The subset of a `closeAndPr` runner result the await-merge mapping reads. */
export interface CloseStepResult {
  prUrl?: string;
  merged?: boolean;
  escalateReason?: string;
}

/**
 * Map ONE close/merge step's result (the `closeAndPr` runner, the only action
 * await-merge ever runs) to an await step. `escalateReason` → human needed;
 * `merged: true` → done; otherwise the PR is open (CI not yet green, or a
 * permanent close for a human merge) → `awaiting`. The permanent-close case
 * terminates on the NEXT poll, whose convergence re-check sees a non-close_ready
 * goal and returns `not_awaiting`. Pure, so the mapping is unit-tested without a
 * live gh/codex.
 */
export function awaitStepFromCloseResult(
  result: CloseStepResult,
): AwaitMergeStep {
  if (result.escalateReason !== undefined) {
    return { kind: "escalated", reason: result.escalateReason };
  }
  if (result.merged === true) {
    return {
      kind: "merged",
      ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
    };
  }
  return {
    kind: "awaiting",
    ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
  };
}

export interface AwaitMergeDeps {
  /**
   * Evaluate convergence and run AT MOST the close/merge step once; never runs
   * coder/review. `remainingMs` is the wall-clock budget left, so the attempt can
   * clamp its own CI await to it (an attempt must not block past the budget).
   */
  pollOnce: (remainingMs: number) => Promise<AwaitMergeStep>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface AwaitMergeOpts {
  pollIntervalMs: number;
  /** total wall-clock budget; 0 = a single check (no waiting). */
  maxWaitMs: number;
}

export async function awaitGoalMerge(
  deps: AwaitMergeDeps,
  opts: AwaitMergeOpts,
): Promise<AwaitMergeOutcome> {
  if (!(opts.pollIntervalMs > 0)) {
    throw new Error(
      `pollIntervalMs must be a positive number (got ${opts.pollIntervalMs})`,
    );
  }
  if (!(opts.maxWaitMs >= 0)) {
    throw new Error(
      `maxWaitMs must be a non-negative number (got ${opts.maxWaitMs})`,
    );
  }

  const start = deps.now();
  let polls = 0;
  for (;;) {
    // budget gate BEFORE starting a new attempt: once the wall-clock budget is
    // spent, do not begin another (possibly long, CI-awaiting) attempt. The very
    // first attempt always runs (so maxWaitMs=0 still does a single check).
    const remaining = opts.maxWaitMs - (deps.now() - start);
    if (polls > 0 && remaining <= 0) return { outcome: "timeout", polls };
    const step = await deps.pollOnce(Math.max(0, remaining));
    polls += 1;
    if (step.kind === "merged") {
      return {
        outcome: "merged",
        polls,
        ...(step.prUrl !== undefined ? { prUrl: step.prUrl } : {}),
      };
    }
    if (step.kind === "escalated") {
      return {
        outcome: "escalated",
        polls,
        ...(step.reason !== undefined ? { reason: step.reason } : {}),
      };
    }
    if (step.kind === "not_awaiting") {
      return { outcome: "not_awaiting", polls, decision: step.decision };
    }
    // awaiting → keep polling until the wall-clock budget is spent.
    const elapsed = deps.now() - start;
    if (elapsed >= opts.maxWaitMs) return { outcome: "timeout", polls };
    await deps.sleep(Math.min(opts.pollIntervalMs, opts.maxWaitMs - elapsed));
  }
}
