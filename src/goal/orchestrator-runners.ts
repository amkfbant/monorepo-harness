import { withManagedDb } from "../db/managed-connection.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { GoalRepository } from "./repository.js";
import { classifyFindingForGoal } from "./classification.js";
import { assertGoalCanStartMutation } from "./mutation-gate.js";
import type { OrchestratorRunners } from "./orchestrator-types.js";
import type { GoalLifecycleStatus } from "./types.js";

/**
 * Lifecycle states that still demand attention (i.e. an "open" finding). A
 * finding whose scope is `unknown` and whose lifecycle is one of these must be
 * deterministically classified before the goal can converge.
 */
const OPEN_LIFECYCLE_STATUSES: readonly GoalLifecycleStatus[] = [
  "open",
  "reopened",
  "escalated",
];

export interface OrchestratorRunnerDeps {
  dbPath: string;
  harnessRoot: string;
  createdBy: string;
  coderRunner: CodexExecRunner;
  reviewerRunner: CodexExecRunner;
}

export function createOrchestratorRunners(
  deps: OrchestratorRunnerDeps,
): OrchestratorRunners {
  const assertGate = (
    goalId: string,
    mutationKind: "run.start" | "review.auto",
  ): void => {
    withManagedDb({ dbPath: deps.dbPath }, (db) => {
      assertGoalCanStartMutation({
        repository: new GoalRepository(db),
        goalId,
        mutationKind,
      });
    });
  };

  return {
    coder: async (goalId) => {
      assertGate(goalId, "run.start");
      throw new Error("coder runner requires the integration wiring (Task 7)");
    },
    review: async (goalId) => {
      assertGate(goalId, "review.auto");
      throw new Error("review runner requires the integration wiring (Task 7)");
    },
    classify: async (goalId) =>
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new GoalRepository(db);
        const session = repo.requireSession(goalId);
        const unknown = repo
          .listFindings({ goalId, scopeStatus: "unknown" })
          .filter((f) => OPEN_LIFECYCLE_STATUSES.includes(f.lifecycleStatus));
        for (const finding of unknown) {
          const classification = classifyFindingForGoal(session, finding);
          if (classification.scopeStatus === "unknown") {
            return {
              resolved: false,
              escalateReason: `cannot classify finding ${finding.findingId}`,
            };
          }
          repo.classifyFinding({
            findingId: finding.findingId,
            scopeStatus: classification.scopeStatus,
            reason: classification.reason,
          });
        }
        return { resolved: true };
      }),
    closeAndPr: async (goalId) => {
      assertGate(goalId, "run.start");
      throw new Error(
        "closeAndPr runner requires the integration wiring (Task 7)",
      );
    },
  };
}
