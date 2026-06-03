import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { GoalRepository } from "../../src/goal/repository.js";
import { GoalOrchestrator } from "../../src/goal/orchestrator.js";
import {
  createOrchestratorRunners,
  type GoalRunContext,
} from "../../src/goal/orchestrator-runners.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";
import { runDomainCoding } from "../../src/core/workflow-runner.js";
import {
  type PrPublisher,
  type PrPublishInputs,
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

function createGoal(dbPath: string): string {
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new GoalRepository(db);
    repo.createSession({
      goalId: "goal-orch-e2e",
      title: "Add a field to the user profile",
      description: "bump the exported constant in apps/user",
      repoId: "t",
      domain: "apps/user",
      // close once the run is approved; review process records this
      // `review_consensus` close-check as passed.
      closeConditions: [
        { id: "review-ok", kind: "review_consensus", required: true },
      ],
      createdBy: "test",
      createdSource: "worker",
    });
    return "goal-orch-e2e";
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
});
