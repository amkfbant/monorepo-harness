import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import type { OrchestratorRunners } from "../../../src/hitch/orchestrator-types.js";
import type { CodexExecRunner } from "../../../src/codex/codex-exec-runner.js";
import type { PreparedProjectRun } from "../../../src/project/run-project.js";
import {
  hitchGoalText,
  makeCourseHitchRunners,
  type CourseHitchRunnersDeps,
} from "../../../src/roadmap/course-orchestrate-runtime.js";

type MakeRunnersInput = Parameters<typeof makeCourseHitchRunners>[0];
type PrepareRun = NonNullable<CourseHitchRunnersDeps["prepareRun"]>;

function preparedProjectRun(opts: Parameters<PrepareRun>[0]): PreparedProjectRun {
  return {
    repoPath: "/tmp/repo",
    repoId: "repo-1",
    domain: opts.domain,
    baseBranch: "main",
    compiledPolicy: {
      global: {
        always_deny_write: [],
        ignore_untracked: [],
      },
      repo: {
        repo_id: "repo-1",
        read: [],
        domains: {
          [opts.domain]: {
            read: [],
            write: [],
            deny_write: [],
          },
        },
      },
    },
    resolvedPolicy: {
      repoId: "repo-1",
      domain: opts.domain,
      read: [],
      write: [],
      denyWrite: [],
      allowedCommands: [],
      commandDefaults: { timeoutMs: 300_000 },
      ignoreUntracked: [],
      codex: { sandbox: "workspace-write" },
      limits: { gitTimeoutMs: 30_000 },
    },
    project: {
      projectId: opts.projectId,
      profilePath: "/tmp/project.yml",
      profileVersion: 1,
      commandPresetIds: [],
      contextPackIds: [],
    },
  };
}

function fakePrepareRun(calls: Parameters<PrepareRun>[0][]): PrepareRun {
  return async (opts) => {
    calls.push(opts);
    return preparedProjectRun(opts);
  };
}

function fakeCodexRunner(): CodexExecRunner {
  return {
    run: async () => ({ exitCode: 0, timedOut: false }),
  };
}

describe("course orchestrate runtime", () => {
  let db: Database.Database;
  let hitches: HitchRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    hitches = new HitchRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createHitch(input: {
    hitchId: string;
    projectId?: string;
    domain?: string;
    title?: string;
    description?: string;
  }) {
    return hitches.createSession({
      hitchId: input.hitchId,
      title: input.title ?? `Hitch ${input.hitchId}`,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
      scope: {},
      closeConditions: [],
      createdBy: "test",
      createdSource: "cli",
      createdAt: "2026-06-12T00:00:00.000Z",
    });
  }

  function makeInput(
    hitchId: string,
    courseProjectId: string | null,
    runnersByHitch = new Map<string, OrchestratorRunners>(),
  ): MakeRunnersInput {
    return {
      db,
      dbPath: ":memory:",
      harnessRoot: "/tmp/harness",
      codexBin: "codex",
      courseId: "course-1",
      courseProjectId,
      createdBy: "test",
      hitchId,
      runnersByHitch,
    };
  }

  it("falls back to the course projectId when the hitch projectId is null", async () => {
    createHitch({ hitchId: "h-fallback", domain: "roadmap" });
    const calls: Parameters<PrepareRun>[0][] = [];

    await makeCourseHitchRunners(makeInput("h-fallback", "p1"), {
      prepareRun: fakePrepareRun(calls),
    });

    expect(calls).toEqual([
      {
        harnessRoot: "/tmp/harness",
        projectId: "p1",
        domain: "roadmap",
      },
    ]);
  });

  it("rejects when both hitch and course projectId are null", async () => {
    createHitch({ hitchId: "h-no-project", domain: "roadmap" });

    await expect(
      makeCourseHitchRunners(makeInput("h-no-project", null), {
        prepareRun: fakePrepareRun([]),
      }),
    ).rejects.toThrow(
      /hitch h-no-project has no projectId and course course-1 has no projectId/,
    );
  });

  it("rejects when a project-scoped hitch has a null domain", async () => {
    createHitch({ hitchId: "h-no-domain", projectId: "p1" });

    await expect(
      makeCourseHitchRunners(makeInput("h-no-domain", null), {
        prepareRun: fakePrepareRun([]),
      }),
    ).rejects.toThrow(/hitch h-no-domain has no domain/);
  });

  it("caches runners per hitchId and prepares again for a different hitchId", async () => {
    createHitch({ hitchId: "h-cache", projectId: "p1", domain: "roadmap" });
    createHitch({ hitchId: "h-other", projectId: "p1", domain: "roadmap" });
    const calls: Parameters<PrepareRun>[0][] = [];
    const runnersByHitch = new Map<string, OrchestratorRunners>();
    const deps: CourseHitchRunnersDeps = {
      prepareRun: fakePrepareRun(calls),
      createRunners: () => fakeCodexRunner(),
    };

    const first = await makeCourseHitchRunners(
      makeInput("h-cache", null, runnersByHitch),
      deps,
    );
    const second = await makeCourseHitchRunners(
      makeInput("h-cache", null, runnersByHitch),
      deps,
    );
    const other = await makeCourseHitchRunners(
      makeInput("h-other", null, runnersByHitch),
      deps,
    );

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.projectId)).toEqual(["p1", "p1"]);
  });

  it("builds hitch goal text from title and optional description", () => {
    const withDescription = createHitch({
      hitchId: "h-goal-description",
      title: "  Implement fix  ",
      description: "  Pass the audit checks.  ",
    });
    const titleOnly = createHitch({
      hitchId: "h-goal-title-only",
      title: "  Implement fix  ",
    });
    const blankDescription = createHitch({
      hitchId: "h-goal-blank-description",
      title: "  Implement fix  ",
      description: "   ",
    });

    expect(hitchGoalText(withDescription)).toBe(
      "Implement fix\n\nPass the audit checks.",
    );
    expect(hitchGoalText(titleOnly)).toBe("Implement fix");
    expect(hitchGoalText(blankDescription)).toBe("Implement fix");
  });
});
