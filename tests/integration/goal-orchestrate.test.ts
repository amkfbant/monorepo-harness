import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { GoalRepository } from "../../src/goal/repository.js";
import { GoalOrchestrator } from "../../src/goal/orchestrator.js";
import { ConvergenceService } from "../../src/goal/convergence.js";
import {
  awaitGoalMerge,
  awaitStepFromOutcome,
  type AwaitMergeStep,
} from "../../src/goal/await-merge.js";
import {
  createOrchestratorRunners,
  type GoalRunContext,
} from "../../src/goal/orchestrator-runners.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";
import { runDomainCoding } from "../../src/core/workflow-runner.js";
import {
  type PrPublisher,
  type PrPublishInputs,
  type PrMerger,
  type PrMergeInputs,
} from "../../src/core/pr-creator.js";

/**
 * End-to-end goal orchestration over real git + a fake codex.
 *
 * The fake CODER writes an in-scope file in the run worktree (→ a
 * `needs_review` run). The fake REVIEWER emits an approved review YAML on
 * stdout (it must not touch any run artifact — the reviewer agent tamper
 * checks the run dir). A fake PUBLISHER returns a fixed PR url so the git
 * push side is exercised against a local bare remote.
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
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-goal-orch-"));
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
      "  docs:",
      "    read: [docs/**]",
      "    write: [docs/**]",
      "    deny_write: []",
      "  src/policy:",
      "    read: [src/policy/**]",
      "    write: [src/policy/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );

  // target repo with a bare remote so `pr create` can push the run branch.
  const repoPath = mkdtempSync(join(tmpdir(), "harness-goal-target-"));
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["config", "user.email", "t@e.com"]);
  git(repoPath, ["config", "user.name", "T"]);
  mkdirSync(join(repoPath, "apps/user/src"), { recursive: true });
  writeFileSync(
    join(repoPath, "apps/user/src/profile.ts"),
    "export const x = 0;\n",
  );
  mkdirSync(join(repoPath, "docs"), { recursive: true });
  writeFileSync(join(repoPath, "docs/guide.md"), "# Guide\n\nInitial.\n");
  mkdirSync(join(repoPath, "src/policy"), { recursive: true });
  writeFileSync(join(repoPath, "src/policy/rules.ts"), "export const rules = [];\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-qm", "init"]);
  const bareRemote = mkdtempSync(join(tmpdir(), "harness-goal-bare-")) + ".git";
  execFileSync("git", ["init", "-q", "--bare", bareRemote]);
  git(repoPath, ["remote", "add", "origin", bareRemote]);
  git(repoPath, ["push", "-q", "-u", "origin", "main"]);

  const dbPath = join(harnessRoot, ".harness", "harness.sqlite");
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  return { harnessRoot, dbPath, repoPath, bareRemote };
}

function createGoal(
  dbPath: string,
  goalId = "goal-orch-e2e",
  domain = "apps/user",
): string {
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new GoalRepository(db);
    repo.createSession({
      goalId,
      title: "Add a field to the user profile",
      description: `update ${domain}`,
      repoId: "t",
      domain,
      // close once the run is approved; review process records this
      // `review_consensus` close-check as passed.
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

function fakeMerger(
  behavior: "ok" | "throw" = "ok",
): PrMerger & { calls: PrMergeInputs[] } {
  const calls: PrMergeInputs[] = [];
  return {
    calls,
    async merge(inputs: PrMergeInputs) {
      calls.push(inputs);
      if (behavior === "throw") throw new Error("gh pr merge failed");
      return { merged: true, alreadyMerged: false };
    },
  };
}

/** Coder + reviewer fakes shared by the orchestration tests. */
function approveFakes(changedPath = "docs/guide.md") {
  const coderRunner = createFakeCodexRunner({
    edit: async (cwd) => {
      writeFileSync(
        join(cwd, changedPath),
        `${changedPath} implemented\n`,
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

describe("goal orchestrate (real git + fake codex)", () => {
  let f: Fixture;
  beforeEach(() => {
    f = setup();
  });

  it("drives coder → review → close to a PR", async () => {
    const goalId = createGoal(f.dbPath);

    const coderRunner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1; // implemented\n",
        );
      },
      stdout: "applied 1 file\n",
    });
    // the reviewer must NOT modify any run artifact — only emit YAML on
    // stdout (the runner pipes stdout to reviewer-agent.out.log).
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
    const publisher = fakePublisher();

    const resolveRunContext = (): GoalRunContext => ({
      repoPath: f.repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x in apps/user",
      baseBranch: "main",
    });

    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher,
      resolveRunContext,
    });

    // Initial implementation pass — represents `harness run`. A fresh goal
    // sits at `continue` (review), so the first run is created directly (the
    // gated `coder` runner only fires on a `needs_fix` fix pass) and recorded
    // as the goal's implement attempt. The orchestrator then drives
    // review → close → PR.
    const coded = await runDomainCoding({
      harnessRoot: f.harnessRoot,
      repoPath: f.repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x in apps/user",
      baseBranch: "main",
      codexRunner: coderRunner,
    });
    expect(coded.status).toBe("needs_review");
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        const repo = new GoalRepository(db);
        const attempt = repo.createAttempt({
          goalId,
          attemptType: "implement",
          status: "running",
        });
        repo.completeAttempt({
          attemptId: attempt.attemptId,
          status: "succeeded",
          runId: coded.runId,
        });
      } finally {
        close();
      }
    }

    const result = await new GoalOrchestrator({ dbPath: f.dbPath }).run({
      goalId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });

    expect(result.outcome).toBe("pr_created");
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.draft).toBe(true);

    // the run branch was pushed to the bare remote
    const branches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(branches).toMatch(/harness\//);

    // the goal recorded an implement attempt, a review cycle, and is closed.
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      const repo = new GoalRepository(db);
      const session = repo.requireSession(goalId);
      expect(session.status).toBe("closed");
      const attempts = repo.listAttempts(goalId);
      expect(attempts.some((a) => a.attemptType === "implement")).toBe(true);
      expect(attempts.some((a) => a.runId !== null)).toBe(true);
      expect(repo.listReviewCycles(goalId).length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("drives an EMPTY goal (no seeded run) end-to-end", async () => {
    // No pre-created run. ConvergenceService returns needs_fix/fix_findings
    // for a goal with zero coding attempts (iterationsUsed===0), so the
    // orchestrator's first loop step is `coder` (the gate permits run.start
    // for needs_fix), which drives the initial run itself.
    const goalId = createGoal(f.dbPath, "goal-orch-empty");

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
    const publisher = fakePublisher();

    const resolveRunContext = (): GoalRunContext => ({
      repoPath: f.repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x in apps/user",
      baseBranch: "main",
    });

    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher,
      resolveRunContext,
    });

    const result = await new GoalOrchestrator({ dbPath: f.dbPath }).run({
      goalId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });

    // terminal: the orchestrator drove coder → review → close → PR with no
    // seeded first run.
    expect(["closed", "pr_created"]).toContain(result.outcome);
    expect(result.outcome).toBe("pr_created");
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(publisher.calls).toHaveLength(1);

    // the very first orchestrator step is the coder pass it created itself.
    expect(result.steps[0]?.action).toBe("coder");

    // the run branch was pushed to the bare remote
    const branches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(branches).toMatch(/harness\//);

    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      const repo = new GoalRepository(db);
      expect(repo.requireSession(goalId).status).toBe("closed");
      const attempts = repo.listAttempts(goalId);
      // the implement attempt was created BY THE ORCHESTRATOR (not seeded)
      // and carries the runId of the run it drove.
      const implement = attempts.find((a) => a.attemptType === "implement");
      expect(implement).toBeDefined();
      expect(implement?.runId).toMatch(/^run-/);
      expect(repo.listReviewCycles(goalId).length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  // Phase 3 auto-merge. The empty-goal flow yields a close_ready goal with an
  // approved review_consensus, so the merge gate's approval condition is met;
  // ciStatus / the merger control the outcome.
  async function driveWithAutoMerge(opts: {
    goalId: string;
    ciGreen: boolean;
    merger: PrMerger;
    domain?: string;
    changedPath?: string;
    reviewVerdicts?: (
      prNumber: number,
    ) => Promise<{ author: string; state: string }[]>;
    reviewAwait?: {
      timeoutMs: number;
      intervalMs: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    };
  }) {
    const domain = opts.domain ?? "docs";
    const { coderRunner, reviewerRunner } = approveFakes(opts.changedPath);
    const resolveRunContext = (): GoalRunContext => ({
      repoPath: f.repoPath,
      repoId: "t",
      domain,
      goal: `update ${domain}`,
      baseBranch: "main",
    });
    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher: fakePublisher(),
      resolveRunContext,
      autoMerge: {
        merger: opts.merger,
        ciStatus: async (_prNumber: number, _expectedHeadSha: string) => opts.ciGreen,
        ...(opts.reviewVerdicts !== undefined
          ? { reviewVerdicts: opts.reviewVerdicts }
          : {}),
        ...(opts.reviewAwait !== undefined
          ? { reviewAwait: opts.reviewAwait }
          : {}),
      },
    });
    return new GoalOrchestrator({ dbPath: f.dbPath }).run({
      goalId: opts.goalId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });
  }

  it("auto-merge: merges the PR when the gate passes (consensus approved + CI green)", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-ok", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({ goalId, ciGreen: true, merger });

    expect(result.outcome).toBe("merged");
    expect(merger.calls).toHaveLength(1);
    expect(merger.calls[0]?.prNumber).toBe(42);
    expect(merger.calls[0]?.method).toBe("squash");

    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new GoalRepository(db).requireSession(goalId).status).toBe("closed");
      // the merge was audited.
      const op = db
        .prepare("SELECT status, operation_type FROM operations WHERE operation_type = 'merge'")
        .get() as { status: string; operation_type: string } | undefined;
      expect(op?.status).toBe("succeeded");
    } finally {
      close();
    }
  });

  it("auto-merge: an external CHANGES_REQUESTED review is ingested as a finding and escalates (fail-closed)", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-extreview", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({
      goalId,
      ciGreen: true,
      merger,
      reviewVerdicts: async () => [
        { author: "codex[bot]", state: "CHANGES_REQUESTED" },
      ],
    });

    // external changes-requested → not merged; an unknown finding was ingested,
    // so the gate's close-readiness re-eval fails and the goal escalates.
    expect(result.outcome).toBe("escalated");
    expect(merger.calls).toHaveLength(0);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      const ext = new GoalRepository(db)
        .listFindings({ goalId })
        .find((x) => x.category === "external-review-changes-requested");
      expect(ext).toBeDefined();
      expect(ext?.scopeStatus).toBe("unknown");
    } finally {
      close();
    }
  });

  it("auto-merge: an external APPROVED review does NOT gate (CI-green merge proceeds)", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-extapprove", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({
      goalId,
      ciGreen: true,
      merger,
      reviewVerdicts: async () => [{ author: "copilot", state: "APPROVED" }],
    });

    // an external approval is never trusted to gate — the deterministic gate
    // (consensus + CI green + tier-0) still merges.
    expect(result.outcome).toBe("merged");
    expect(merger.calls).toHaveLength(1);
  });

  it("auto-merge: bounded await polls until a late external CHANGES_REQUESTED appears, then escalates", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-extawait", "docs");
    const merger = fakeMerger("ok");
    // The reviewer is slow: the first two fetches see nothing, the third posts a
    // blocking verdict — the bounded await must keep polling and catch it.
    let fetchCount = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const result = await driveWithAutoMerge({
      goalId,
      ciGreen: true,
      merger,
      reviewVerdicts: async () => {
        fetchCount += 1;
        return fetchCount >= 3
          ? [{ author: "codex[bot]", state: "CHANGES_REQUESTED" }]
          : [];
      },
      reviewAwait: {
        timeoutMs: 60_000,
        intervalMs: 15_000,
        now: () => clock,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          clock += ms;
        },
      },
    });

    expect(result.outcome).toBe("escalated");
    expect(merger.calls).toHaveLength(0);
    // initial fetch + 2 polls before the verdict appeared on the 3rd fetch.
    expect(fetchCount).toBe(3);
    expect(sleeps).toEqual([15_000, 15_000]);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      const ext = new GoalRepository(db)
        .listFindings({ goalId })
        .find((x) => x.category === "external-review-changes-requested");
      expect(ext).toBeDefined();
    } finally {
      close();
    }
  });

  it("auto-merge: bounded await proceeds to merge when no blocking verdict appears before the budget is spent", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-extawait-clean", "docs");
    const merger = fakeMerger("ok");
    let fetchCount = 0;
    let clock = 0;
    const result = await driveWithAutoMerge({
      goalId,
      ciGreen: true,
      merger,
      reviewVerdicts: async () => {
        fetchCount += 1;
        return [];
      },
      reviewAwait: {
        timeoutMs: 30_000,
        intervalMs: 15_000,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      },
    });

    // no external reviewer requested changes within the window → the gate is
    // evaluated and the deterministic merge proceeds. The budget is bounded.
    expect(result.outcome).toBe("merged");
    expect(merger.calls).toHaveLength(1);
    // initial fetch + polls until the 30s budget is spent (2 × 15s).
    expect(fetchCount).toBe(3);
  });

  it("auto-merge: pins the merge to the reviewed commit (from createPullRequest)", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-pin", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({ goalId, ciGreen: true, merger });
    expect(result.outcome).toBe("merged");
    // the pinned SHA is the run branch's reviewed commit (a real, resolvable
    // git SHA), not a later-observed PR head.
    const pinned = merger.calls[0]?.expectedHeadSha;
    expect(pinned).toMatch(/^[0-9a-f]{40}$/);
    expect(() =>
      execFileSync("git", ["-C", f.repoPath, "cat-file", "-e", pinned!], {
        stdio: "ignore",
      }),
    ).not.toThrow();
  });

  it("auto-merge: CI-not-green leaves the PR open and the goal close_ready (re-checkable)", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-ci", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({ goalId, ciGreen: false, merger });

    expect(result.outcome).toBe("pr_created");
    expect(merger.calls).toHaveLength(0);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      // NOT closed: a CI-not-green transient is re-checkable, so the goal is
      // left close_ready with the PR open for a later merge.
      expect(new GoalRepository(db).requireSession(goalId).status).toBe(
        "close_ready",
      );
    } finally {
      close();
    }
  });

  it("auto-merge: a close_ready (CI-not-green) goal merges on a later re-run", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-recheck", "docs");
    // first pass: CI not green → PR open, goal left close_ready.
    const first = await driveWithAutoMerge({
      goalId,
      ciGreen: false,
      merger: fakeMerger("ok"),
    });
    expect(first.outcome).toBe("pr_created");
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        expect(new GoalRepository(db).requireSession(goalId).status).toBe(
          "close_ready",
        );
      } finally {
        close();
      }
    }
    // second pass: CI now green → re-enters closeAndPr (idempotent PR) and merges.
    const merger = fakeMerger("ok");
    const second = await driveWithAutoMerge({ goalId, ciGreen: true, merger });
    expect(second.outcome).toBe("merged");
    expect(merger.calls).toHaveLength(1);
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        expect(new GoalRepository(db).requireSession(goalId).status).toBe(
          "closed",
        );
      } finally {
        close();
      }
    }
  });

  it("await-merge: the poll loop auto-merges a close_ready (CI-not-green) goal once CI greens", async () => {
    const goalId = createGoal(f.dbPath, "goal-awaitmerge-e2e", "docs");
    // reach close_ready + PR open with CI not green → goal stays close_ready.
    const first = await driveWithAutoMerge({
      goalId,
      ciGreen: false,
      merger: fakeMerger("ok"),
    });
    expect(first.outcome).toBe("pr_created");

    // Build the await-merge probe exactly as the CLI does: one orchestrate step
    // per poll, gated to the close/merge action, with CI flipping green on the
    // 2nd check so the loop must poll twice.
    const merger = fakeMerger("ok");
    const { coderRunner, reviewerRunner } = approveFakes("docs/guide.md");
    let ciChecks = 0;
    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher: fakePublisher(),
      resolveRunContext: (): GoalRunContext => ({
        repoPath: f.repoPath,
        repoId: "t",
        domain: "docs",
        goal: "update docs",
        baseBranch: "main",
      }),
      autoMerge: {
        merger,
        ciStatus: async () => (ciChecks += 1) >= 2, // false, then green
      },
    });
    const orch = new GoalOrchestrator({ dbPath: f.dbPath });
    const probe = async (): Promise<AwaitMergeStep> => {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      let decision: string;
      try {
        decision = new ConvergenceService(new GoalRepository(db)).evaluate(
          goalId,
        ).decision;
      } finally {
        close();
      }
      if (decision !== "close_ready") return { kind: "not_awaiting", decision };
      const r = await orch.run({
        goalId,
        runners,
        maxSteps: 1,
        createdBy: "test",
      });
      return awaitStepFromOutcome(r);
    };

    const sleeps: number[] = [];
    const out = await awaitGoalMerge(
      {
        pollOnce: probe,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => 0,
      },
      { pollIntervalMs: 1, maxWaitMs: 60_000 },
    );

    expect(out.outcome).toBe("merged");
    expect(out.polls).toBe(2); // awaiting once (CI red), then merged (CI green)
    expect(sleeps).toEqual([1]); // slept once between the two polls
    expect(merger.calls).toHaveLength(1);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new GoalRepository(db).requireSession(goalId).status).toBe(
        "closed",
      );
    } finally {
      close();
    }
  });

  it("auto-merge: tier-2 paths leave the PR open even with CI green and consensus", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-tier2", "src/policy");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({
      goalId,
      ciGreen: true,
      merger,
      domain: "src/policy",
      changedPath: "src/policy/rules.ts",
    });

    expect(result.outcome).toBe("pr_created");
    expect(merger.calls).toHaveLength(0);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new GoalRepository(db).requireSession(goalId).status).toBe("closed");
      const op = db
        .prepare("SELECT COUNT(*) c FROM operations WHERE operation_type = 'merge'")
        .get() as { c: number };
      expect(op.c).toBe(0);
    } finally {
      close();
    }
  });

  it("auto-merge: a merge failure escalates (fail-closed), audited as failed", async () => {
    const goalId = createGoal(f.dbPath, "goal-merge-fail", "docs");
    const merger = fakeMerger("throw");
    const result = await driveWithAutoMerge({ goalId, ciGreen: true, merger });

    expect(result.outcome).toBe("escalated");
    expect(merger.calls).toHaveLength(1);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new GoalRepository(db).requireSession(goalId).status).toBe("escalated");
      const op = db
        .prepare("SELECT status FROM operations WHERE operation_type = 'merge'")
        .get() as { status: string } | undefined;
      expect(op?.status).toBe("failed");
    } finally {
      close();
    }
  });

  it("auto-merge OFF by default: closeAndPr creates the PR but never merges", async () => {
    // No `autoMerge` in deps → the merger is never constructed/called and the
    // goal terminates at pr_created (covered by the main flow, asserted here
    // explicitly for the opt-in default).
    const goalId = createGoal(f.dbPath, "goal-merge-off", "docs");
    const { coderRunner, reviewerRunner } = approveFakes();
    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher: fakePublisher(),
      resolveRunContext: (): GoalRunContext => ({
        repoPath: f.repoPath,
        repoId: "t",
        domain: "docs",
        goal: "update docs",
        baseBranch: "main",
      }),
    });
    const result = await new GoalOrchestrator({ dbPath: f.dbPath }).run({
      goalId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });
    expect(result.outcome).toBe("pr_created");
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      // no merge operation was recorded.
      const op = db
        .prepare("SELECT COUNT(*) c FROM operations WHERE operation_type = 'merge'")
        .get() as { c: number };
      expect(op.c).toBe(0);
    } finally {
      close();
    }
  });
});
