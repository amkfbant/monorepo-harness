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

/** The subset of an orchestration result the await-merge mapping reads. */
export interface OrchestrationStepResult {
  outcome: string;
  finalDecision: string;
  prUrl?: string;
  escalateReason?: string;
}

/**
 * Map ONE orchestrator step's result (run on a close_ready goal, so it dispatched
 * the close/merge action) to an await-merge step. `merged` → done; `pr_created`
 * → PR open awaiting CI (keep polling); `escalated` → human needed; anything
 * else (stop / max_steps) → nothing left to await. Pure, so the CLI's mapping is
 * unit-tested without a live gh/codex.
 */
export function awaitStepFromOutcome(
  result: OrchestrationStepResult,
): AwaitMergeStep {
  if (result.outcome === "merged") {
    return {
      kind: "merged",
      ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
    };
  }
  if (result.outcome === "escalated") {
    return {
      kind: "escalated",
      ...(result.escalateReason !== undefined
        ? { reason: result.escalateReason }
        : {}),
    };
  }
  if (result.outcome === "pr_created") {
    return {
      kind: "awaiting",
      ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
    };
  }
  return { kind: "not_awaiting", decision: result.finalDecision };
}

export interface AwaitMergeDeps {
  /** evaluate + run at most the close/merge step once; never runs coder/review. */
  pollOnce: () => Promise<AwaitMergeStep>;
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
    const step = await deps.pollOnce();
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
