import type Database from "better-sqlite3";
import process from "node:process";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { coderRunnerDeps } from "../core/agent-runner.js";
import { codexBinaryVersion } from "../codex/codex-version.js";
import { createOrchestratorRunners } from "../hitch/orchestrator-runners.js";
import type { OrchestratorRunners } from "../hitch/orchestrator-types.js";
import { HitchOrchestrator } from "../hitch/orchestrator.js";
import { HitchRepository } from "../hitch/repository.js";
import type { HitchSession } from "../hitch/types.js";
import { prepareProjectRun } from "../project/run-project.js";
import { CourseOrchestrator } from "./course-orchestrator.js";

export interface CourseHitchRunnersDeps {
  prepareRun?: typeof prepareProjectRun;
  createRunners?: typeof createCodexCliRunner;
}

export interface ProductionCourseOrchestratorInput {
  db: Database.Database;
  dbPath: string;
  harnessRoot: string;
  courseId: string;
  courseProjectId: string | null;
  createdBy: string;
  codexBin?: string;
}

/**
 * Build a production `CourseOrchestrator`. ONE-SHOT: construct a fresh instance
 * per orchestrate invocation and call `.run()` once. The per-hitch runner cache
 * (`runnersByHitch`) captures the `AbortSignal` of the run that first built a
 * hitch's runners (#132), so reusing one instance across `.run()` calls would
 * bind a stale signal (an old aborted signal pre-aborting a new run, or a new
 * lease-loss abort not reaching cached runners). All CLI/MCP callers construct
 * per invocation, which is correct.
 */
export function createProductionCourseOrchestrator(
  input: ProductionCourseOrchestratorInput,
): CourseOrchestrator {
  const codexBin = input.codexBin ?? process.env.HARNESS_CODEX_BIN ?? "codex";
  const runnersByHitch = new Map<string, OrchestratorRunners>();

  return new CourseOrchestrator({
    db: input.db,
    makeHitchOrchestrator: () => new HitchOrchestrator({ dbPath: input.dbPath }),
    makeRunners: (hitchId, signal) =>
      makeCourseHitchRunners({
        ...input,
        codexBin,
        hitchId,
        runnersByHitch,
        ...(signal !== undefined ? { signal } : {}),
      }),
  });
}

export async function makeCourseHitchRunners(
  input: {
    db: Database.Database;
    dbPath: string;
    harnessRoot: string;
    codexBin: string;
    courseId: string;
    courseProjectId: string | null;
    createdBy: string;
    hitchId: string;
    runnersByHitch: Map<string, OrchestratorRunners>;
    signal?: AbortSignal;
  },
  deps: CourseHitchRunnersDeps = {},
): Promise<OrchestratorRunners> {
  const cached = input.runnersByHitch.get(input.hitchId);
  if (cached !== undefined) return cached;

  const session = new HitchRepository(input.db).requireSession(input.hitchId);
  const projectId = session.projectId ?? input.courseProjectId;
  if (projectId === null) {
    throw new Error(
      `hitch ${input.hitchId} has no projectId and course ${input.courseId} has no projectId`,
    );
  }
  if (session.domain === null) {
    throw new Error(`hitch ${input.hitchId} has no domain`);
  }

  const prepareRun = deps.prepareRun ?? prepareProjectRun;
  const createRunners = deps.createRunners ?? createCodexCliRunner;
  const prepared = await prepareRun({
    harnessRoot: input.harnessRoot,
    projectId,
    domain: session.domain,
  });
  // #191: the production coder is backend-aware (claude opt-in via
  // HARNESS_CODER_BACKEND). A test-injected `createRunners` pins codex — those
  // tests exercise the codex path and must keep receiving the fake runner.
  const coderFields = deps.createRunners
    ? {
        coderRunner: createRunners({
          codexBin: input.codexBin,
          sandbox: "workspace-write",
        }),
        coderBackend: "codex" as const,
      }
    : coderRunnerDeps(input.codexBin);
  const runners = createOrchestratorRunners({
    dbPath: input.dbPath,
    harnessRoot: input.harnessRoot,
    createdBy: input.createdBy,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...coderFields,
    coderCodexBinaryVersion: codexBinaryVersion(input.codexBin),
    reviewerRunner: createRunners({
      codexBin: input.codexBin,
      sandbox: "read-only",
    }),
    resolveRunContext: (runSession) => ({
      repoPath: prepared.repoPath,
      repoId: prepared.repoId,
      domain: prepared.domain,
      goal: hitchGoalText(runSession),
      baseBranch: prepared.baseBranch,
    }),
    projectRuntime: {
      compiledPolicy: prepared.compiledPolicy,
      reviewRuleResolution: prepared.reviewRuleResolution,
      project: prepared.project,
      ...(prepared.projectContextPacks !== undefined
        ? { projectContextPacks: prepared.projectContextPacks }
        : {}),
    },
  });
  input.runnersByHitch.set(input.hitchId, runners);
  return runners;
}

export function hitchGoalText(session: HitchSession): string {
  return [session.title, session.description ?? ""]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}
