import { describe, it, expect } from "vitest";
import { runCopilotReview } from "../../../src/core/copilot-review-run.js";
import type { CopilotReviewer } from "../../../src/core/copilot-reviewer.js";

/** A fake reviewer scripted by per-call behaviour, recording call counts. */
function fakeReviewer(opts: {
  request: Array<"ok" | "throw">;
  poll: Array<"reviewed" | "pending" | "throw">;
}): CopilotReviewer & {
  requestCalls: number;
  pollCalls: number;
  pollTimeouts: Array<number | undefined>;
} {
  const state = {
    requestCalls: 0,
    pollCalls: 0,
    pollTimeouts: [] as Array<number | undefined>,
  };
  return {
    get requestCalls() {
      return state.requestCalls;
    },
    get pollCalls() {
      return state.pollCalls;
    },
    get pollTimeouts() {
      return state.pollTimeouts;
    },
    async request() {
      const verb = opts.request[state.requestCalls] ?? "ok";
      state.requestCalls += 1;
      if (verb === "throw") throw new Error("gh transient");
    },
    async poll(_pr: number, timeoutMs?: number) {
      const verb = opts.poll[state.pollCalls] ?? "pending";
      state.pollCalls += 1;
      state.pollTimeouts.push(timeoutMs);
      if (verb === "throw") throw new Error("gh transient");
      return verb;
    },
  };
}

/** A controllable clock: now() advances by `pollIntervalMs` each sleep. */
function fakeClock(stepMs: number) {
  const state = { t: 0 };
  return {
    now: () => state.t,
    sleep: async (ms: number) => {
      state.t += ms === 0 ? stepMs : ms;
    },
  };
}

/**
 * A clock that records every value passed to sleep and advances now() by the
 * exact slept amount (no step substitution). Lets a test assert the cumulative
 * slept time and that each sleep was clamped to the remaining budget.
 */
function recordingClock() {
  const state = { t: 0, slept: [] as number[] };
  return {
    now: () => state.t,
    get slept() {
      return state.slept;
    },
    get total() {
      return state.slept.reduce((a, b) => a + b, 0);
    },
    sleep: async (ms: number) => {
      state.slept.push(ms);
      state.t += ms;
    },
  };
}

describe("runCopilotReview", () => {
  const config = { requestAttempts: 3, pollTimeoutMs: 300_000, pollIntervalMs: 15_000 };

  it("returns reviewed when poll reports reviewed", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["reviewed"] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("reviewed");
    expect(reviewer.requestCalls).toBe(1);
    expect(out.polls).toBeGreaterThanOrEqual(1);
  });

  it("returns skipped when poll stays pending until the timeout (bounded polls)", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: [] }); // default pending
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    // ceil(300000/15000) = 20 polls max — never an unbounded loop.
    expect(reviewer.pollCalls).toBeLessThanOrEqual(20);
    expect(out.detail).toMatch(/timed out/i);
  });

  it("returns failed when request throws on every attempt", async () => {
    const reviewer = fakeReviewer({ request: ["throw", "throw", "throw"], poll: [] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("failed");
    expect(reviewer.requestCalls).toBe(3);
    expect(reviewer.pollCalls).toBe(0);
  });

  it("recovers: request retries a transient error then succeeds", async () => {
    const reviewer = fakeReviewer({ request: ["throw", "ok"], poll: ["reviewed"] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("reviewed");
    expect(reviewer.requestCalls).toBe(2);
  });

  it("swallows a transient poll error and keeps polling until reviewed", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["throw", "pending", "reviewed"] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("reviewed");
    expect(reviewer.pollCalls).toBe(3);
  });

  it("never throws even when both request and poll always throw", async () => {
    const reviewer: CopilotReviewer = {
      async request() {
        throw new Error("boom");
      },
      async poll() {
        throw new Error("boom");
      },
    };
    const clock = fakeClock(15_000);
    // must resolve (not reject) — best-effort contract.
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("failed");
  });

  it("returns failed (never rejects) when request rejects with a non-Error", async () => {
    const reviewer: CopilotReviewer = {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      async request() {
        // a non-Error reject must not crash the (e as Error).message path.
        return Promise.reject(null);
      },
      async poll() {
        return "pending";
      },
    };
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      config: { ...config, requestAttempts: 1 },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("failed");
  });

  it("bounds a poll by the remaining budget and converges to skipped", async () => {
    // The adapter contract: a poll given `timeoutMs` ends within it. This fake
    // resolves to pending after the remaining budget elapses (mirroring a gh
    // child that self-kills at its deadline). With pollTimeoutMs=20 the first
    // poll's remaining budget is ~20ms, after which now() has reached the
    // deadline → skipped. No internal setTimeout race is relied upon.
    let polls = 0;
    const reviewer: CopilotReviewer = {
      async request() {
        /* ok */
      },
      poll(_pr: number, timeoutMs?: number) {
        polls += 1;
        const wait = Math.max(0, timeoutMs ?? 0);
        return new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), wait),
        );
      },
    };
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      config: { requestAttempts: 1, pollTimeoutMs: 20, pollIntervalMs: 0 },
      sleep: async () => {
        /* no-op: real time advances now() */
      },
      now: () => Date.now(),
    });
    expect(out.status).toBe("skipped");
    expect(out.detail).toMatch(/timed out/i);
    expect(polls).toBeGreaterThanOrEqual(1);
  });

  it("pollTimeoutMs=0: polls exactly once and returns reviewed when that poll is reviewed", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["reviewed"] });
    const clock = fakeClock(0);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: { requestAttempts: 1, pollTimeoutMs: 0, pollIntervalMs: 0 },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("reviewed");
    // request success guarantees at least one observation even at timeout 0.
    expect(reviewer.pollCalls).toBe(1);
    // remaining <= 0 on the mandatory first poll → pass undefined so the adapter
    // uses its own default timeout (not Math.max(1,0)=1ms which would SIGKILL gh).
    expect(reviewer.pollTimeouts[0]).toBeUndefined();
  });

  it("pollTimeoutMs=0: polls exactly once and returns skipped when that poll is pending", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["pending"] });
    const clock = fakeClock(0);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: { requestAttempts: 1, pollTimeoutMs: 0, pollIntervalMs: 0 },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    // exactly one observation, then the deadline (now() >= deadline) trips.
    expect(reviewer.pollCalls).toBe(1);
    // remaining <= 0 on the mandatory first poll → undefined timeoutMs.
    expect(reviewer.pollTimeouts[0]).toBeUndefined();
    expect(out.detail).toMatch(/timed out/i);
  });

  it("passes a positive remaining budget as the poll timeoutMs", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["reviewed"] });
    const clock = fakeClock(15_000);
    await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    // the first poll runs at t=0 with the full budget remaining.
    expect(reviewer.pollTimeouts[0]).toBe(300_000);
    expect(reviewer.pollTimeouts[0]).toBeGreaterThan(0);
  });

  it("clamps each sleep to the remaining budget when interval > total timeout", async () => {
    // timeout(1000) < interval(15000): a naive sleep(interval) would overshoot
    // the total timeout 15x. The sleep must be clamped to `deadline - now()` so
    // the cumulative slept time never materially exceeds pollTimeoutMs and the
    // run converges to skipped.
    const reviewer = fakeReviewer({ request: ["ok"], poll: [] }); // always pending
    const clock = recordingClock();
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: { requestAttempts: 1, pollTimeoutMs: 1000, pollIntervalMs: 15_000 },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    // every sleep was clamped to the remaining budget (<= 1000ms), never 15000.
    for (const ms of clock.slept) {
      expect(ms).toBeLessThanOrEqual(1000);
    }
    // total slept time stays within the budget (no 15s overshoot).
    expect(clock.total).toBeLessThanOrEqual(1000);
  });

  it("does not throw or busy-loop when pollIntervalMs is NaN (falls back to default)", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: [] }); // always pending
    const clock = recordingClock();
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      // NaN interval would corrupt deadline math / never converge if unguarded.
      config: { requestAttempts: 1, pollTimeoutMs: 1000, pollIntervalMs: NaN },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    // converged in a bounded number of polls (default 15s interval kicks in).
    expect(reviewer.pollCalls).toBeLessThanOrEqual(5);
  });

  it("does not throw or busy-loop when pollIntervalMs is negative (falls back to default)", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: [] });
    const clock = recordingClock();
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: { requestAttempts: 1, pollTimeoutMs: 1000, pollIntervalMs: -1 },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    for (const ms of clock.slept) {
      expect(ms).toBeGreaterThanOrEqual(0); // never a negative sleep
    }
    expect(reviewer.pollCalls).toBeLessThanOrEqual(5);
  });

  it("does not throw or busy-loop when pollIntervalMs is Infinity (falls back to default)", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: [] });
    const clock = recordingClock();
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: { requestAttempts: 1, pollTimeoutMs: 1000, pollIntervalMs: Infinity },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    expect(reviewer.pollCalls).toBeLessThanOrEqual(5);
  });

  it("treats pollIntervalMs=0 as immediate-convergence (not a busy-loop) and reaches skipped", async () => {
    // 0 is allowed (FAST_CONFIG semantics): no sleep, but the deadline re-check
    // still terminates because pollTimeoutMs is finite. Must NOT fall back to a
    // 15s default (which would slow the orchestrate FAST_CONFIG tests).
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["pending"] });
    const clock = fakeClock(0);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: { requestAttempts: 1, pollTimeoutMs: 0, pollIntervalMs: 0 },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    expect(reviewer.pollCalls).toBe(1);
  });

  it("falls back to a sane requestAttempts when given a non-integer (no throw)", async () => {
    // requestAttempts NaN must not make the while-loop never run or loop forever.
    const reviewer = fakeReviewer({ request: ["throw", "throw", "throw"], poll: [] });
    const clock = recordingClock();
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: { requestAttempts: NaN, pollTimeoutMs: 1000, pollIntervalMs: 0 },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("failed");
    // default 3 attempts.
    expect(reviewer.requestCalls).toBe(3);
  });

  it("falls back to a sane pollTimeoutMs when given a non-finite value (no NaN deadline)", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["reviewed"] });
    const clock = recordingClock();
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: { requestAttempts: 1, pollTimeoutMs: NaN, pollIntervalMs: 0 },
      sleep: clock.sleep,
      now: clock.now,
    });
    // a reviewed first poll still resolves (NaN deadline would have broken the
    // remaining-budget math); it must not throw or hang.
    expect(out.status).toBe("reviewed");
  });

  it("floors pollIntervalMs=0 to the default when pollTimeoutMs>0 (no high-frequency poll)", async () => {
    // P1: pollTimeoutMs=20 with pollIntervalMs=0 must NOT busy-poll (e.g. "20ms
    // → 17 polls"). normalizeConfig floors the 0 interval to 15_000 for a
    // positive timeout, so the 20ms deadline trips after only a couple of polls.
    let polls = 0;
    const reviewer: CopilotReviewer = {
      async request() {
        /* ok */
      },
      poll(_pr: number, timeoutMs?: number) {
        polls += 1;
        // mirror a gh child that self-kills at its (clamped) deadline, then
        // reports pending — so the budget elapses inside the poll itself.
        const wait = Math.max(0, timeoutMs ?? 0);
        return new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), wait),
        );
      },
    };
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      // real timer + real clock: with a 15s floored interval, the 20ms deadline
      // is reached within the mandatory polls (no 0ms busy-loop).
      config: { requestAttempts: 1, pollTimeoutMs: 20, pollIntervalMs: 0 },
      now: () => Date.now(),
    });
    expect(out.status).toBe("skipped");
    // a couple of polls at most — NOT a high-frequency busy-loop.
    expect(polls).toBeLessThanOrEqual(2);
  });

  it("floors a fractional pollIntervalMs to the default when pollTimeoutMs>0 (no sub-ms high-frequency poll)", async () => {
    // P1-3: a non-integer interval (e.g. 0.5ms) paired with a positive timeout
    // would otherwise drive a high-frequency, sub-ms-grain poll loop (10ms /
    // 0.5ms = ~20 polls). normalizeConfig requires Number.isInteger, so 0.5
    // falls back to the 15_000 default (clamped to the 10ms budget) and the
    // deadline trips after only a couple of polls.
    const reviewer = fakeReviewer({ request: ["ok"], poll: [] }); // always pending
    // recordingClock advances now() by the exact slept amount, so an un-floored
    // 0.5ms interval would yield many polls; a floored 15s interval yields ~2.
    const clock = recordingClock();
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      config: { requestAttempts: 1, pollTimeoutMs: 10, pollIntervalMs: 0.5 },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    // a couple of polls at most — NOT a sub-ms high-frequency loop.
    expect(reviewer.pollCalls).toBeLessThanOrEqual(2);
  });

  it("falls back to the default (no 1ms truncation) when pollTimeoutMs exceeds the 32-bit timer max", async () => {
    // P2: a value > MAX_TIMER_MS (2_147_483_647) would be truncated to 1ms by
    // Node's setTimeout. normalizeConfig rejects it → default 300_000, so the
    // run still converges (here: reviewed) without throwing or 1ms-spinning.
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["reviewed"] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: {
        requestAttempts: 1,
        pollTimeoutMs: 2_147_483_647 + 1,
        pollIntervalMs: 0,
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("reviewed");
    // the first poll ran with the (defaulted) 300_000 budget, never ~1ms.
    expect(reviewer.pollTimeouts[0]).toBe(300_000);
  });

  it("falls back to the default when pollIntervalMs exceeds the 32-bit timer max (positive timeout)", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: [] }); // always pending
    const clock = recordingClock();
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config: {
        requestAttempts: 1,
        pollTimeoutMs: 1000,
        pollIntervalMs: 2_147_483_647 + 1,
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    // 15s default interval (clamped to the 1000ms budget) → bounded polls.
    expect(reviewer.pollCalls).toBeLessThanOrEqual(5);
  });

  it("converges to skipped (never hangs/throws) when poll never resolves — internal watchdog", async () => {
    // P2 (DI boundary): an alternate reviewer that ignores timeoutMs and never
    // resolves must NOT make runCopilotReview await forever. The internal
    // watchdog (rejectAfter race) trips at the remaining budget → pending →
    // deadline → skipped. Real small timer; the test itself must not hang.
    let polls = 0;
    const reviewer: CopilotReviewer = {
      async request() {
        /* ok */
      },
      poll() {
        polls += 1;
        // never resolves: only the harness watchdog can end this poll.
        return new Promise<"pending">(() => {});
      },
    };
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      config: { requestAttempts: 1, pollTimeoutMs: 50, pollIntervalMs: 0 },
      now: () => Date.now(),
    });
    expect(out.status).toBe("skipped");
    expect(out.detail).toMatch(/timed out/i);
    expect(polls).toBeGreaterThanOrEqual(1);
  });

  it("zero-timeout (observe-once): never hangs when that single poll never resolves", async () => {
    // pollTimeoutMs=0 takes the single-observation branch (remaining <= 0), which
    // passes `undefined` to the adapter. A contract-violating reviewer that
    // ignores cancellation and never resolves must STILL be bounded by a finite
    // observe-once watchdog — otherwise runCopilotReview (and orchestrate's
    // close/merge) would block forever. `observeOnceTimeoutMs` is the injectable
    // bound; a tiny value keeps the test itself from hanging.
    let polls = 0;
    let observedTimeout: number | undefined = -1;
    const reviewer: CopilotReviewer = {
      async request() {
        /* ok */
      },
      poll(_pr: number, timeoutMs?: number) {
        polls += 1;
        observedTimeout = timeoutMs;
        // never resolves: only the observe-once watchdog can end this poll.
        return new Promise<"pending">(() => {});
      },
    };
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      config: { requestAttempts: 1, pollTimeoutMs: 0, pollIntervalMs: 0 },
      observeOnceTimeoutMs: 40,
      now: () => Date.now(),
    });
    expect(out.status).toBe("skipped");
    expect(out.detail).toMatch(/timed out/i);
    expect(polls).toBe(1);
    // the observe-once poll still receives `undefined` (adapter uses its own
    // default timeout); the harness watchdog is the backstop, not the arg.
    expect(observedTimeout).toBeUndefined();
  });

  it("never rejects even when the injected sleep throws", async () => {
    const reviewer = fakeReviewer({ request: ["throw", "throw", "throw"], poll: [] });
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      config,
      // sleep throwing (e.g. a timer error) must not escape the function.
      sleep: async () => {
        throw new Error("sleep boom");
      },
      now: () => 0,
    });
    expect(out.status).toBe("failed");
  });
});
