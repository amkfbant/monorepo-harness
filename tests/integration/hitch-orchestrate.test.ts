import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import { HitchOrchestrator } from "../../src/hitch/orchestrator.js";
import { ConvergenceService } from "../../src/hitch/convergence.js";
import {
  awaitHitchMerge,
  awaitStepFromCloseResult,
  type AwaitMergeStep,
} from "../../src/hitch/await-merge.js";
import {
  createOrchestratorRunners,
  HitchNotCloseReadyError,
  latestRunId,
  type HitchRunContext,
} from "../../src/hitch/orchestrator-runners.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";
import { runDomainCoding } from "../../src/core/workflow-runner.js";
import {
  type PrPublisher,
  type PrPublishInputs,
  type PrMerger,
  type PrMergeInputs,
} from "../../src/core/pr-creator.js";
import { REPAIR_MISSING_REVIEW_DECISION_REASON } from "../../src/core/run-materialize.js";

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

function enableAppsUserTypecheckCommand(harnessRoot: string): void {
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
      "    commands:",
      "      allow:",
      "        - id: typecheck",
      "          cmd: node",
      "          args: [\"-e\", \"console.log('typecheck ok')\"]",
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
}

function createGoal(
  dbPath: string,
  hitchId = "goal-orch-e2e",
  domain = "apps/user",
): string {
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    repo.createSession({
      hitchId,
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
    return hitchId;
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

describe("hitch orchestrate (real git + fake codex)", () => {
  let f: Fixture;
  beforeEach(() => {
    f = setup();
  });

  it("drives coder → review → close to a PR", async () => {
    const hitchId = createGoal(f.dbPath);

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

    const resolveRunContext = (): HitchRunContext => ({
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
        const repo = new HitchRepository(db);
        const attempt = repo.createAttempt({
          hitchId,
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

    const result = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });

    expect(result.outcome).toBe("pr_created");
    expect(result.draft).toBe(true);
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
      const repo = new HitchRepository(db);
      const session = repo.requireSession(hitchId);
      expect(session.status).toBe("closed");
      const attempts = repo.listAttempts(hitchId);
      expect(attempts.some((a) => a.attemptType === "implement")).toBe(true);
      expect(attempts.some((a) => a.runId !== null)).toBe(true);
      expect(repo.listReviewCycles(hitchId).length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("drives an EMPTY goal (no seeded run) end-to-end", async () => {
    // No pre-created run. ConvergenceService returns needs_fix/fix_findings
    // for a goal with zero coding attempts (iterationsUsed===0), so the
    // orchestrator's first loop step is `coder` (the gate permits run.start
    // for needs_fix), which drives the initial run itself.
    const hitchId = createGoal(f.dbPath, "goal-orch-empty");

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

    const resolveRunContext = (): HitchRunContext => ({
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

    const result = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId,
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
      const repo = new HitchRepository(db);
      expect(repo.requireSession(hitchId).status).toBe("closed");
      const attempts = repo.listAttempts(hitchId);
      // the implement attempt was created BY THE ORCHESTRATOR (not seeded)
      // and carries the runId of the run it drove.
      const implement = attempts.find((a) => a.attemptType === "implement");
      expect(implement).toBeDefined();
      expect(implement?.runId).toMatch(/^run-/);
      expect(repo.listReviewCycles(hitchId).length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("runs allowlisted command close checks before close_ready", async () => {
    enableAppsUserTypecheckCommand(f.harnessRoot);
    const hitchId = "goal-orch-command-close-check";
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        runMigrations(db);
        new HitchRepository(db).createSession({
          hitchId,
          title: "Add a field with command check",
          description: "update apps/user",
          repoId: "t",
          domain: "apps/user",
          closeConditions: [
            { id: "review-ok", kind: "review_consensus", required: true },
            { id: "typecheck", kind: "command", required: true },
          ],
          createdBy: "test",
          createdSource: "worker",
        });
      } finally {
        close();
      }
    }

    const coderRunner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 2; // command checked\n",
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
    const resolveRunContext = (): HitchRunContext => ({
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

    const result = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });

    expect(result.outcome).toBe("pr_created");
    expect(result.steps.map((s) => s.action)).toContain("close_check");
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      const repo = new HitchRepository(db);
      const runId = latestRunId(repo, hitchId);
      const checks = repo.listCloseChecks(hitchId);
      expect(
        checks.some(
          (check) =>
            check.conditionId === "typecheck" &&
            check.status === "passed" &&
            check.evidence.policyCommandId === "typecheck",
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(f.harnessRoot, "runs", runId, "close-checks", "typecheck.out.log"),
        ),
      ).toBe(true);
      expect(repo.requireSession(hitchId).status).toBe("closed");
    } finally {
      close();
    }
  });

  it("repairs a coder run whose review-decision.yaml is missing, then finalizes", async () => {
    const hitchId = createGoal(f.dbPath, "goal-orch-repair-missing-decision");
    const { coderRunner, reviewerRunner } = approveFakes("docs/guide.md");
    const publisher = fakePublisher();
    const resolveRunContext = (): HitchRunContext => ({
      repoPath: f.repoPath,
      repoId: "t",
      domain: "docs",
      goal: "update docs",
      baseBranch: "main",
    });
    const coded = await runDomainCoding({
      harnessRoot: f.harnessRoot,
      repoPath: f.repoPath,
      repoId: "t",
      domain: "docs",
      goal: "update docs",
      baseBranch: "main",
      codexRunner: coderRunner,
    });
    expect(coded.status).toBe("needs_review");
    rmSync(
      join(f.harnessRoot, "runs", coded.runId, "review-decision.yaml"),
      { force: true },
    );
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        const repo = new HitchRepository(db);
        const attempt = repo.createAttempt({
          hitchId,
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

    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher,
      resolveRunContext,
    });
    const result = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });

    expect(result.outcome).toBe("pr_created");
    expect(publisher.calls).toHaveLength(1);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      const row = db
        .prepare(
          "SELECT reason FROM run_materializations WHERE run_id = ? ORDER BY materialization_id DESC LIMIT 1",
        )
        .get(coded.runId) as { reason: string };
      expect(row.reason).toBe(REPAIR_MISSING_REVIEW_DECISION_REASON);
    } finally {
      close();
    }
  });

  it("on review failure, escalates with the salvaged workspace branch and opens no PR", async () => {
    const hitchId = createGoal(f.dbPath, "goal-orch-salvage-review-failure");
    const coderRunner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, "docs/guide.md"), "# Guide\n\nChanged.\n");
      },
      stdout: "updated docs\n",
    });
    const reviewerRunner = createFakeCodexRunner({
      stdout: "not a review decision\n",
    });
    const publisher = fakePublisher();
    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher,
      resolveRunContext: (): HitchRunContext => ({
        repoPath: f.repoPath,
        repoId: "t",
        domain: "docs",
        goal: "update docs",
        baseBranch: "main",
      }),
    });

    const result = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });

    expect(result.outcome).toBe("escalated");
    expect(result.escalateReason).toMatch(/reviewer agent output is not a YAML object/);
    expect(result.escalateReason).toMatch(/workspace branch pushed: harness\//);
    expect(publisher.calls).toHaveLength(0);
    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).toMatch(/harness\/run-/);

    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(repo.requireSession(hitchId).status).toBe("escalated");
      const runId = latestRunId(repo, hitchId);
      const run = db
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(runId) as { status: string };
      expect(run.status).toBe("needs_review");
    } finally {
      close();
    }
  });

  // Phase 3 auto-merge. The empty-goal flow yields a close_ready goal with an
  // approved review_consensus, so the merge gate's approval condition is met;
  // ciStatus / the merger control the outcome.
  async function driveWithAutoMerge(opts: {
    hitchId: string;
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
    const resolveRunContext = (): HitchRunContext => ({
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
    return new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId: opts.hitchId,
      runners,
      maxSteps: 20,
      createdBy: "test",
    });
  }

  it("auto-merge: merges the PR when the gate passes (consensus approved + CI green)", async () => {
    const hitchId = createGoal(f.dbPath, "goal-merge-ok", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({ hitchId, ciGreen: true, merger });

    expect(result.outcome).toBe("merged");
    expect(merger.calls).toHaveLength(1);
    expect(merger.calls[0]?.prNumber).toBe(42);
    expect(merger.calls[0]?.method).toBe("squash");

    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new HitchRepository(db).requireSession(hitchId).status).toBe("closed");
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
    const hitchId = createGoal(f.dbPath, "goal-merge-extreview", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({
      hitchId,
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
      const ext = new HitchRepository(db)
        .listFindings({ hitchId })
        .find((x) => x.category === "external-review-changes-requested");
      expect(ext).toBeDefined();
      expect(ext?.scopeStatus).toBe("unknown");
    } finally {
      close();
    }
  });

  it("auto-merge: an external APPROVED review does NOT gate (CI-green merge proceeds)", async () => {
    const hitchId = createGoal(f.dbPath, "goal-merge-extapprove", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({
      hitchId,
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
    const hitchId = createGoal(f.dbPath, "goal-merge-extawait", "docs");
    const merger = fakeMerger("ok");
    // The reviewer is slow: the first two fetches see nothing, the third posts a
    // blocking verdict — the bounded await must keep polling and catch it.
    let fetchCount = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const result = await driveWithAutoMerge({
      hitchId,
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
      const ext = new HitchRepository(db)
        .listFindings({ hitchId })
        .find((x) => x.category === "external-review-changes-requested");
      expect(ext).toBeDefined();
    } finally {
      close();
    }
  });

  it("auto-merge: bounded await proceeds to merge when no blocking verdict appears before the budget is spent", async () => {
    const hitchId = createGoal(f.dbPath, "goal-merge-extawait-clean", "docs");
    const merger = fakeMerger("ok");
    let fetchCount = 0;
    let clock = 0;
    const result = await driveWithAutoMerge({
      hitchId,
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
    const hitchId = createGoal(f.dbPath, "goal-merge-pin", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({ hitchId, ciGreen: true, merger });
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
    const hitchId = createGoal(f.dbPath, "goal-merge-ci", "docs");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({ hitchId, ciGreen: false, merger });

    expect(result.outcome).toBe("pr_created");
    expect(merger.calls).toHaveLength(0);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      // NOT closed: a CI-not-green transient is re-checkable, so the goal is
      // left close_ready with the PR open for a later merge.
      expect(new HitchRepository(db).requireSession(hitchId).status).toBe(
        "close_ready",
      );
    } finally {
      close();
    }
  });

  it("auto-merge: a close_ready (CI-not-green) goal merges on a later re-run", async () => {
    const hitchId = createGoal(f.dbPath, "goal-merge-recheck", "docs");
    // first pass: CI not green → PR open, goal left close_ready.
    const first = await driveWithAutoMerge({
      hitchId,
      ciGreen: false,
      merger: fakeMerger("ok"),
    });
    expect(first.outcome).toBe("pr_created");
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        expect(new HitchRepository(db).requireSession(hitchId).status).toBe(
          "close_ready",
        );
      } finally {
        close();
      }
    }
    // second pass: CI now green → re-enters closeAndPr (idempotent PR) and merges.
    const merger = fakeMerger("ok");
    const second = await driveWithAutoMerge({ hitchId, ciGreen: true, merger });
    expect(second.outcome).toBe("merged");
    expect(merger.calls).toHaveLength(1);
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        expect(new HitchRepository(db).requireSession(hitchId).status).toBe(
          "closed",
        );
      } finally {
        close();
      }
    }
  });

  it("await-merge: the poll loop auto-merges a close_ready (CI-not-green) goal once CI greens", async () => {
    const hitchId = createGoal(f.dbPath, "goal-awaitmerge-e2e", "docs");
    // reach close_ready + PR open with CI not green → goal stays close_ready.
    const first = await driveWithAutoMerge({
      hitchId,
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
      resolveRunContext: (): HitchRunContext => ({
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
    // probe mirrors the CLI: gate to close_ready, then run ONLY closeAndPr.
    const probe = async (_remainingMs: number): Promise<AwaitMergeStep> => {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      let decision: string;
      try {
        decision = new ConvergenceService(new HitchRepository(db)).evaluate(
          hitchId,
        ).decision;
      } finally {
        close();
      }
      if (decision !== "close_ready") return { kind: "not_awaiting", decision };
      const r = await runners.closeAndPr(hitchId);
      return awaitStepFromCloseResult(r);
    };

    const sleeps: number[] = [];
    const out = await awaitHitchMerge(
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
      expect(new HitchRepository(db).requireSession(hitchId).status).toBe(
        "closed",
      );
    } finally {
      close();
    }
  });

  it("stopAtCloseReady halts before the PR (no publisher needed) and returns close_ready", async () => {
    // drives an empty goal: coder → review → close_ready, then HALTS without
    // running closeAndPr (the classify --then-rerun contract: rerun, don't PR).
    const hitchId = createGoal(f.dbPath, "goal-stopclose", "docs");
    const { coderRunner, reviewerRunner } = approveFakes("docs/guide.md");
    const publisher = fakePublisher();
    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher, // present, but must NOT be called when stopAtCloseReady halts
      resolveRunContext: (): HitchRunContext => ({
        repoPath: f.repoPath,
        repoId: "t",
        domain: "docs",
        goal: "update docs",
        baseBranch: "main",
      }),
    });
    const result = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId,
      runners,
      maxSteps: 20,
      createdBy: "test",
      stopAtCloseReady: true,
    });
    expect(result.outcome).toBe("close_ready");
    expect(publisher.calls).toHaveLength(0); // no PR opened
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      // the goal is NOT closed — it is left close_ready for a deliberate PR step.
      expect(new HitchRepository(db).requireSession(hitchId).status).toBe(
        "close_ready",
      );
    } finally {
      close();
    }
  });

  it("re-drives an approved run by refreshing review consensus, then opens the PR without re-review", async () => {
    const hitchId = createGoal(f.dbPath, "goal-approved-redrive", "docs");
    const { coderRunner, reviewerRunner } = approveFakes("docs/guide.md");
    const firstPublisher = fakePublisher();
    const firstRunners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher: firstPublisher,
      resolveRunContext: (): HitchRunContext => ({
        repoPath: f.repoPath,
        repoId: "t",
        domain: "docs",
        goal: "update docs",
        baseBranch: "main",
      }),
    });

    const first = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId,
      runners: firstRunners,
      maxSteps: 20,
      createdBy: "test",
      stopAtCloseReady: true,
    });
    expect(first.outcome).toBe("close_ready");
    expect(firstPublisher.calls).toHaveLength(0);

    let cyclesBefore = 0;
    let redriveNow = new Date();
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        const repo = new HitchRepository(db);
        const latestCheckAt = repo
          .listCloseChecks(hitchId)
          .reduce((max, check) => (check.checkedAt > max ? check.checkedAt : max), "");
        const staleAt = new Date(Date.parse(latestCheckAt) + 1_000).toISOString();
        redriveNow = new Date(Date.parse(latestCheckAt) + 2_000);
        const staleCycle = repo.startReviewCycle({
          hitchId,
          reviewMode: "close",
          sourceRunId: latestRunId(repo, hitchId),
          createdAt: staleAt,
        });
        repo.completeReviewCycle({
          cycleId: staleCycle.cycleId,
          completedAt: staleAt,
          summary: "test setup: stale prior close-check evidence",
        });
        cyclesBefore = repo.listReviewCycles(hitchId).length;
        expect(new ConvergenceService(repo).evaluate(hitchId).decision).toBe(
          "continue",
        );
      } finally {
        close();
      }
    }

    const reviewerMustNotRun = createFakeCodexRunner({
      edit: async () => {
        throw new Error("reviewer must not run");
      },
    });
    const publisher = fakePublisher();
    const secondRunners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner: reviewerMustNotRun,
      publisher,
      resolveRunContext: (): HitchRunContext => ({
        repoPath: f.repoPath,
        repoId: "t",
        domain: "docs",
        goal: "update docs",
        baseBranch: "main",
      }),
    });

    vi.useFakeTimers();
    vi.setSystemTime(redriveNow);
    try {
      const second = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
        hitchId,
        runners: secondRunners,
        maxSteps: 20,
        createdBy: "test",
      });

      expect(second.outcome).toBe("pr_created");
      expect(second.steps.map((step) => step.action)).toEqual([
        "review",
        "close_and_pr",
      ]);
      expect(publisher.calls).toHaveLength(1);
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        const repo = new HitchRepository(db);
        expect(repo.listReviewCycles(hitchId)).toHaveLength(cyclesBefore);
        const latestCheck = repo.listCloseChecks(hitchId).at(-1);
        expect(latestCheck).toMatchObject({
          conditionId: "review-ok",
          status: "passed",
          checkedAt: redriveNow.toISOString(),
        });
      } finally {
        close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("closeAndPr throws a typed HitchNotCloseReadyError on a non-close_ready goal (drift signal)", async () => {
    // a fresh goal sits at `continue` (needs a run/review), not close_ready.
    const hitchId = createGoal(f.dbPath, "goal-notready", "docs");
    const { coderRunner, reviewerRunner } = approveFakes("docs/guide.md");
    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher: fakePublisher(),
      resolveRunContext: (): HitchRunContext => ({
        repoPath: f.repoPath,
        repoId: "t",
        domain: "docs",
        goal: "update docs",
        baseBranch: "main",
      }),
      autoMerge: {
        merger: fakeMerger("ok"),
        ciStatus: async () => true,
      },
    });
    // the typed error lets await-merge tell a benign drift from a real failure.
    await expect(runners.closeAndPr(hitchId)).rejects.toBeInstanceOf(
      HitchNotCloseReadyError,
    );
    await runners.closeAndPr(hitchId).catch((e: unknown) => {
      expect(e).toBeInstanceOf(HitchNotCloseReadyError);
      expect((e as HitchNotCloseReadyError).decision).not.toBe("close_ready");
    });
  });

  it("auto-merge: tier-2 paths leave the PR open even with CI green and consensus", async () => {
    const hitchId = createGoal(f.dbPath, "goal-merge-tier2", "src/policy");
    const merger = fakeMerger("ok");
    const result = await driveWithAutoMerge({
      hitchId,
      ciGreen: true,
      merger,
      domain: "src/policy",
      changedPath: "src/policy/rules.ts",
    });

    expect(result.outcome).toBe("pr_created");
    expect(merger.calls).toHaveLength(0);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new HitchRepository(db).requireSession(hitchId).status).toBe("closed");
      const op = db
        .prepare("SELECT COUNT(*) c FROM operations WHERE operation_type = 'merge'")
        .get() as { c: number };
      expect(op.c).toBe(0);
    } finally {
      close();
    }
  });

  it("auto-merge: a merge failure escalates (fail-closed), audited as failed", async () => {
    const hitchId = createGoal(f.dbPath, "goal-merge-fail", "docs");
    const merger = fakeMerger("throw");
    const result = await driveWithAutoMerge({ hitchId, ciGreen: true, merger });

    expect(result.outcome).toBe("escalated");
    expect(merger.calls).toHaveLength(1);
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new HitchRepository(db).requireSession(hitchId).status).toBe("escalated");
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
    const hitchId = createGoal(f.dbPath, "goal-merge-off", "docs");
    const { coderRunner, reviewerRunner } = approveFakes();
    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner,
      reviewerRunner,
      publisher: fakePublisher(),
      resolveRunContext: (): HitchRunContext => ({
        repoPath: f.repoPath,
        repoId: "t",
        domain: "docs",
        goal: "update docs",
        baseBranch: "main",
      }),
    });
    const result = await new HitchOrchestrator({ dbPath: f.dbPath }).run({
      hitchId,
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
