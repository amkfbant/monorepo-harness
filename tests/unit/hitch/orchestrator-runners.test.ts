import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import {
  createOrchestratorRunners,
  latestRunId,
  type HitchRunContext,
} from "../../../src/hitch/orchestrator-runners.js";

describe("createOrchestratorRunners.classify", () => {
  it("returns resolved=true when there are no unknown-scope findings", async () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "harness-orch-run-")),
      "harness.sqlite",
    );
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-c",
        title: "C",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot: dbPath,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
    });
    const r = await runners.classify("g-c");
    expect(r.resolved).toBe(true);
  });

  it.each(["out_of_scope", "escalated"] as const)(
    "defer moves %s out-of-scope findings to the backlog",
    async (lifecycleStatus) => {
      const dbPath = join(
        mkdtempSync(join(tmpdir(), "harness-orch-defer-")),
        "harness.sqlite",
      );
      let findingId = "";
      {
        const { db, close } = openManagedDb({ dbPath });
        try {
          runMigrations(db);
          const repo = new HitchRepository(db);
          repo.createSession({
            hitchId: "g-defer",
            title: "Defer",
            projectId: "demo",
            closeConditions: [{ id: "typecheck", kind: "command", required: true }],
            createdBy: "test",
            createdSource: "worker",
          });
          const f = repo.upsertFinding({
            hitchId: "g-defer",
            source: "review",
            severity: "P2",
            category: "future-feature",
            scopeStatus: "out_of_scope",
            summary: "out of scope idea",
            ...(lifecycleStatus === "escalated" ? { lifecycleStatus } : {}),
          }).finding;
          findingId = f.findingId;
        } finally {
          close();
        }
      }
      const runners = createOrchestratorRunners({
        dbPath,
        harnessRoot: dbPath,
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
      });
      const result = await runners.defer("g-defer");
      expect(result.deferred).toBe(1);
      const { db, close } = openManagedDb({ dbPath });
      try {
        expect(
          new HitchRepository(db).requireFinding(findingId).lifecycleStatus,
        ).toBe("deferred");
      } finally {
        close();
      }
    },
  );
});

describe("latestRunId", () => {
  it("selects the most recent coding run id, ignoring non-coding attempts", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "harness-orch-latest-")),
      "harness.sqlite",
    );
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-latest",
        title: "L",
        projectId: "demo",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      // older implement run
      repo.createAttempt({
        hitchId: "g-latest",
        attemptType: "implement",
        status: "succeeded",
        runId: "run-old-implement",
      });
      // a more recent rerun — this is the run review/PR should target
      repo.createAttempt({
        hitchId: "g-latest",
        attemptType: "rerun",
        status: "succeeded",
        runId: "run-new-rerun",
      });
      // a still-later NON-coding attempt carrying its own runId — must be
      // ignored so it can't be picked for review/PR.
      repo.createAttempt({
        hitchId: "g-latest",
        attemptType: "close-check",
        status: "succeeded",
        runId: "run-close-check",
      });
      expect(latestRunId(repo, "g-latest")).toBe("run-new-rerun");
    } finally {
      close();
    }
  });

  it("throws when the goal has no coding run yet", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "harness-orch-latest-none-")),
      "harness.sqlite",
    );
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-none",
        title: "N",
        projectId: "demo",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      // only a non-coding attempt with a runId — latestRunId must reject it.
      repo.createAttempt({
        hitchId: "g-none",
        attemptType: "close-check",
        status: "succeeded",
        runId: "run-close-check",
      });
      expect(() => latestRunId(repo, "g-none")).toThrow(/no recorded run/);
    } finally {
      close();
    }
  });
});

describe("createOrchestratorRunners.coder (failed run)", () => {
  function setupHarness(): { harnessRoot: string; dbPath: string; repoPath: string } {
    const harnessRoot = mkdtempSync(join(tmpdir(), "harness-orch-coder-"));
    mkdirSync(join(harnessRoot, "policies/repos"), { recursive: true });
    mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
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
    const repoPath = mkdtempSync(join(tmpdir(), "harness-orch-coder-target-"));
    const g = (a: string[]) =>
      execFileSync("git", a, { cwd: repoPath, stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@e.com"]);
    g(["config", "user.name", "T"]);
    mkdirSync(join(repoPath, "apps/user/src"), { recursive: true });
    writeFileSync(join(repoPath, "apps/user/src/profile.ts"), "export const x = 0;\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    return { harnessRoot, dbPath: join(harnessRoot, ".harness", "harness.sqlite"), repoPath };
  }

  it("records a failed attempt carrying the runId when the run finalizes as failed", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-fail",
        title: "Fail",
        projectId: "demo",
        repoId: "t",
        domain: "apps/user",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      // pre-seed a coding attempt so the gate sees needs_fix? No — a fresh
      // goal is `continue` and run.start is denied. Seed an open in-scope P1
      // finding so the goal is `needs_fix` and the gate permits run.start.
      const repo = new HitchRepository(db);
      repo.upsertFinding({
        hitchId: "g-fail",
        source: "review",
        severity: "P1",
        category: "bug",
        scopeStatus: "in_scope",
        summary: "fix the thing",
      });
    } finally {
      close();
    }

    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "fix the thing",
      baseBranch: "main",
    });
    // a codex runner that throws AFTER the run log is created → runDomainCoding
    // finalizes the run as failed-internal-error and rethrows RunFinalizedError
    // carrying the runId.
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async () => {
          throw new Error("codex exploded");
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
      resolveRunContext,
    });

    await expect(runners.coder("g-fail")).rejects.toThrow(/codex exploded/);

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      const attempts = new HitchRepository(db2).listAttempts("g-fail");
      const failed = attempts.find((a) => a.status === "failed");
      expect(failed).toBeDefined();
      expect(failed?.attemptType).toBe("implement");
      // the failed attempt carries the finalized run's id (RunFinalizedError).
      expect(failed?.runId).toMatch(/^run-/);
      expect(failed?.errorMessage).toMatch(/codex exploded/);
    } finally {
      close2();
    }
  });

  it("injects open in-scope findings into the coder goal on a rerun", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-inject",
          title: "Inject",
          projectId: "demo",
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        // a prior coding attempt → this run is a "rerun"
        repo.createAttempt({
          hitchId: "g-inject",
          attemptType: "implement",
          status: "succeeded",
          runId: "run-prior",
        });
        // the prior attempt was reviewed (the finding below came from it) so
        // convergence stays needs_fix rather than routing to a pending review
        // (#104).
        const ic = repo.startReviewCycle({
          hitchId: "g-inject",
          cycleNumber: 1,
          reviewMode: "initial",
        });
        repo.completeReviewCycle({ cycleId: ic.cycleId, findingsNew: 1 });
        // an open in-scope finding the rerun must address (also makes the goal
        // needs_fix so the run.start gate permits the coder).
        repo.upsertFinding({
          hitchId: "g-inject",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "in_scope",
          summary: "missing null check in profile loader",
        });
      } finally {
        close();
      }
    }
    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    });
    let captured = "";
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async (input) => {
          captured = input.prompt;
          return { exitCode: 0, timedOut: false };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
      resolveRunContext,
    });
    await runners.coder("g-inject");
    expect(captured).toContain("improve the profile feature");
    expect(captured).toContain("Open in-scope findings to address");
    expect(captured).toContain("missing null check in profile loader");
  });

  it("does NOT inject the findings block on the first implement pass", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-first",
          title: "First",
          projectId: "demo",
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        // an open in-scope finding (so run.start is permitted) but NO prior
        // coding attempt → this is the first `implement` pass, no injection.
        repo.upsertFinding({
          hitchId: "g-first",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "in_scope",
          summary: "should not be injected on first pass",
        });
      } finally {
        close();
      }
    }
    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    });
    let captured = "";
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async (input) => {
          captured = input.prompt;
          return { exitCode: 0, timedOut: false };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
      resolveRunContext,
    });
    await runners.coder("g-first");
    expect(captured).toContain("improve the profile feature");
    expect(captured).not.toContain("Open in-scope findings to address");
    expect(captured).not.toContain("should not be injected on first pass");
  });

  it("injects the previous run's failure status into the coder goal on a recovery rerun", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-recover",
          title: "Recover",
          projectId: "demo",
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        // a prior coding attempt that FAILED before review (failed-command) →
        // convergence routes to a rerun, and the coder injects the failure.
        const failed = repo.createAttempt({
          hitchId: "g-recover",
          attemptType: "implement",
          status: "running",
        });
        repo.completeAttempt({
          attemptId: failed.attemptId,
          status: "failed",
          runId: "run-failed-cmd",
          result: { runStatus: "failed-command" },
        });
      } finally {
        close();
      }
    }
    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    });
    let captured = "";
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async (input) => {
          captured = input.prompt;
          return { exitCode: 0, timedOut: false };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
      resolveRunContext,
    });
    await runners.coder("g-recover");
    expect(captured).toContain("improve the profile feature");
    expect(captured).toContain("Previous attempt failed");
    expect(captured).toContain("failed-command");
  });
});
