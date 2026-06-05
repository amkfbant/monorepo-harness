import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { GoalRepository } from "../../../src/goal/repository.js";
import { GoalOrchestrator } from "../../../src/goal/orchestrator.js";
import {
  createOrchestratorRunners,
  type GoalRunContext,
} from "../../../src/goal/orchestrator-runners.js";
import { createFakeCodexRunner } from "../../../src/codex/fake-codex-runner.js";
import type {
  PrPublisher,
  PrPublishInputs,
  PrMerger,
  PrMergeInputs,
} from "../../../src/core/pr-creator.js";
import type { CopilotReviewer } from "../../../src/core/copilot-reviewer.js";

/**
 * Copilot review opt-in on the orchestrate close path.
 *
 * These tests inline-duplicate the close_ready setup from
 * `tests/integration/goal-orchestrate.test.ts` (real git + fake codex + fake
 * publisher) and inject `deps.copilotReview` into `createOrchestratorRunners`.
 * The orchestrator drives coder → review → close, and `closeAndPr` runs the
 * best-effort Copilot review after creating the PR. The contract under test:
 * the Copilot outcome (reviewed / skipped / a throwing reviewer) NEVER gates
 * close — the goal always reaches `closed` — and the default (no dep) never
 * requests a review.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

interface Fixture {
  harnessRoot: string;
  dbPath: string;
  repoPath: string;
  bareRemote: string;
}

function setup(): Fixture {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-copilot-orch-"));
  mkdirSync(join(harnessRoot, "policies/repos"), { recursive: true });
  writeFileSync(
    join(harnessRoot, "policies/global.yaml"),
    "always_deny_write: []\nignore_untracked: []\n",
  );
  writeFileSync(
    join(harnessRoot, "policies/repos/t.yaml"),
    [
      "repo_id: t",
      "read: []",
      "domains:",
      "  apps/user:",
      "    read: [apps/user/**]",
      "    write: [apps/user/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );

  const repoPath = mkdtempSync(join(tmpdir(), "harness-copilot-target-"));
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["config", "user.email", "t@e.com"]);
  git(repoPath, ["config", "user.name", "T"]);
  mkdirSync(join(repoPath, "apps/user/src"), { recursive: true });
  writeFileSync(
    join(repoPath, "apps/user/src/profile.ts"),
    "export const x = 0;\n",
  );
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-qm", "init"]);
  const bareRemote =
    mkdtempSync(join(tmpdir(), "harness-copilot-bare-")) + ".git";
  execFileSync("git", ["init", "-q", "--bare", bareRemote]);
  git(repoPath, ["remote", "add", "origin", bareRemote]);
  git(repoPath, ["push", "-q", "-u", "origin", "main"]);

  const dbPath = join(harnessRoot, ".harness", "harness.sqlite");
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  return { harnessRoot, dbPath, repoPath, bareRemote };
}

function createGoal(dbPath: string, goalId: string): string {
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    new GoalRepository(db).createSession({
      goalId,
      title: "Add a field to the user profile",
      description: "bump the exported constant in apps/user",
      repoId: "t",
      domain: "apps/user",
      closeConditions: [
        { id: "review-ok", kind: "review_consensus", required: true },
      ],
      createdBy: "test",
      createdSource: "worker",
    });
    return goalId;
  } finally {
    close();
  }
}

function fakePublisher(): PrPublisher & { calls: PrPublishInputs[] } {
  const calls: PrPublishInputs[] = [];
  return {
    calls,
    async publish(inputs: PrPublishInputs) {
      calls.push(inputs);
      return { url: "https://github.com/acme/repo/pull/42", number: 42 };
    },
  };
}

/** A fake merger that records calls and reports a successful squash merge. */
function fakeMerger(): PrMerger & { calls: PrMergeInputs[] } {
  const calls: PrMergeInputs[] = [];
  return {
    calls,
    async merge(inputs: PrMergeInputs) {
      calls.push(inputs);
      return { merged: true, alreadyMerged: false };
    },
  };
}

/** Coder + reviewer fakes that drive the goal to an approved close_ready. */
function approveFakes() {
  const coderRunner = createFakeCodexRunner({
    edit: async (cwd) => {
      writeFileSync(
        join(cwd, "apps/user/src/profile.ts"),
        "export const x = 1; // implemented\n",
      );
    },
    stdout: "applied 1 file\n",
  });
  const reviewerRunner = createFakeCodexRunner({
    stdout: [
      "```yaml",
      "decision: approved",
      "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "```",
      "",
    ].join("\n"),
  });
  return { coderRunner, reviewerRunner };
}

/** A reviewer that records calls and returns a scripted poll result. */
function recordingReviewer(
  poll: "reviewed" | "pending",
): CopilotReviewer & { requestCalls: number; pollCalls: number } {
  const state = { requestCalls: 0, pollCalls: 0 };
  return {
    get requestCalls() {
      return state.requestCalls;
    },
    get pollCalls() {
      return state.pollCalls;
    },
    async request() {
      state.requestCalls += 1;
    },
    async poll() {
      state.pollCalls += 1;
      return poll;
    },
  };
}

/** Immediate-convergence config: never sleeps, single request attempt. */
const FAST_CONFIG = {
  pollTimeoutMs: 0,
  pollIntervalMs: 0,
  requestAttempts: 1,
};

function resolveRunContext(f: Fixture): () => GoalRunContext {
  return () => ({
    repoPath: f.repoPath,
    repoId: "t",
    domain: "apps/user",
    goal: "bump x in apps/user",
    baseBranch: "main",
  });
}

describe("closeAndPr Copilot review opt-in", () => {
  let f: Fixture;
  beforeEach(() => {
    f = setup();
  });

  function buildRunners(
    copilotReview?: {
      reviewer: CopilotReviewer;
      config?: Record<string, number>;
    },
    autoMerge?: {
      merger: PrMerger;
      ciStatus: (prNumber: number, expectedHeadSha: string) => Promise<boolean>;
    },
  ) {
    const { coderRunner, reviewerRunner } = approveFakes();
    return createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher: fakePublisher(),
      resolveRunContext: resolveRunContext(f),
      ...(copilotReview !== undefined ? { copilotReview } : {}),
      ...(autoMerge !== undefined ? { autoMerge } : {}),
    });
  }

  function drive(goalId: string, runners: ReturnType<typeof buildRunners>) {
    return new GoalOrchestrator({ dbPath: f.dbPath }).run({
      goalId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });
  }

  it("runs Copilot review but still closes the goal (reviewed does not gate)", async () => {
    const goalId = createGoal(f.dbPath, "g-copilot-reviewed");
    const reviewer = recordingReviewer("reviewed");
    const result = await drive(
      goalId,
      buildRunners({ reviewer, config: FAST_CONFIG }),
    );

    expect(reviewer.requestCalls).toBeGreaterThanOrEqual(1);
    expect(result.outcome).toBe("pr_created");
    expect(result.prUrl).not.toBe("");
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new GoalRepository(db).requireSession(goalId).status).toBe(
        "closed",
      );
      // the Copilot review was audited as a succeeded copilot-review op.
      const op = db
        .prepare(
          "SELECT status FROM operations WHERE operation_type = 'copilot-review'",
        )
        .get() as { status: string } | undefined;
      expect(op?.status).toBe("succeeded");
    } finally {
      close();
    }
  });

  it("a Copilot review that never posts (skipped) still closes the goal", async () => {
    const goalId = createGoal(f.dbPath, "g-copilot-skipped");
    const reviewer = recordingReviewer("pending");
    const result = await drive(
      goalId,
      buildRunners({ reviewer, config: FAST_CONFIG }),
    );

    expect(result.outcome).toBe("pr_created");
    expect(result.prUrl).not.toBe("");
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new GoalRepository(db).requireSession(goalId).status).toBe(
        "closed",
      );
      // a skipped (timed-out) review is a terminal best-effort outcome — it is
      // audited as `succeeded` (result JSON carries status:"skipped"), never
      // `pending` (which would be misread as deferred work), and never gates.
      const op = db
        .prepare(
          "SELECT status, result_json FROM operations WHERE operation_type = 'copilot-review'",
        )
        .get() as { status: string; result_json: string } | undefined;
      expect(op?.status).toBe("succeeded");
      expect(JSON.parse(op?.result_json ?? "{}").status).toBe("skipped");
    } finally {
      close();
    }
  });

  it("a throwing reviewer does NOT break close (exception swallowed, non-gating)", async () => {
    const goalId = createGoal(f.dbPath, "g-copilot-throw");
    const reviewer: CopilotReviewer = {
      async request() {
        throw new Error("boom");
      },
      async poll() {
        throw new Error("boom");
      },
    };
    const result = await drive(
      goalId,
      buildRunners({ reviewer, config: FAST_CONFIG }),
    );

    expect(result.outcome).toBe("pr_created");
    expect(result.prUrl).not.toBe("");
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new GoalRepository(db).requireSession(goalId).status).toBe(
        "closed",
      );
    } finally {
      close();
    }
  });

  // P3: Copilot review is non-gating for AUTO-MERGE too — whatever the Copilot
  // outcome (reviewed / skipped / failed), the auto-merge path still runs and
  // the goal still closes. This directly regression-tests merge non-gating.
  const copilotCases: Array<{
    label: string;
    reviewer: () => CopilotReviewer;
  }> = [
    { label: "reviewed", reviewer: () => recordingReviewer("reviewed") },
    { label: "skipped", reviewer: () => recordingReviewer("pending") },
    {
      label: "failed",
      reviewer: () => ({
        async request() {
          throw new Error("boom");
        },
        async poll() {
          throw new Error("boom");
        },
      }),
    },
  ];

  for (const { label, reviewer: makeReviewer } of copilotCases) {
    it(`auto-merge runs and the goal closes regardless of a ${label} Copilot outcome`, async () => {
      const goalId = createGoal(f.dbPath, `g-copilot-merge-${label}`);
      const merger = fakeMerger();
      const result = await drive(
        goalId,
        buildRunners(
          { reviewer: makeReviewer(), config: FAST_CONFIG },
          {
            merger,
            ciStatus: async () => true, // CI green → auto-merge proceeds
          },
        ),
      );

      // the Copilot outcome never gated the merge: the merger was invoked once.
      expect(merger.calls).toHaveLength(1);
      expect(merger.calls[0]?.prNumber).toBe(42);
      expect(result.outcome).toBe("merged");
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        expect(new GoalRepository(db).requireSession(goalId).status).toBe(
          "closed",
        );
      } finally {
        close();
      }
    });
  }

  it("default (no copilotReview dep) never requests a review", async () => {
    const goalId = createGoal(f.dbPath, "g-copilot-default-off");
    const reviewer = recordingReviewer("reviewed");
    // build runners WITHOUT the copilotReview dep — the reviewer is unused.
    const result = await drive(goalId, buildRunners(undefined));

    expect(result.outcome).toBe("pr_created");
    expect(reviewer.requestCalls).toBe(0);
    expect(reviewer.pollCalls).toBe(0);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      // no copilot-review operation was recorded.
      const op = db
        .prepare(
          "SELECT COUNT(*) c FROM operations WHERE operation_type = 'copilot-review'",
        )
        .get() as { c: number };
      expect(op.c).toBe(0);
    } finally {
      close();
    }
  });
});
