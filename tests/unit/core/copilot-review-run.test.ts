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
