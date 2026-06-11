import { withManagedDb } from "../db/managed-connection.js";
import { HitchRepository } from "./repository.js";
import { evaluateConvergenceAndRecordStatus } from "./convergence-status.js";
import { decideOrchestratorAction } from "./orchestrator-dispatch.js";
import type {
  OrchestrationOutcome,
  HitchOrchestrationResult,
  OrchestrationStep,
  OrchestratorRunners,
} from "./orchestrator-types.js";

export interface HitchOrchestratorOpts {
  dbPath: string;
}

export interface RunOrchestrationInput {
  hitchId: string;
  runners: OrchestratorRunners;
  maxSteps: number;
  createdBy: string;
  /**
   * Halt at `close_ready` WITHOUT running close/PR (returns outcome
   * `close_ready`). For drivers that only mean to advance the work — e.g.
   * `classify --then-rerun`, which reruns the coder but must not silently open a
   * PR / close the goal. Opening the PR stays a deliberate, separate step
   * (`goal orchestrate` / `goal await-merge`).
   */
  stopAtCloseReady?: boolean;
}

export class HitchOrchestrator {
  constructor(private readonly opts: HitchOrchestratorOpts) {}

  async run(input: RunOrchestrationInput): Promise<HitchOrchestrationResult> {
    if (!Number.isInteger(input.maxSteps) || input.maxSteps < 1) {
      throw new Error(
        `maxSteps must be a positive integer (got ${input.maxSteps})`,
      );
    }
    const steps: OrchestrationStep[] = [];
    let finalDecision = "";
    for (let i = 1; i <= input.maxSteps; i++) {
      const convergence = withManagedDb({ dbPath: this.opts.dbPath }, (db) =>
        evaluateConvergenceAndRecordStatus({
          repository: new HitchRepository(db),
          hitchId: input.hitchId,
          createdBy: input.createdBy,
        }),
      );
      finalDecision = convergence.decision;
      const action = decideOrchestratorAction(convergence);

      if (action.kind === "stop") {
        steps.push({ step: i, decision: finalDecision, action: "stop", detail: action.outcome });
        return { hitchId: input.hitchId, outcome: action.outcome, steps, finalDecision };
      }
      if (action.kind === "escalate") {
        steps.push({ step: i, decision: finalDecision, action: "escalate", detail: action.reason });
        return { hitchId: input.hitchId, outcome: "escalated", steps, finalDecision, escalateReason: action.reason };
      }
      // A runner throwing (e.g. a coder/review/PR failure, or the documented
      // "fresh goal → review before any run exists" precondition gap) must not
      // crash the orchestrator. Turn it into a clean escalation: record the
      // step, flip the goal to `escalated`, and return.
      try {
        if (action.kind === "coder") {
          const r = await input.runners.coder(input.hitchId);
          steps.push({ step: i, decision: finalDecision, action: "coder", detail: r.runStatus });
          continue;
        }
        if (action.kind === "review") {
          const r = await input.runners.review(input.hitchId);
          steps.push({ step: i, decision: finalDecision, action: "review", detail: r.decision });
          continue;
        }
        if (action.kind === "classify") {
          const r = await input.runners.classify(input.hitchId);
          steps.push({ step: i, decision: finalDecision, action: "classify", detail: String(r.resolved) });
          if (!r.resolved) {
            return { hitchId: input.hitchId, outcome: "escalated", steps, finalDecision, escalateReason: r.escalateReason ?? "classification unresolved" };
          }
          continue;
        }
        if (action.kind === "defer") {
          const r = await input.runners.defer(input.hitchId);
          steps.push({ step: i, decision: finalDecision, action: "defer", detail: String(r.deferred) });
          continue;
        }
        // Halt before the close/PR step when the caller only means to advance
        // the work (e.g. classify --then-rerun): reaching close_ready is the
        // signal to stop; opening the PR is a deliberate, separate step.
        if (input.stopAtCloseReady === true) {
          steps.push({ step: i, decision: finalDecision, action: "close_and_pr", detail: "halted before PR (stopAtCloseReady)" });
          return { hitchId: input.hitchId, outcome: "close_ready", steps, finalDecision };
        }
        const pr = await input.runners.closeAndPr(input.hitchId);
        // Phase 3: a hard-blocked auto-merge gate escalates rather than closing.
        if (pr.escalateReason !== undefined) {
          steps.push({ step: i, decision: finalDecision, action: "escalate", detail: pr.escalateReason });
          withManagedDb({ dbPath: this.opts.dbPath }, (db) => {
            new HitchRepository(db).updateStatus(input.hitchId, "escalated", pr.escalateReason as string);
          });
          return {
            hitchId: input.hitchId,
            outcome: "escalated",
            steps,
            finalDecision,
            escalateReason: pr.escalateReason,
            prUrl: pr.prUrl,
            draft: pr.draft,
          };
        }
        const outcome: OrchestrationOutcome = pr.merged === true ? "merged" : "pr_created";
        steps.push({ step: i, decision: finalDecision, action: "close_and_pr", detail: pr.prUrl });
        return {
          hitchId: input.hitchId,
          outcome,
          steps,
          finalDecision,
          prUrl: pr.prUrl,
          draft: pr.draft,
        };
      } catch (e) {
        let message = e instanceof Error ? e.message : String(e);
        if (
          action.kind === "review" &&
          input.runners.salvageReviewBranch !== undefined
        ) {
          try {
            const salvage = await input.runners.salvageReviewBranch(
              input.hitchId,
            );
            if (salvage !== null) {
              message +=
                `; workspace branch pushed: ${salvage.branch}` +
                ` (${salvage.headSha})`;
            }
          } catch (salvageError) {
            message +=
              `; workspace branch salvage failed: ` +
              `${salvageError instanceof Error ? salvageError.message : String(salvageError)}`;
          }
        }
        steps.push({ step: i, decision: finalDecision, action: "escalate", detail: message });
        withManagedDb({ dbPath: this.opts.dbPath }, (db) => {
          new HitchRepository(db).updateStatus(input.hitchId, "escalated", message);
        });
        return { hitchId: input.hitchId, outcome: "escalated", steps, finalDecision, escalateReason: message };
      }
    }
    return { hitchId: input.hitchId, outcome: "max_steps_exhausted", steps, finalDecision };
  }
}
