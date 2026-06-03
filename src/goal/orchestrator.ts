import { withManagedDb } from "../db/managed-connection.js";
import { GoalRepository } from "./repository.js";
import { evaluateConvergenceAndRecordStatus } from "./convergence-status.js";
import { decideOrchestratorAction } from "./orchestrator-dispatch.js";
import type {
  OrchestrationResult,
  OrchestrationStep,
  OrchestratorRunners,
} from "./orchestrator-types.js";

export interface GoalOrchestratorOpts {
  dbPath: string;
}

export interface RunOrchestrationInput {
  goalId: string;
  runners: OrchestratorRunners;
  maxSteps: number;
  createdBy: string;
}

export class GoalOrchestrator {
  constructor(private readonly opts: GoalOrchestratorOpts) {}

  async run(input: RunOrchestrationInput): Promise<OrchestrationResult> {
    const steps: OrchestrationStep[] = [];
    let finalDecision = "";
    for (let i = 1; i <= input.maxSteps; i++) {
      const convergence = withManagedDb({ dbPath: this.opts.dbPath }, (db) =>
        evaluateConvergenceAndRecordStatus({
          repository: new GoalRepository(db),
          goalId: input.goalId,
          createdBy: input.createdBy,
        }),
      );
      finalDecision = convergence.decision;
      const action = decideOrchestratorAction(convergence);

      if (action.kind === "stop") {
        steps.push({ step: i, decision: finalDecision, action: "stop", detail: action.outcome });
        return { goalId: input.goalId, outcome: action.outcome, steps, finalDecision };
      }
      if (action.kind === "escalate") {
        steps.push({ step: i, decision: finalDecision, action: "escalate", detail: action.reason });
        return { goalId: input.goalId, outcome: "escalated", steps, finalDecision, escalateReason: action.reason };
      }
      if (action.kind === "coder") {
        const r = await input.runners.coder(input.goalId);
        steps.push({ step: i, decision: finalDecision, action: "coder", detail: r.runStatus });
        continue;
      }
      if (action.kind === "review") {
        const r = await input.runners.review(input.goalId);
        steps.push({ step: i, decision: finalDecision, action: "review", detail: r.decision });
        continue;
      }
      if (action.kind === "classify") {
        const r = await input.runners.classify(input.goalId);
        steps.push({ step: i, decision: finalDecision, action: "classify", detail: String(r.resolved) });
        if (!r.resolved) {
          return { goalId: input.goalId, outcome: "escalated", steps, finalDecision, escalateReason: r.escalateReason ?? "classification unresolved" };
        }
        continue;
      }
      const pr = await input.runners.closeAndPr(input.goalId);
      steps.push({ step: i, decision: finalDecision, action: "close_and_pr", detail: pr.prUrl });
      return { goalId: input.goalId, outcome: "pr_created", steps, finalDecision, prUrl: pr.prUrl };
    }
    return { goalId: input.goalId, outcome: "max_steps_exhausted", steps, finalDecision };
  }
}
