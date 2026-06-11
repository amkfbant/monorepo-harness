import type Database from "better-sqlite3";
import process from "node:process";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { createOrchestratorRunners } from "../hitch/orchestrator-runners.js";
import type { OrchestratorRunners } from "../hitch/orchestrator-types.js";
import { HitchOrchestrator } from "../hitch/orchestrator.js";
import { HitchRepository } from "../hitch/repository.js";
import type { HitchSession } from "../hitch/types.js";
import { prepareProjectRun } from "../project/run-project.js";
import { CourseOrchestrator } from "./course-orchestrator.js";

export interface ProductionCourseOrchestratorInput {
  db: Database.Database;
  dbPath: string;
  harnessRoot: string;
  courseId: string;
  courseProjectId: string | null;
  createdBy: string;
  codexBin?: string;
}

export function createProductionCourseOrchestrator(
  input: ProductionCourseOrchestratorInput,
): CourseOrchestrator {
  const codexBin = input.codexBin ?? process.env.HARNESS_CODEX_BIN ?? "codex";
  const runnersByHitch = new Map<string, OrchestratorRunners>();

  return new CourseOrchestrator({
    db: input.db,
    makeHitchOrchestrator: () => new HitchOrchestrator({ dbPath: input.dbPath }),
    makeRunners: (hitchId) =>
      makeCourseHitchRunners({
        ...input,
        codexBin,
        hitchId,
        runnersByHitch,
      }),
  });
}

async function makeCourseHitchRunners(input: {
  db: Database.Database;
  dbPath: string;
  harnessRoot: string;
  codexBin: string;
  courseId: string;
  courseProjectId: string | null;
  createdBy: string;
  hitchId: string;
  runnersByHitch: Map<string, OrchestratorRunners>;
}): Promise<OrchestratorRunners> {
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

  const prepared = await prepareProjectRun({
    harnessRoot: input.harnessRoot,
    projectId,
    domain: session.domain,
  });
  const runners = createOrchestratorRunners({
    dbPath: input.dbPath,
    harnessRoot: input.harnessRoot,
    createdBy: input.createdBy,
    coderRunner: createCodexCliRunner({
      codexBin: input.codexBin,
      sandbox: "workspace-write",
    }),
    reviewerRunner: createCodexCliRunner({
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
  });
  input.runnersByHitch.set(input.hitchId, runners);
  return runners;
}

function hitchGoalText(session: HitchSession): string {
  return [session.title, session.description ?? ""]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}
