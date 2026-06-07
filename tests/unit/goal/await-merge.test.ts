import { describe, it, expect } from "vitest";
import {
  awaitGoalMerge,
  awaitStepFromCloseResult,
  type AwaitMergeStep,
} from "../../../src/goal/await-merge.js";

/** A deterministic clock + sleep that advances virtual time by each sleep. */
function fakeClock(startMs = 0): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
} {
  let t = startMs;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

/** A pollOnce that returns the given scripted steps in order. */
function scripted(steps: AwaitMergeStep[]): {
  pollOnce: () => Promise<AwaitMergeStep>;
  calls: () => number;
} {
  let i = 0;
  return {
    pollOnce: async () => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return step;
    },
    calls: () => i,
  };
}

describe("awaitGoalMerge", () => {
  it("returns merged on the first poll without sleeping", async () => {
    const clock = fakeClock();
    const poll = scripted([{ kind: "merged", prUrl: "http://pr/1" }]);
    const out = await awaitGoalMerge(
      { pollOnce: poll.pollOnce, sleep: clock.sleep, now: clock.now },
      { pollIntervalMs: 1000, maxWaitMs: 10_000 },
    );
    expect(out).toEqual({ outcome: "merged", polls: 1, prUrl: "http://pr/1" });
    expect(clock.sleeps).toEqual([]); // no wait when it merges immediately
  });

  it("polls again after an awaiting step, then merges", async () => {
    const clock = fakeClock();
    const poll = scripted([
      { kind: "awaiting", prUrl: "http://pr/2" },
      { kind: "awaiting", prUrl: "http://pr/2" },
      { kind: "merged", prUrl: "http://pr/2" },
    ]);
    const out = await awaitGoalMerge(
      { pollOnce: poll.pollOnce, sleep: clock.sleep, now: clock.now },
      { pollIntervalMs: 500, maxWaitMs: 10_000 },
    );
    expect(out.outcome).toBe("merged");
    expect(out.polls).toBe(3);
    expect(clock.sleeps).toEqual([500, 500]); // slept between the awaiting polls
  });

  it("stops immediately when the goal is not awaiting (not close_ready)", async () => {
    const clock = fakeClock();
    const poll = scripted([{ kind: "not_awaiting", decision: "needs_fix" }]);
    const out = await awaitGoalMerge(
      { pollOnce: poll.pollOnce, sleep: clock.sleep, now: clock.now },
      { pollIntervalMs: 500, maxWaitMs: 10_000 },
    );
    expect(out).toEqual({
      outcome: "not_awaiting",
      polls: 1,
      decision: "needs_fix",
    });
    expect(clock.sleeps).toEqual([]);
  });

  it("stops and surfaces an escalation", async () => {
    const clock = fakeClock();
    const poll = scripted([
      { kind: "awaiting" },
      { kind: "escalated", reason: "gate hard-blocked" },
    ]);
    const out = await awaitGoalMerge(
      { pollOnce: poll.pollOnce, sleep: clock.sleep, now: clock.now },
      { pollIntervalMs: 500, maxWaitMs: 10_000 },
    );
    expect(out).toEqual({
      outcome: "escalated",
      polls: 2,
      reason: "gate hard-blocked",
    });
  });

  it("times out when the PR never merges within maxWaitMs", async () => {
    const clock = fakeClock();
    const poll = scripted([{ kind: "awaiting" }]); // always awaiting
    const out = await awaitGoalMerge(
      { pollOnce: poll.pollOnce, sleep: clock.sleep, now: clock.now },
      { pollIntervalMs: 1000, maxWaitMs: 2500 },
    );
    expect(out.outcome).toBe("timeout");
    // polls at t=0, t=1000, t=2000 (sleeping 1000,1000,500 → t=2500); the next
    // iteration's pre-poll budget gate (remaining 0) stops WITHOUT a 4th attempt.
    expect(clock.sleeps).toEqual([1000, 1000, 500]);
    expect(out.polls).toBe(3);
  });

  it("single-shot (maxWaitMs=0): one poll, no sleep, then timeout if still awaiting", async () => {
    const clock = fakeClock();
    const poll = scripted([{ kind: "awaiting" }]);
    const out = await awaitGoalMerge(
      { pollOnce: poll.pollOnce, sleep: clock.sleep, now: clock.now },
      { pollIntervalMs: 1000, maxWaitMs: 0 },
    );
    expect(out).toEqual({ outcome: "timeout", polls: 1 });
    expect(clock.sleeps).toEqual([]);
  });

  it("rejects a non-positive poll interval", async () => {
    const clock = fakeClock();
    const poll = scripted([{ kind: "merged" }]);
    await expect(
      awaitGoalMerge(
        { pollOnce: poll.pollOnce, sleep: clock.sleep, now: clock.now },
        { pollIntervalMs: 0, maxWaitMs: 1000 },
      ),
    ).rejects.toThrow(/pollIntervalMs/);
  });

  it("rejects a negative max wait", async () => {
    const clock = fakeClock();
    const poll = scripted([{ kind: "merged" }]);
    await expect(
      awaitGoalMerge(
        { pollOnce: poll.pollOnce, sleep: clock.sleep, now: clock.now },
        { pollIntervalMs: 1000, maxWaitMs: -1 },
      ),
    ).rejects.toThrow(/maxWaitMs/);
  });
});

describe("awaitStepFromCloseResult", () => {
  it("maps merged:true → merged (carrying the PR url)", () => {
    expect(
      awaitStepFromCloseResult({ merged: true, prUrl: "http://pr/9" }),
    ).toEqual({ kind: "merged", prUrl: "http://pr/9" });
  });

  it("maps a not-yet-merged PR → awaiting (PR open, still needs CI)", () => {
    expect(
      awaitStepFromCloseResult({ merged: false, prUrl: "http://pr/9" }),
    ).toEqual({ kind: "awaiting", prUrl: "http://pr/9" });
  });

  it("escalateReason wins even if merged is absent → escalated", () => {
    expect(
      awaitStepFromCloseResult({
        prUrl: "",
        escalateReason: "gate hard-blocked: ci_not_green",
      }),
    ).toEqual({ kind: "escalated", reason: "gate hard-blocked: ci_not_green" });
  });
});
