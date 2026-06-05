import type {
  CopilotReviewer,
  CopilotReviewPollResult,
} from "./copilot-reviewer.js";

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

/**
 * Node's `setTimeout` silently truncates a delay larger than the signed 32-bit
 * max to 1ms (≈ a busy-loop). Any timer-bound config value above this is hostile
 * input: we fall back to the default rather than let it round down to 1ms.
 */
const MAX_TIMER_MS = 2_147_483_647;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Internal watchdog: a Promise that rejects after `ms`, guarding the DI boundary
 * so an alternate `CopilotReviewer.poll` that ignores `timeoutMs` and hangs can
 * never make `runCopilotReview` await forever. The timer is ALWAYS cleared in
 * `finally` and is `.unref()`ed so it neither leaks nor keeps the process alive
 * (the prior race was removed for exactly that leak; this reinstates it safely).
 */
function rejectAfter(ms: number): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`poll watchdog tripped after ${ms}ms`));
    }, ms);
    timer.unref?.();
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Normalize a (possibly partial / hostile) config into a sane, terminating
 * shape. Immutable — returns a new object. Bad numeric inputs (NaN, Infinity,
 * negatives, non-integers) would otherwise corrupt deadline math or spin a
 * busy-loop; we clamp them to defaults so the run always converges.
 *
 * - `requestAttempts`: integer ≥ 1, else default 3.
 * - `pollTimeoutMs`: finite, ≥ 0, and ≤ MAX_TIMER_MS, else default 300_000
 *   (a NaN deadline → never; a value above the 32-bit timer max would be
 *   truncated to 1ms by Node's `setTimeout`, so it is rejected too).
 * - `pollIntervalMs`: depends on `pollTimeoutMs` (computed AFTER it):
 *   - when `pollTimeoutMs === 0` (single-observation / FAST_CONFIG): 0 is
 *     preserved (one poll, then the deadline re-check terminates). Any other
 *     finite ≥ 0, ≤ MAX_TIMER_MS value is preserved as well.
 *   - when `pollTimeoutMs > 0`: a busy-loop interval (≤ 0 / NaN / Infinity /
 *     > MAX_TIMER_MS) FALLS BACK to the default 15_000 so a positive timeout
 *     never spins a 0ms / 1ms-truncated poll loop.
 */
function normalizeConfig(
  partial: Partial<CopilotReviewConfig> | undefined,
): CopilotReviewConfig {
  const merged: CopilotReviewConfig = { ...DEFAULT_CONFIG, ...partial };
  const requestAttempts =
    Number.isInteger(merged.requestAttempts) && merged.requestAttempts >= 1
      ? merged.requestAttempts
      : DEFAULT_CONFIG.requestAttempts;
  const pollTimeoutMs = isUsableTimerMs(merged.pollTimeoutMs)
    ? merged.pollTimeoutMs
    : DEFAULT_CONFIG.pollTimeoutMs;
  // pollIntervalMs floor is conditional on the (already-normalized) timeout:
  // a 0 timeout means "observe once" and tolerates a 0 interval; a positive
  // timeout must never pair with a busy-loop interval (≤ 0 / NaN / Inf / huge).
  let pollIntervalMs: number;
  if (pollTimeoutMs === 0) {
    pollIntervalMs = isUsableTimerMs(merged.pollIntervalMs)
      ? merged.pollIntervalMs
      : DEFAULT_CONFIG.pollIntervalMs;
  } else {
    pollIntervalMs =
      isUsableTimerMs(merged.pollIntervalMs) && merged.pollIntervalMs > 0
        ? merged.pollIntervalMs
        : DEFAULT_CONFIG.pollIntervalMs;
  }
  return { requestAttempts, pollTimeoutMs, pollIntervalMs };
}

/**
 * A timer value usable as-is: an integer, ≥ 0, and within Node's 32-bit timer
 * max. A non-integer (e.g. 0.5ms) paired with a positive timeout would drive a
 * sub-ms-grain high-frequency poll loop, so it is rejected (falls back to the
 * default in `normalizeConfig`). `Number.isInteger` also subsumes the finite
 * check (NaN / ±Infinity are not integers). 0 stays usable (FAST_CONFIG).
 */
function isUsableTimerMs(ms: number): boolean {
  return Number.isInteger(ms) && ms >= 0 && ms <= MAX_TIMER_MS;
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
 *   その残り時間で子プロセスを自己 kill する。加えて、残り時間 > 0 の poll は内部
 *   watchdog（`rejectAfter` の `Promise.race`）で包み、`timeoutMs` を無視して hang する
 *   代替 reviewer でも総タイムアウト内に必ず収束させる（watchdog timer は `finally` で
 *   clear + `.unref()` ＝ leak / プロセス終了阻害を作らない）。
 * - poll の一時エラー / hang / watchdog reject は握って次の interval へ（best-effort）。
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
    // Each poll receives the remaining budget so the gh adapter bounds itself.
    // For a positive remaining budget we ALSO wrap the call in an internal
    // watchdog (Promise.race with rejectAfter) so an alternate reviewer that
    // ignores `timeoutMs` and hangs cannot make us await forever; the watchdog
    // timer is always cleared and `.unref()`ed (no leak). The race reject is
    // swallowed best-effort → next loop → deadline → skipped.
    for (;;) {
      polls += 1;
      try {
        // Remaining budget bounds the gh child. When it is already exhausted
        // (remaining <= 0 — e.g. pollTimeoutMs=0 on the mandatory first poll),
        // pass `undefined` so the adapter uses its own default timeout instead
        // of Math.max(1, 0)=1ms, which would SIGKILL gh before it can observe a
        // posted review. A positive remaining is passed through as the bound.
        const remainingMs = deadline - now();
        let result: CopilotReviewPollResult;
        if (remainingMs > 0) {
          // Watchdog only for a positive budget. The single-observation path
          // (remaining <= 0) is awaited directly so FAST_CONFIG / pollTimeoutMs=0
          // never depends on a watchdog timer.
          const watchdog = rejectAfter(remainingMs);
          try {
            result = await Promise.race([
              input.reviewer.poll(input.prNumber, remainingMs),
              watchdog.promise,
            ]);
          } finally {
            watchdog.cancel();
          }
        } else {
          result = await input.reviewer.poll(input.prNumber, undefined);
        }
        if (result === "reviewed") {
          return { status: "reviewed", attempts, polls, detail: "Copilot review posted" };
        }
        // "pending": fall through to the deadline re-check.
      } catch {
        // best-effort: a transient poll error / timeout / watchdog reject is
        // swallowed; keep going (deadline re-check terminates the loop).
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
