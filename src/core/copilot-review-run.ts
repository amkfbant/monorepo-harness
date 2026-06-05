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
 * Normalize a (possibly partial / hostile) config into a sane, terminating
 * shape. Immutable — returns a new object. Bad numeric inputs (NaN, Infinity,
 * negatives, non-integers) would otherwise corrupt deadline math or spin a
 * busy-loop; we clamp them to defaults so the run always converges.
 *
 * - `requestAttempts`: integer ≥ 1, else default 3.
 * - `pollTimeoutMs`: finite ≥ 0, else default 300_000 (NaN deadline → never).
 * - `pollIntervalMs`: finite (any value ≥ 0 stays as-is, including 0 which means
 *   "do not sleep but still terminate via the deadline re-check"); only
 *   negative / NaN / Infinity fall back to default 15_000 to avoid busy-loop /
 *   non-convergence. 0 is intentionally preserved (FAST_CONFIG immediate
 *   convergence) and is safe because pollTimeoutMs is finite.
 */
function normalizeConfig(
  partial: Partial<CopilotReviewConfig> | undefined,
): CopilotReviewConfig {
  const merged: CopilotReviewConfig = { ...DEFAULT_CONFIG, ...partial };
  const requestAttempts =
    Number.isInteger(merged.requestAttempts) && merged.requestAttempts >= 1
      ? merged.requestAttempts
      : DEFAULT_CONFIG.requestAttempts;
  const pollTimeoutMs =
    Number.isFinite(merged.pollTimeoutMs) && merged.pollTimeoutMs >= 0
      ? merged.pollTimeoutMs
      : DEFAULT_CONFIG.pollTimeoutMs;
  const pollIntervalMs =
    Number.isFinite(merged.pollIntervalMs) && merged.pollIntervalMs >= 0
      ? merged.pollIntervalMs
      : DEFAULT_CONFIG.pollIntervalMs;
  return { requestAttempts, pollTimeoutMs, pollIntervalMs };
}

/** Safely stringify an unknown thrown value (a reject is not always an Error). */
function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Best-effort Copilot review orchestration. NEVER throws — always resolves to
 * an outcome. The result is observational only: callers MUST NOT gate any state
 * transition on it (close / merge stay independent — existing safety boundary).
 *
 * - `request` の一時エラーは `requestAttempts` まで retry。全失敗 → failed。
 * - request 成功後 **最低 1 回は poll** する。`reviewed` → reviewed。
 *   その後 `now() >= deadline` なら skipped。さもなくば `pollIntervalMs` sleep して
 *   再判定 → poll。`pollTimeoutMs=0` は「1 回だけ観測して reviewed か skipped」。
 * - 各 poll は残り時間（`deadline - now()`）を `timeoutMs` として渡す。gh adapter は
 *   その残り時間で子プロセスを自己 kill するため、hang した poll も総タイムアウト内に
 *   収束する（内部 setTimeout race は不要 = timer leak 源を作らない）。
 * - poll の一時エラー / hang は握って次の interval へ（best-effort）。
 *
 * 最終防衛として関数本体全体（`config`/`sleep`/`now` の初期化を含む）を try/catch で
 * 包む。throwing な getter / 注入された `sleep`・`now` が throw しても failed を返し、
 * 関数外へ reject しない。
 */
export async function runCopilotReview(input: {
  reviewer: CopilotReviewer;
  prNumber: number;
  config?: Partial<CopilotReviewConfig>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<CopilotReviewOutcome> {
  // Thin never-reject wrapper: ANY throw — including from reading `input.config`
  // via a throwing getter, or from building `sleep` / `now` — degrades to a
  // failed outcome instead of escaping the best-effort contract.
  try {
    return await runCopilotReviewInner(input);
  } catch (e) {
    return {
      status: "failed",
      attempts: 0,
      polls: 0,
      detail: `Copilot review aborted unexpectedly: ${toErrorMessage(e)}`,
    };
  }
}

async function runCopilotReviewInner(input: {
  reviewer: CopilotReviewer;
  prNumber: number;
  config?: Partial<CopilotReviewConfig>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<CopilotReviewOutcome> {
  const config = normalizeConfig(input.config);
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => Date.now());

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

    // --- poll phase: at least one poll, then poll until reviewed or timeout. ---
    const deadline = now() + config.pollTimeoutMs;
    const skipped = (): CopilotReviewOutcome => ({
      status: "skipped",
      attempts,
      polls,
      detail: `Copilot review timed out after ${config.pollTimeoutMs}ms`,
    });
    // The first poll always runs (even at pollTimeoutMs=0 → "observe once").
    // Each poll receives the remaining budget so the gh adapter bounds itself;
    // we just await it (its exception is swallowed best-effort). No internal
    // setTimeout race → no timer to leak.
    for (;;) {
      polls += 1;
      try {
        // Remaining budget bounds the gh child. When it is already exhausted
        // (remaining <= 0 — e.g. pollTimeoutMs=0 on the mandatory first poll),
        // pass `undefined` so the adapter uses its own default timeout instead
        // of Math.max(1, 0)=1ms, which would SIGKILL gh before it can observe a
        // posted review. A positive remaining is passed through as the bound.
        const remainingMs = deadline - now();
        const result = await input.reviewer.poll(
          input.prNumber,
          remainingMs > 0 ? remainingMs : undefined,
        );
        if (result === "reviewed") {
          return { status: "reviewed", attempts, polls, detail: "Copilot review posted" };
        }
        // "pending": fall through to the deadline re-check.
      } catch {
        // best-effort: a transient poll error / timeout is swallowed; keep going.
      }
      if (now() >= deadline) return skipped();
      // Clamp the sleep to the remaining budget so an interval larger than the
      // total timeout (pollTimeoutMs < pollIntervalMs) cannot overshoot it.
      const remainingBeforeSleep = deadline - now();
      await sleep(Math.min(config.pollIntervalMs, Math.max(0, remainingBeforeSleep)));
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
