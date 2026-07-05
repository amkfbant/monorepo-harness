import { withManagedDb } from "../db/managed-connection.js";
import { HitchRepository } from "./repository.js";
import {
  evaluateConvergenceAndRecordStatus,
  recordConvergenceDecisionWithStatus,
} from "./convergence-status.js";
import { decideOrchestratorAction } from "./orchestrator-dispatch.js";
import { findTransientLeaseCause } from "../workspace/db-domain-lock.js";
import type {
  OrchestrationOutcome,
  HitchOrchestrationResult,
  OrchestrationProgressEvent,
  OrchestrationStep,
  OrchestratorRunners,
  OrchestratorAction,
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
   * PR / close the hitch. Opening the PR stays a deliberate, separate step
   * (`hitch orchestrate` / `hitch await-merge`).
   */
  stopAtCloseReady?: boolean;
  /**
   * Interrupt the in-flight drive (#132). The course orchestrator aborts this on
   * lease loss; the loop stops between steps and the abort is propagated (as a
   * transient lease error, so the course maps it to `lease_lost`) rather than
   * escalating the hitch. The signal is also threaded to the codex runner, which
   * SIGKILLs the in-flight codex process.
   */
  signal?: AbortSignal;
  /**
   * Optional human-visible progress sink for standalone drivers. It is
   * observational only: failures in the sink never affect hitch state.
   */
  onProgress?: (event: OrchestrationProgressEvent) => void;
  /** Wall-clock heartbeat cadence while a runner step is still in flight. */
  progressHeartbeatMs?: number;
}

const DEFAULT_PROGRESS_HEARTBEAT_MS = 30_000;

/**
 * The error to throw when the drive is aborted (#132): the abort reason set by
 * `AbortController.abort(leaseError)` (a `LeaseLostError`/`LeaseGuardFailedError`,
 * which `findTransientLeaseCause` recognizes), or a generic fallback.
 */
function abortCause(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("hitch drive aborted (course lease lost)");
}

/**
 * Whether the drive signal has fired. A function call (not an inline
 * `signal?.aborted` check) so TS does not narrow `aborted` to `false` after the
 * loop-top guard — an awaited runner step can flip it to true mid-iteration.
 */
function driveAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

function progressElapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function emitProgress(
  input: RunOrchestrationInput,
  event: OrchestrationProgressEvent,
): void {
  try {
    input.onProgress?.(event);
  } catch {
    // Progress output is advisory; hitch state transitions must not depend on it.
  }
}

function maybeUnrefTimer(timer: ReturnType<typeof setInterval>): void {
  const candidate = timer as unknown as { unref?: unknown };
  if (typeof candidate.unref === "function") candidate.unref();
}

async function withStepProgress<T>(
  input: RunOrchestrationInput,
  step: number,
  decision: string,
  action: OrchestratorAction["kind"],
  run: () => Promise<T>,
  detail: (result: T) => string,
): Promise<T> {
  const startedAt = Date.now();
  emitProgress(input, {
    kind: "step_started",
    hitchId: input.hitchId,
    step,
    decision,
    action,
  });
  const heartbeatMs = Math.max(
    1,
    input.progressHeartbeatMs ?? DEFAULT_PROGRESS_HEARTBEAT_MS,
  );
  const heartbeat =
    input.onProgress === undefined
      ? undefined
      : setInterval(() => {
          emitProgress(input, {
            kind: "step_heartbeat",
            hitchId: input.hitchId,
            step,
            decision,
            action,
            elapsedMs: progressElapsed(startedAt),
          });
        }, heartbeatMs);
  if (heartbeat !== undefined) maybeUnrefTimer(heartbeat);
  try {
    const result = await run();
    emitProgress(input, {
      kind: "step_completed",
      hitchId: input.hitchId,
      step,
      decision,
      action,
      detail: detail(result),
      elapsedMs: progressElapsed(startedAt),
    });
    return result;
  } catch (e) {
    emitProgress(input, {
      kind: "step_failed",
      hitchId: input.hitchId,
      step,
      decision,
      action,
      detail: e instanceof Error ? e.message : String(e),
      elapsedMs: progressElapsed(startedAt),
    });
    throw e;
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
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
      // #132 — stop between steps when the course lease was lost mid-drive.
      // Propagate the abort cause (a transient lease error) so the course maps
      // it to `lease_lost`; do not run another step or escalate the hitch.
      if (driveAborted(input.signal)) throw abortCause(input.signal);
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
      // "fresh hitch → review before any run exists" precondition gap) must not
      // crash the orchestrator. Turn it into a clean escalation: record the
      // step, flip the hitch to `escalated`, and return.
      try {
        if (action.kind === "coder") {
          const r = await withStepProgress(
            input,
            i,
            finalDecision,
            action.kind,
            () => input.runners.coder(input.hitchId),
            (result) => `${result.runStatus} run=${result.runId}`,
          );
          steps.push({ step: i, decision: finalDecision, action: "coder", detail: r.runStatus });
          continue;
        }
        if (action.kind === "review") {
          const r = await withStepProgress(
            input,
            i,
            finalDecision,
            action.kind,
            () => input.runners.review(input.hitchId),
            (result) => `${result.decision} run=${result.runId}`,
          );
          steps.push({ step: i, decision: finalDecision, action: "review", detail: r.decision });
          continue;
        }
        if (action.kind === "close_check") {
          const r = await withStepProgress(
            input,
            i,
            finalDecision,
            action.kind,
            () => input.runners.closeCheck(input.hitchId),
            (result) => `${result.passed}/${result.checked} passed run=${result.runId}`,
          );
          steps.push({
            step: i,
            decision: finalDecision,
            action: "close_check",
            detail: `${r.passed}/${r.checked} passed`,
          });
          continue;
        }
        if (action.kind === "classify") {
          const r = await withStepProgress(
            input,
            i,
            finalDecision,
            action.kind,
            () => input.runners.classify(input.hitchId),
            (result) => `resolved=${result.resolved}`,
          );
          steps.push({ step: i, decision: finalDecision, action: "classify", detail: String(r.resolved) });
          if (!r.resolved) {
            // (#230 / WI-9b) Persist the consultant-grade decision packet to
            // `hitch_convergence_decisions` BEFORE returning the escalation, so
            // the packet (jury reasoning / next actions) survives for the
            // operator (dashboard, escalation log). Reuse THIS iteration's
            // convergence metrics. The status syncs to `escalated` (default
            // updateStatus:true) — correct here. State transitions stay
            // harness-only: the LLM never writes status; this deterministic
            // record is the only sync.
            const escalateReason =
              r.escalateReason ?? "classification unresolved";
            withManagedDb({ dbPath: this.opts.dbPath }, (db) => {
              recordConvergenceDecisionWithStatus({
                repository: new HitchRepository(db),
                hitchId: input.hitchId,
                decision: "escalate",
                reason: escalateReason,
                metrics: convergence.metrics,
                recommendedNextAction: r.recommendedNextAction,
                createdBy: input.createdBy,
              });
            });
            return { hitchId: input.hitchId, outcome: "escalated", steps, finalDecision, escalateReason };
          }
          // (#230 / D2b / design §0.1 R3) A resolved classify may still carry a
          // non-escalating severity-audit packet: the jury reached scope
          // unanimity AND auto-confirmed (status already advanced by the runner),
          // but the deterministic severity audit diverged from the harness
          // mapping. Record the advisory packet ONCE so the operator can review
          // it, WITHOUT touching the hitch status or the course/phase rollup.
          // `decision:"continue"` is safe on TWO independent axes:
          //   1. it is OUTSIDE the course/phase blocking gate's blocked-set
          //      (orchestrate-dispatch BLOCKED_DECISIONS =
          //      {escalate, diverging, budget_exhausted, needs_classification}),
          //      so it never blocks the linked phase via decideCoursePhaseAction;
          //   2. `statusForConvergenceDecision("continue") === null`, so the
          //      explicit `updateStatus:false` leaves the hitch status untouched.
          // State transitions stay harness-only: the LLM never writes status; this
          // deterministic, status-neutral record is purely advisory.
          //
          // The advisory record is wrapped in its own try/catch (Finding 2): the
          // scope auto_confirm has ALREADY been committed by the classify runner,
          // so a transient failure persisting this purely-advisory severity note
          // must NOT fall through to the outer catch and ESCALATE an already-
          // converged-and-classified hitch. The escalate-path (D2) persistence
          // above is deliberately NOT guarded — its failure SHOULD escalate.
          if (r.severityAuditPacket !== undefined) {
            const packet = r.severityAuditPacket;
            const findingIds = packet.findings.map((f) => f.findingId);
            try {
              withManagedDb({ dbPath: this.opts.dbPath }, (db) => {
                recordConvergenceDecisionWithStatus({
                  repository: new HitchRepository(db),
                  hitchId: input.hitchId,
                  updateStatus: false,
                  decision: "continue",
                  reason:
                    "advisory: jury severity vote diverged from the harness mapping (severity unchanged)",
                  metrics: convergence.metrics,
                  // (#230 / codex#254-P2 FIX1) Tag this row as ADVISORY so the
                  // course/phase rollup DISPLAY (latestDecisionForPhase) ignores
                  // it. Without the tag this newest `continue` row would mask a
                  // still-blocking live convergence in `course status` /
                  // `course export --md`. The row stays persisted/retrievable;
                  // only the display skips it.
                  advisory: true,
                  recommendedNextAction: {
                    kind: "ask_human",
                    message:
                      "Review the diverged severity audit; the harness severity mapping is authoritative and unchanged.",
                    findingIds,
                    decisionPacket: packet,
                  },
                  createdBy: input.createdBy,
                });
              });
            } catch {
              // Swallow-and-continue: the classification already landed; the
              // advisory severity note is non-critical and must never escalate a
              // converged hitch. (Only the D2b advisory record is swallowed.)
            }
          }
          // (#230 / codex#252-P2) A jury batch was capped this invocation
          // (`moreUnknownsPending`): halt the loop cleanly so per-invocation cost
          // is bounded to one jury batch. Breaking falls through to the natural
          // end-of-loop `max_steps_exhausted` return (a non-escalate outcome);
          // the NEXT orchestrate invocation re-fires needs_classification and
          // drains the remaining unknowns. Re-running classify in THIS invocation
          // would loop up to maxSteps, breaking the cost bound.
          if (r.moreUnknownsPending === true) break;
          continue;
        }
        if (action.kind === "defer") {
          const r = await withStepProgress(
            input,
            i,
            finalDecision,
            action.kind,
            () => input.runners.defer(input.hitchId),
            (result) => `deferred=${result.deferred}`,
          );
          steps.push({ step: i, decision: finalDecision, action: "defer", detail: String(r.deferred) });
          continue;
        }
        if (action.kind === "wait") {
          steps.push({
            step: i,
            decision: finalDecision,
            action: "wait",
            detail: action.reason,
          });
          return {
            hitchId: input.hitchId,
            outcome: "waiting",
            steps,
            finalDecision,
          };
        }
        // Halt before the close/PR step when the caller only means to advance
        // the work (e.g. classify --then-rerun): reaching close_ready is the
        // signal to stop; opening the PR is a deliberate, separate step.
        if (input.stopAtCloseReady === true) {
          steps.push({ step: i, decision: finalDecision, action: "close_and_pr", detail: "halted before PR (stopAtCloseReady)" });
          return { hitchId: input.hitchId, outcome: "close_ready", steps, finalDecision };
        }
        const pr = await withStepProgress(
          input,
          i,
          finalDecision,
          "close_and_pr",
          () => input.runners.closeAndPr(input.hitchId),
          (result) =>
            result.escalateReason !== undefined
              ? `escalate=${result.escalateReason}`
              : result.pushRetryPending === true
                ? `push_retry_pending pr=${result.prUrl}`
                : `pr=${result.prUrl}`,
        );
        // Phase 3: a hard-blocked auto-merge gate escalates rather than closing.
        if (pr.escalateReason !== undefined) {
          steps.push({ step: i, decision: finalDecision, action: "escalate", detail: pr.escalateReason });
          withManagedDb({ dbPath: this.opts.dbPath }, (db) => {
            new HitchRepository(db).updateStatus(
              input.hitchId,
              "escalated",
              pr.escalateReason as string,
              { createdBy: input.createdBy },
            );
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
        // (#396 part 2) a transient close-push recheck left the hitch close_ready
        // with no PR → `push_retry_pending` (re-run to retry), distinct from a real
        // pr_created/merged. The runner already persisted close_ready.
        const outcome: OrchestrationOutcome =
          pr.pushRetryPending === true
            ? "push_retry_pending"
            : pr.merged === true
              ? "merged"
              : "pr_created";
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
        // #132 — an abort that fired during this step (e.g. the course lease was
        // lost and the codex process was SIGKILLed, surfacing as a step error)
        // must propagate as the lease cause, NOT escalate the hitch.
        if (driveAborted(input.signal)) throw abortCause(input.signal);
        const transientLeaseError = findTransientLeaseCause(e);
        if (transientLeaseError !== undefined) throw transientLeaseError;
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
          new HitchRepository(db).updateStatus(input.hitchId, "escalated", message, {
            createdBy: input.createdBy,
          });
        });
        return { hitchId: input.hitchId, outcome: "escalated", steps, finalDecision, escalateReason: message };
      }
    }
    // #132 (round-2 FIX 4) — the loop exhausted its steps. A step (notably the
    // classify runner) may have aborted the lease mid-run and returned the benign
    // no-op resolved:true, relying on the NEXT loop-top guard to map it to
    // lease_lost. With maxSteps:1 there is NO next iteration, so this post-loop
    // guard (OUTSIDE the per-iteration try/catch, so it is never swallowed into an
    // escalate) is what propagates the abort cause on the final step. Without it
    // the final-step lease loss would fall through as the benign
    // max_steps_exhausted instead of lease_lost.
    if (driveAborted(input.signal)) throw abortCause(input.signal);
    return { hitchId: input.hitchId, outcome: "max_steps_exhausted", steps, finalDecision };
  }
}
