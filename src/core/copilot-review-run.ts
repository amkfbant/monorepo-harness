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

  // --- request phase: retry transient errors up to requestAttempts. ---
  let attempts = 0;
  let lastError = "";
  let requested = false;
  while (attempts < config.requestAttempts) {
    attempts += 1;
    try {
      await input.reviewer.request(input.prNumber);
      requested = true;
      break;
    } catch (e) {
      lastError = (e as Error).message;
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
  let polls = 0;
  // The first poll happens immediately; subsequent ones after each interval.
  // The clock is advanced by sleep(); the loop is bounded by the deadline.
  for (;;) {
    polls += 1;
    try {
      const result = await input.reviewer.poll(input.prNumber);
      if (result === "reviewed") {
        return { status: "reviewed", attempts, polls, detail: "Copilot review posted" };
      }
    } catch {
      // best-effort: a transient poll error is swallowed; keep polling.
    }
    if (now() >= deadline) {
      return {
        status: "skipped",
        attempts,
        polls,
        detail: `Copilot review timed out after ${config.pollTimeoutMs}ms`,
      };
    }
    await sleep(config.pollIntervalMs);
    if (now() >= deadline) {
      return {
        status: "skipped",
        attempts,
        polls,
        detail: `Copilot review timed out after ${config.pollTimeoutMs}ms`,
      };
    }
  }
}
