import type { CopilotReviewer } from "./copilot-reviewer.js";

export interface CopilotReviewConfig {
  /** request の一時エラー retry 上限（既定 3）。 */
  requestAttempts: number;
  /** poll の総タイムアウト（既定 300_000 = 5 分）。 */
  pollTimeoutMs: number;
  /** poll 間隔（既定 15_000）。 */
  pollIntervalMs: number;
}

export type CopilotReviewStatus = "reviewed" | "skipped" | "failed";

export interface CopilotReviewOutcome {
  status: CopilotReviewStatus;
  /** 実 request 試行回数。 */
  attempts: number;
  /** 実 poll 回数。 */
  polls: number;
  /** 人間可読の要約。 */
  detail: string;
}

const DEFAULT_CONFIG: CopilotReviewConfig = {
  requestAttempts: 3,
  pollTimeoutMs: 300_000,
  pollIntervalMs: 15_000,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Safely stringify an unknown thrown value (a reject is not always an Error). */
function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A unique sentinel resolved when a poll exceeds its remaining time budget. */
const POLL_DEADLINE = Symbol("poll-deadline");

/**
 * Reject-free timeout: resolves to {@link POLL_DEADLINE} after `ms`. Uses a raw
 * `setTimeout` (not the injected `sleep`) so a hanging poll is bounded by wall
 * time even when `sleep` is a fake clock. The timer is `unref`'d so it never
 * keeps the process alive.
 */
function deadlineAfter(ms: number): Promise<typeof POLL_DEADLINE> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(POLL_DEADLINE), Math.max(0, ms));
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Best-effort Copilot review orchestration. NEVER throws — always resolves to
 * an outcome. The result is observational only: callers MUST NOT gate any state
 * transition on it (close / merge stay independent — existing safety boundary).
 *
 * - `request` の一時エラーは `requestAttempts` まで retry。全失敗 → failed。
 * - request 成功後、`pollTimeoutMs` まで `pollIntervalMs` 間隔で poll。
 *   reviewed → reviewed。timeout（pending のまま）→ skipped。
 * - poll の一時エラーは握って次の interval へ（best-effort）。
 */
export async function runCopilotReview(input: {
  reviewer: CopilotReviewer;
  prNumber: number;
  config?: Partial<CopilotReviewConfig>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<CopilotReviewOutcome> {
  const config: CopilotReviewConfig = { ...DEFAULT_CONFIG, ...input.config };
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => Date.now());

  // Final defense: the best-effort contract is that this function NEVER throws.
  // Any unexpected throw — including from the injected `sleep` / `now`, or the
  // poll-timeout machinery — degrades to a `failed` outcome instead of escaping.
  let attempts = 0;
  let polls = 0;
  try {
    // --- request phase: retry transient errors up to requestAttempts. ---
    let lastError = "";
    let requested = false;
    while (attempts < config.requestAttempts) {
      attempts += 1;
      try {
        await input.reviewer.request(input.prNumber);
        requested = true;
        break;
      } catch (e) {
        lastError = toErrorMessage(e);
        if (attempts < config.requestAttempts) {
          await sleep(config.pollIntervalMs);
        }
      }
    }
    if (!requested) {
      return {
        status: "failed",
        attempts,
        polls: 0,
        detail: `could not request Copilot review after ${attempts} attempts: ${lastError}`,
      };
    }

    // --- poll phase: poll until reviewed or the timeout elapses. ---
    const deadline = now() + config.pollTimeoutMs;
    const skipped = (): CopilotReviewOutcome => ({
      status: "skipped",
      attempts,
      polls,
      detail: `Copilot review timed out after ${config.pollTimeoutMs}ms`,
    });
    // The first poll happens immediately; subsequent ones after each interval.
    // The clock is advanced by sleep(); the loop is bounded by the deadline.
    for (;;) {
      if (now() >= deadline) return skipped();
      polls += 1;
      try {
        // Bound the poll by the remaining budget so a hanging `poll` cannot blow
        // past `pollTimeoutMs`. The timeout branch is treated as still-pending.
        const remainingMs = deadline - now();
        const result = await Promise.race([
          input.reviewer.poll(input.prNumber),
          deadlineAfter(remainingMs),
        ]);
        if (result === "reviewed") {
          return { status: "reviewed", attempts, polls, detail: "Copilot review posted" };
        }
        // POLL_DEADLINE or "pending": fall through to the deadline re-check.
      } catch {
        // best-effort: a transient poll error is swallowed; keep polling.
      }
      if (now() >= deadline) return skipped();
      await sleep(config.pollIntervalMs);
      if (now() >= deadline) return skipped();
    }
  } catch (e) {
    return {
      status: "failed",
      attempts,
      polls,
      detail: `Copilot review aborted unexpectedly: ${toErrorMessage(e)}`,
    };
  }
}
