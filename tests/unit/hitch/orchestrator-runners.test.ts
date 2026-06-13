import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import {
  createOrchestratorRunners,
  latestRunId,
  type HitchRunContext,
} from "../../../src/hitch/orchestrator-runners.js";
import {
  acquireDomainLock,
  DomainLockBusyError,
  LeaseGuardFailedError,
} from "../../../src/workspace/db-domain-lock.js";

function createRunnerTestDb(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "harness.sqlite");
}

function createBasicHitch(repo: HitchRepository, hitchId: string): void {
  repo.createSession({
    hitchId,
    title: "Fix scoped files",
    projectId: "demo",
    scope: { targetFiles: ["src/**"] },
    closeConditions: [{ id: "typecheck", kind: "command", required: true }],
    createdBy: "test",
    createdSource: "worker",
  });
}

function createRunners(dbPath: string) {
  return createOrchestratorRunners({
    dbPath,
    harnessRoot: dbPath,
    createdBy: "worker",
    coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
  });
}

function createHarnessRoot(prefix: string): { harnessRoot: string; dbPath: string } {
  const harnessRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  return { harnessRoot, dbPath: join(harnessRoot, ".harness", "harness.sqlite") };
}

function approvedDecisionYaml(runId: string, domain = "docs"): string {
  return [
    `runId: ${runId}`,
    `domain: ${domain}`,
    "decision: approved",
    "required_changes: []",
    "non_blocking_comments: []",
    "out_of_scope_suggestions: []",
    "reviewer: codex-reviewer",
    "reviewed_at: 2026-06-13T00:00:00.000Z",
    "",
  ].join("\n");
}

function insertApprovedRunWithProcessedProposal(input: {
  dbPath: string;
  hitchId: string;
  closeConditions?: Parameters<HitchRepository["createSession"]>[0]["closeConditions"];
}): string {
  const runId = `run-${input.hitchId}`;
  const sourceYaml = approvedDecisionYaml(runId);
  const sourceSha = createHash("sha256").update(sourceYaml).digest("hex");
  const { db, close } = openManagedDb({ dbPath: input.dbPath });
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    repo.createSession({
      hitchId: input.hitchId,
      title: "Approved decided run",
      repoId: "t",
      domain: "docs",
      closeConditions:
        input.closeConditions ?? [
          { id: "review-ok", kind: "review_consensus", required: true },
        ],
      createdBy: "test",
      createdSource: "worker",
    });
    repo.createAttempt({
      hitchId: input.hitchId,
      attemptType: "implement",
      status: "succeeded",
      runId,
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, reviewer, reviewed_at, source_mode, db_revision,
         export_status, updated_at, meta_json)
       VALUES (?, 't', 'docs', 'domain-coding', 'main', 'approved',
         'codex-reviewer', '2026-06-13T00:00:00.000Z', 'db-first', 1,
         'disabled', '2026-06-13T00:00:00.000Z', ?)`,
    ).run(
      runId,
      JSON.stringify({
        runId,
        repoId: "t",
        domain: "docs",
        status: "approved",
      }),
    );
    db.prepare(
      `INSERT INTO review_proposals (
         run_id, reviewer, decision, required_changes_json,
         non_blocking_comments_json, out_of_scope_suggestions_json,
         reviewed_at, source_yaml, source_sha256, created_at, processed_at,
         review_decision_id, lifecycle_status
       )
       VALUES (?, 'codex-reviewer', 'approved', '[]', '[]', '[]',
         '2026-06-13T00:00:00.000Z', ?, ?, '2026-06-13T00:00:00.000Z',
         '2026-06-13T00:00:00.000Z', ?, 'processed')`,
    ).run(runId, sourceYaml, sourceSha, runId);
    return runId;
  } finally {
    close();
  }
}

describe("createOrchestratorRunners.projectRuntime", () => {
  it("rejects incomplete project runtime deps atomically", () => {
    expect(() =>
      createOrchestratorRunners({
        dbPath: "/tmp/harness.sqlite",
        harnessRoot: "/tmp/harness-root",
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        projectRuntime: { project: {} } as never,
      }),
    ).toThrow(/atomically.*compiledPolicy and project/);
  });

  it("rejects a null compiledPolicy (would silently fall back to raw policy)", () => {
    expect(() =>
      createOrchestratorRunners({
        dbPath: "/tmp/harness.sqlite",
        harnessRoot: "/tmp/harness-root",
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        projectRuntime: { compiledPolicy: null, project: {} } as never,
      }),
    ).toThrow(/atomically.*compiledPolicy and project/);
  });

  it("rejects a compiledPolicy missing global/repo", () => {
    expect(() =>
      createOrchestratorRunners({
        dbPath: "/tmp/harness.sqlite",
        harnessRoot: "/tmp/harness-root",
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        projectRuntime: { compiledPolicy: { global: {} }, project: {} } as never,
      }),
    ).toThrow(/compiledPolicy must contain both global and repo/);
  });
});

describe("createOrchestratorRunners.review decided run re-drive", () => {
  it("short-circuits an approved processed run without invoking the reviewer", async () => {
    const { harnessRoot, dbPath } = createHarnessRoot(
      "harness-orch-review-redrive-",
    );
    const hitchId = "g-approved-redrive";
    const runId = insertApprovedRunWithProcessedProposal({ dbPath, hitchId });
    const reviewerRunner = {
      run: vi.fn(async () => {
        throw new Error("reviewer must not run");
      }),
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T01:00:00.000Z"));
    try {
      const runners = createOrchestratorRunners({
        dbPath,
        harnessRoot,
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner,
      });

      const result = await runners.review(hitchId);

      expect(result).toEqual({ runId, decision: "approved" });
      expect(reviewerRunner.run).not.toHaveBeenCalled();
      const { db, close } = openManagedDb({ dbPath });
      try {
        const repo = new HitchRepository(db);
        expect(repo.listReviewCycles(hitchId)).toHaveLength(0);
        const checks = repo.listCloseChecks(hitchId);
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({
          conditionId: "review-ok",
          status: "passed",
          checkedAt: "2026-06-13T01:00:00.000Z",
          checkedBy: "codex-reviewer",
        });
        expect(new ConvergenceService(repo).evaluate(hitchId).decision).toBe(
          "close_ready",
        );
      } finally {
        close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates explicitly when approved review evidence is fresh but another required condition is pending", async () => {
    const { harnessRoot, dbPath } = createHarnessRoot(
      "harness-orch-review-pending-",
    );
    const hitchId = "g-approved-pending";
    insertApprovedRunWithProcessedProposal({
      dbPath,
      hitchId,
      closeConditions: [
        { id: "review-ok", kind: "review_consensus", required: true },
        { id: "manual-signoff", kind: "manual", required: true },
      ],
    });
    const reviewerRunner = {
      run: vi.fn(async () => {
        throw new Error("reviewer must not run");
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).rejects.toThrow(/manual-signoff/);
    expect(reviewerRunner.run).not.toHaveBeenCalled();
    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(repo.listReviewCycles(hitchId)).toHaveLength(0);
      expect(repo.listCloseChecks(hitchId).map((c) => c.conditionId)).toEqual([
        "review-ok",
      ]);
    } finally {
      close();
    }
  });

  it("does not salvage a review branch when the latest run is already decided", async () => {
    const { harnessRoot, dbPath } = createHarnessRoot(
      "harness-orch-review-salvage-",
    );
    const hitchId = "g-approved-salvage";
    insertApprovedRunWithProcessedProposal({ dbPath, hitchId });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    });

    await expect(runners.salvageReviewBranch?.(hitchId)).resolves.toBeNull();
  });
});

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
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    });
    const r = await runners.classify("g-c");
    expect(r.resolved).toBe(true);
  });

  it("drains more than one implicit finding page before reporting resolved", async () => {
    const dbPath = createRunnerTestDb("harness-orch-classify-many-");
    const total = 201;
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-classify-many");
        for (let i = 0; i < total; i += 1) {
          repo.upsertFinding({
            hitchId: "g-classify-many",
            source: "review",
            severity: "P1",
            category: "bug",
            scopeStatus: "unknown",
            summary: `bug in scoped file ${i}`,
            filePath: `src/file-${i}.ts`,
          });
        }
      } finally {
        close();
      }
    }

    const result = await createRunners(dbPath).classify("g-classify-many");

    expect(result).toEqual({ resolved: true });
    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(
        repo.countFindings({
          hitchId: "g-classify-many",
          scopeStatus: "unknown",
          lifecycleStatusIn: ["open", "reopened", "escalated"],
        }),
      ).toBe(0);
      expect(
        repo.countFindings({
          hitchId: "g-classify-many",
          scopeStatus: "in_scope",
        }),
      ).toBe(total);
    } finally {
      close();
    }
  });

  it("returns unresolved with an escalation reason when a finding cannot be classified", async () => {
    const dbPath = createRunnerTestDb("harness-orch-classify-unknown-");
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-classify-unknown");
        repo.upsertFinding({
          hitchId: "g-classify-unknown",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "unknown",
          summary: "ambiguous issue",
        });
      } finally {
        close();
      }
    }

    const result = await createRunners(dbPath).classify("g-classify-unknown");

    expect(result.resolved).toBe(false);
    expect(result.escalateReason).toMatch(/cannot classify finding/);
  });

  it("stops finitely when classification makes no count progress", async () => {
    const dbPath = createRunnerTestDb("harness-orch-classify-stuck-");
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-classify-stuck");
        repo.upsertFinding({
          hitchId: "g-classify-stuck",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "unknown",
          summary: "bug in scoped file",
          filePath: "src/file.ts",
        });
      } finally {
        close();
      }
    }
    const classifySpy = vi
      .spyOn(HitchRepository.prototype, "classifyFinding")
      .mockImplementation(function (
        this: HitchRepository,
        input: Parameters<HitchRepository["classifyFinding"]>[0],
      ) {
        return this.requireFinding(input.findingId);
      });
    try {
      const result = await createRunners(dbPath).classify("g-classify-stuck");
      expect(result.resolved).toBe(false);
      expect(result.escalateReason).toMatch(/no progress/i);
    } finally {
      classifySpy.mockRestore();
    }
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
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
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

  it("defers more than one implicit finding page and reports the real count", async () => {
    const dbPath = createRunnerTestDb("harness-orch-defer-many-");
    const total = 201;
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-defer-many");
        for (let i = 0; i < total; i += 1) {
          repo.upsertFinding({
            hitchId: "g-defer-many",
            source: "review",
            severity: "P2",
            category: "future-feature",
            scopeStatus: "out_of_scope",
            summary: `future follow-up ${i}`,
          });
        }
      } finally {
        close();
      }
    }

    const result = await createRunners(dbPath).defer("g-defer-many");

    expect(result.deferred).toBe(total);
    const { db, close } = openManagedDb({ dbPath });
    try {
      expect(
        new HitchRepository(db).countFindings({
          hitchId: "g-defer-many",
          scopeStatus: "out_of_scope",
          lifecycleStatusIn: ["open", "reopened", "out_of_scope", "escalated"],
        }),
      ).toBe(0);
    } finally {
      close();
    }
  });

  it("stops finitely when deferral makes no count progress", async () => {
    const dbPath = createRunnerTestDb("harness-orch-defer-stuck-");
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-defer-stuck");
        repo.upsertFinding({
          hitchId: "g-defer-stuck",
          source: "review",
          severity: "P2",
          category: "future-feature",
          scopeStatus: "out_of_scope",
          summary: "future follow-up",
        });
      } finally {
        close();
      }
    }
    const deferSpy = vi
      .spyOn(HitchRepository.prototype, "deferFinding")
      .mockImplementation(function (
        this: HitchRepository,
        input: Parameters<HitchRepository["deferFinding"]>[0],
      ) {
        return this.requireFinding(input.findingId);
      });
    try {
      const result = await createRunners(dbPath).defer("g-defer-stuck");
      expect(result.deferred).toBe(0);
    } finally {
      deferSpy.mockRestore();
    }
  });
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
        projectId: null,
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
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
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

  it("does not consume an attempt when the domain lock is busy", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-lock-busy",
        title: "Busy",
        projectId: null,
        repoId: "t",
        domain: "apps/user",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.upsertFinding({
        hitchId: "g-lock-busy",
        source: "review",
        severity: "P1",
        category: "bug",
        scopeStatus: "in_scope",
        summary: "fix the thing",
      });
      acquireDomainLock(db, {
        domainKey: "t::apps/user",
        repoId: "t",
        domain: "apps/user",
        runId: "holder",
        pid: process.pid,
        hostname: "test-host",
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
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });

    await expect(runners.coder("g-lock-busy")).rejects.toBeInstanceOf(
      DomainLockBusyError,
    );

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db2);
      expect(repo.listAttempts("g-lock-busy")).toEqual([]);
      expect(repo.requireSession("g-lock-busy").currentIteration).toBe(0);
    } finally {
      close2();
    }
  });

  it("does not consume an attempt when a finalized run has a nested lease guard cause", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-lease-finalized",
          title: "Lease finalized",
          projectId: null,
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        repo.upsertFinding({
          hitchId: "g-lease-finalized",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "in_scope",
          summary: "fix the thing",
        });
      } finally {
        close();
      }
    }

    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "fix the thing",
      baseBranch: "main",
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async () => {
          throw new Error("outer wrapper", {
            cause: new LeaseGuardFailedError("run-stale"),
          });
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });

    await expect(runners.coder("g-lease-finalized")).rejects.toBeInstanceOf(
      LeaseGuardFailedError,
    );

    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(repo.listAttempts("g-lease-finalized")).toEqual([]);
      expect(repo.requireSession("g-lease-finalized").currentIteration).toBe(0);
    } finally {
      close();
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
          projectId: null,
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
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
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
          projectId: null,
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
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
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
          projectId: null,
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
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });
    await runners.coder("g-recover");
    expect(captured).toContain("improve the profile feature");
    expect(captured).toContain("Previous attempt failed");
    expect(captured).toContain("failed-command");
  });
});
