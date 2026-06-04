import { randomUUID } from "node:crypto";
import { openManagedDb, withManagedDb } from "../db/managed-connection.js";
import { harnessPaths } from "../config/paths.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import {
  runDomainCoding,
  RunFinalizedError,
} from "../core/workflow-runner.js";
import { runReviewerAgent } from "../core/reviewer-agent.js";
import { processReviewDecision } from "../core/review-processor.js";
import {
  createPullRequest,
  type PrPublisher,
  type PrMerger,
  type PrMergeMethod,
} from "../core/pr-creator.js";
import {
  evaluateMergeGate,
  quorumSatisfiedFromRequirements,
  type MergeGateConsensus,
} from "../core/merge-gate.js";
import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import { ReviewOverridesRepository } from "../db/repositories/review-overrides.js";
import {
  startOperation,
  succeedOperation,
  failOperation,
} from "../db/repositories/operations.js";
import type { ConsensusSummary } from "../core/review-consensus.js";
import { GoalRepository } from "./repository.js";
import { classifyFindingForGoal } from "./classification.js";
import { deferFindingToBacklog } from "./followups.js";
import { ConvergenceService } from "./convergence.js";
import { assertGoalCanStartMutation } from "./mutation-gate.js";
import { importReviewProposalToGoal } from "./review-integration.js";
import { dbConsensusSnapshotProvider } from "./consensus-stall-check.js";
import { nextReviewMode } from "./review-mode.js";
import type { OrchestratorRunners } from "./orchestrator-types.js";
import type {
  GoalAttemptType,
  GoalLifecycleStatus,
  GoalReviewMode,
  GoalSession,
} from "./types.js";

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

/**
 * Lifecycle states of an out-of-scope finding that convergence still treats as
 * needing deferral (`UNRESOLVED_OUT_OF_SCOPE_LIFECYCLES` in convergence.ts).
 * `classifyFinding` sets an out-of-scope finding's lifecycle to `out_of_scope`,
 * so the defer runner must include it (the generic OPEN set does not).
 */
const DEFERRABLE_OUT_OF_SCOPE_LIFECYCLES: readonly GoalLifecycleStatus[] = [
  "open",
  "reopened",
  "out_of_scope",
];

/**
 * The concrete repo/run context a goal session does not itself store. The
 * session has `repoId` / `domain` and the goal text (title/description), but
 * the on-disk repo path and base branch must be supplied by the caller. The
 * CLI resolves these from its `--repo` / `--base-branch` flags; tests pass a
 * throwaway git repo.
 */
export interface GoalRunContext {
  repoPath: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
}

export interface OrchestratorRunnerDeps {
  dbPath: string;
  harnessRoot: string;
  createdBy: string;
  coderRunner: CodexExecRunner;
  reviewerRunner: CodexExecRunner;
  /**
   * Publisher used by `closeAndPr`. The git side is exercised with a local
   * bare remote in tests via a fake; production wires the real `gh` publisher.
   * Required for `closeAndPr` (a clear error is thrown if it is missing).
   */
  publisher?: PrPublisher;
  /**
   * Phase 3: opt-in auto-merge. Omitted (default) = auto-merge OFF — `closeAndPr`
   * only creates the PR. When present, `closeAndPr` evaluates the merge gate
   * after creating the PR and, if it passes, merges via `merger`; a hard-blocked
   * gate escalates (fail-closed); CI-not-green leaves the PR open.
   */
  autoMerge?: {
    merger: PrMerger;
    /**
     * Returns whether the PR's required checks are green FOR the expected
     * reviewed commit (a head mismatch returns false → leave the PR open).
     */
    ciStatus: (prNumber: number, expectedHeadSha: string) => Promise<boolean>;
    method?: PrMergeMethod;
  };
  /**
   * Resolve the repo/run context for a goal's session. Defaults to deriving
   * the goal text from the session title/description, the repoId/domain from
   * the session, and the base branch to `main`; the repo path is taken from
   * `repoPath` below. Override for full control (e.g. project-mode runs).
   */
  resolveRunContext?: (session: GoalSession) => GoalRunContext;
  /**
   * Repo path used by the default `resolveRunContext`. Ignored when a custom
   * `resolveRunContext` is supplied.
   */
  repoPath?: string;
  /** Base branch used by the default `resolveRunContext` (default "main"). */
  baseBranch?: string;
}

function defaultGoalText(session: GoalSession): string {
  const parts = [session.title, session.description ?? ""]
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return parts.join("\n\n");
}

function resolveRunContext(
  deps: OrchestratorRunnerDeps,
  session: GoalSession,
): GoalRunContext {
  if (deps.resolveRunContext !== undefined) {
    return deps.resolveRunContext(session);
  }
  if (session.repoId === null || session.domain === null) {
    throw new Error(
      `goal ${session.goalId} has no repoId/domain; cannot run the coder ` +
        `(provide resolveRunContext or set the goal's repoId+domain)`,
    );
  }
  if (deps.repoPath === undefined) {
    throw new Error(
      `goal ${session.goalId}: no repoPath configured for the orchestrator ` +
        `(pass deps.repoPath or deps.resolveRunContext)`,
    );
  }
  return {
    repoPath: deps.repoPath,
    repoId: session.repoId,
    domain: session.domain,
    goal: defaultGoalText(session),
    baseBranch: deps.baseBranch ?? "main",
  };
}

/** Attempt types that produce a coding run whose runId review/PR operate on. */
const CODING_ATTEMPT_TYPES = new Set<GoalAttemptType>(["implement", "rerun"]);

/**
 * The latest run id recorded against a goal — the run the review / pr steps
 * operate on. Attempts are ordered (iteration ASC, created_at ASC), so the
 * last CODING attempt (implement / rerun) carrying a runId is the most recent
 * run. A close-check or other attempt's runId must not be picked.
 */
export function latestRunId(repo: GoalRepository, goalId: string): string {
  const attempts = repo.listAttempts(goalId);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    const runId = attempt.runId;
    if (typeof runId === "string" && runId !== "") return runId;
  }
  throw new Error(
    `goal ${goalId} has no recorded run yet; run the coder before reviewing`,
  );
}

function reviewModeForGoal(
  repo: GoalRepository,
  session: GoalSession,
): GoalReviewMode {
  return nextReviewMode(session, repo.listReviewCycles(session.goalId));
}

export function createOrchestratorRunners(
  deps: OrchestratorRunnerDeps,
): OrchestratorRunners {
  const paths = harnessPaths(deps.harnessRoot);
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
      const { attemptId, context } = withManagedDb(
        { dbPath: deps.dbPath },
        (db) => {
          const repo = new GoalRepository(db);
          const s = repo.requireSession(goalId);
          const ctx = resolveRunContext(deps, s);
          // a goal that already has a coding attempt is iterating on review
          // feedback → "rerun"; the first pass is "implement".
          const prior = repo
            .listAttempts(goalId)
            .some(
              (a) =>
                a.attemptType === "implement" || a.attemptType === "rerun",
            );
          const attempt = repo.createAttempt({
            goalId,
            attemptType: prior ? "rerun" : "implement",
            status: "running",
          });
          return { attemptId: attempt.attemptId, context: ctx };
        },
      );
      try {
        const result = await runDomainCoding({
          harnessRoot: deps.harnessRoot,
          repoPath: context.repoPath,
          repoId: context.repoId,
          domain: context.domain,
          goal: context.goal,
          baseBranch: context.baseBranch,
          codexRunner: deps.coderRunner,
        });
        const succeeded = result.status === "needs_review";
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new GoalRepository(db).completeAttempt({
            attemptId,
            status: succeeded ? "succeeded" : "failed",
            runId: result.runId,
            result: {
              runStatus: result.status,
              safetyStatus: result.safetyStatus,
            },
          });
        });
        return { runId: result.runId, runStatus: result.status };
      } catch (e) {
        // a finalized run still produced a runId — record the failed attempt
        // so convergence can see the budget was spent.
        const runId =
          e instanceof RunFinalizedError ? e.runId : undefined;
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new GoalRepository(db).completeAttempt({
            attemptId,
            status: "failed",
            ...(runId !== undefined ? { runId } : {}),
            errorMessage: (e as Error).message,
          });
        });
        throw e;
      }
    },
    review: async (goalId) => {
      assertGate(goalId, "review.auto");
      const runId = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        latestRunId(new GoalRepository(db), goalId),
      );

      // 1. produce a review proposal (review_proposals row) for the run.
      const reviewResult = await runReviewerAgent({
        runsDir: paths.runsDir,
        runId,
        dbPath: deps.dbPath,
        codexRunner: deps.reviewerRunner,
      });
      // 2. promote the proposal to the run's status (approved / ...).
      const processed = await processReviewDecision({
        runsDir: paths.runsDir,
        runId,
        locksDir: paths.locksDir,
        dbPath: deps.dbPath,
      });

      // 3. fold the processed proposal into the goal: a review cycle, any
      //    findings it carried, and the `review_consensus` close-check that
      //    lets convergence advance toward close.
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new GoalRepository(db);
        const session = repo.requireSession(goalId);
        const proposal = new ReviewProposalRepository(
          db,
        ).getLatestProcessedProposal(runId);
        if (proposal === null) {
          // no DB proposal (should not happen on the db-first path) — still
          // record an empty cycle so the budget reflects the review.
          const cycle = repo.startReviewCycle({
            goalId,
            reviewMode: reviewModeForGoal(repo, session),
            sourceRunId: runId,
          });
          repo.completeReviewCycle({
            cycleId: cycle.cycleId,
            summary: `decision=${processed.newStatus}`,
          });
          return;
        }
        importReviewProposalToGoal({
          repository: repo,
          goalId,
          proposal,
          processResult: processed,
          createdBy: deps.createdBy,
          // Phase 2-3: escalate if the consensus for this goal's review runs
          // is stuck (long pending / no progress). No-op for the common
          // single-reviewer, decisive-verdict flow.
          consensusStall: { provider: dbConsensusSnapshotProvider(db) },
        });
      });
      return { runId, decision: reviewResult.decision };
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
    defer: async (goalId) => {
      // No mutation gate: deferral is a goal-repo bookkeeping op (moving an
      // out-of-scope follow-up to the backlog), not a workspace mutation.
      // `deferFindingToBacklog` opens its own managed db for the backlog write,
      // so collect the finding ids under one open, close it, then loop the
      // async defers each with a fresh repo to avoid a same-dbPath lock clash.
      const findingIds = withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new GoalRepository(db);
        return repo
          .listFindings({ goalId, scopeStatus: "out_of_scope" })
          .filter((f) =>
            DEFERRABLE_OUT_OF_SCOPE_LIFECYCLES.includes(f.lifecycleStatus),
          )
          .map((f) => f.findingId);
      });
      let deferred = 0;
      for (const findingId of findingIds) {
        const { db, close } = openManagedDb({ dbPath: deps.dbPath });
        try {
          await deferFindingToBacklog({
            repository: new GoalRepository(db),
            findingId,
            reason:
              "auto-deferred by orchestrator (out-of-scope follow-up)",
            createBacklogItem: true,
            backlogContext: {
              backlogDir: paths.backlogDir,
              dbPath: deps.dbPath,
            },
          });
        } finally {
          close();
        }
        deferred += 1;
      }
      return { deferred };
    },
    closeAndPr: async (goalId) => {
      // No mutation gate here: closeAndPr is only dispatched on a
      // `close_ready` convergence decision, which deliberately denies
      // run.start/review. Closing + PR is the terminal step, not a run.
      if (deps.publisher === undefined) {
        throw new Error(
          "closeAndPr requires a publisher in OrchestratorRunnerDeps",
        );
      }
      const { runId, base, repoPath } = withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new GoalRepository(db);
        const session = repo.requireSession(goalId);
        // Defense in depth: closeAndPr must only ever run on a goal whose
        // convergence is `close_ready`. The orchestrator dispatch already
        // guarantees this, but a direct caller (or a future code path) must
        // not be able to close a non-ready goal — fail closed.
        const convergence = new ConvergenceService(repo).evaluate(goalId);
        if (convergence.decision !== "close_ready") {
          throw new Error(
            `goal ${goalId} is not close_ready (decision=${convergence.decision}); ` +
              `refusing to close and open a PR`,
          );
        }
        const context = resolveRunContext(deps, session);
        return {
          runId: latestRunId(repo, goalId),
          base: context.baseBranch,
          repoPath: context.repoPath,
        };
      });

      // Phase 3: when auto-merge is enabled, preflight the APPROVAL portion of
      // the merge gate (close-ready ∧ consensus approved w/ quorum, or human
      // override) BEFORE creating a non-draft PR. If it is hard-blocked, the PR
      // (which would be ready/mergeable) is never created — escalate instead.
      // CI is not part of the preflight (it needs the PR to exist).
      if (deps.autoMerge !== undefined) {
        const preflight = withManagedDb({ dbPath: deps.dbPath }, (db) => {
          const repo = new GoalRepository(db);
          const closeReady =
            new ConvergenceService(repo).evaluate(goalId).decision === "close_ready";
          const { consensus, humanApproved } = gatherApproval(db, runId);
          return evaluateMergeGate({
            autoMergeEnabled: true,
            closeReady,
            consensus,
            humanApproved,
            ciGreen: true, // CI is checked after the PR exists
          });
        });
        if (preflight.hardBlocked) {
          // Return escalateReason only; the orchestrator performs the
          // escalated status transition (consistent with runAutoMerge).
          return {
            prUrl: "",
            escalateReason: `auto-merge preflight hard-blocked: ${preflight.blockers.join(", ")}`,
          };
        }
      }

      // Create the PR FIRST. A PR failure must NOT leave a permanently-closed
      // goal with no PR, so the close is the last side effect.
      const pr = await createPullRequest({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        runId,
        base,
        // A draft PR cannot be merged; when auto-merge is enabled the PR must be
        // ready so `gh pr merge` can complete. Otherwise keep the safe default
        // (draft) so a human opens it.
        draft: deps.autoMerge === undefined,
        publisher: deps.publisher,
        dbPath: deps.dbPath,
      });

      // Phase 3: opt-in auto-merge after the PR exists. Default OFF.
      if (deps.autoMerge !== undefined) {
        const outcome = await runAutoMerge(
          deps,
          goalId,
          runId,
          repoPath,
          pr.prNumber,
          pr.headSha,
        );
        if (outcome.escalateReason !== undefined) {
          return { prUrl: pr.prUrl, escalateReason: outcome.escalateReason };
        }
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new GoalRepository(db).updateStatus(
            goalId,
            "closed",
            outcome.merged ? "goal converged; PR merged" : "goal converged; PR opened",
          );
        });
        return { prUrl: pr.prUrl, merged: outcome.merged };
      }

      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        new GoalRepository(db).updateStatus(
          goalId,
          "closed",
          "goal converged; PR opened",
        );
      });
      return { prUrl: pr.prUrl, merged: false };
    },
  };
}

/**
 * Phase 3: evaluate the merge gate for a freshly-created PR and, if it passes,
 * merge (recording an operation-audit row). A hard-blocked gate returns an
 * escalateReason (fail-closed: do NOT merge, do NOT close). CI-not-green
 * returns `{ merged: false }` so the caller closes the goal and leaves the PR
 * open for a later merge.
 */
async function runAutoMerge(
  deps: OrchestratorRunnerDeps,
  goalId: string,
  runId: string,
  repoPath: string,
  prNumber: number,
  reviewedHeadSha: string | undefined,
): Promise<{ merged: boolean; escalateReason?: string }> {
  const autoMerge = deps.autoMerge!;
  // The merge is pinned to the REVIEWED commit (the SHA createPullRequest
  // committed + pushed after the fingerprint check), never the PR's later
  // head. Without it we cannot prove the merge target was reviewed → escalate.
  if (reviewedHeadSha === undefined) {
    return {
      merged: false,
      escalateReason: `auto-merge: reviewed head commit for PR #${prNumber} is unknown`,
    };
  }
  const expectedHeadSha = reviewedHeadSha;
  const ciGreen = await autoMerge.ciStatus(prNumber, expectedHeadSha);
  const gate = withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new GoalRepository(db);
    // Re-evaluate close-readiness at merge time from the DB facts — a finding
    // or close-check could have changed since the PR was created.
    const closeReady =
      new ConvergenceService(repo).evaluate(goalId).decision === "close_ready";
    const { consensus, humanApproved } = gatherApproval(db, runId);
    return evaluateMergeGate({
      autoMergeEnabled: true,
      closeReady,
      consensus,
      humanApproved,
      ciGreen,
    });
  });
  if (gate.canMerge) {
    const method: PrMergeMethod = autoMerge.method ?? "squash";
    const operationId = `op-${randomUUID()}`;
    withManagedDb({ dbPath: deps.dbPath }, (db) => {
      startOperation(db, {
        operationId,
        operationType: "merge",
        targetType: "pr",
        targetId: String(prNumber),
        actor: deps.createdBy,
        dryRun: false,
        // Record the gate snapshot so an auditor can later verify which
        // reviewed commit was pinned and what the gate saw.
        input: { goalId, runId, prNumber, method, expectedHeadSha, ciGreen, gate },
      });
    });
    try {
      const result = await autoMerge.merger.merge({
        repoDir: repoPath,
        prNumber,
        method,
        expectedHeadSha,
      });
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        succeedOperation(db, operationId, result);
      });
      return { merged: true };
    } catch (e) {
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        failOperation(db, operationId, "merge_failed", (e as Error).message);
      });
      throw e;
    }
  }
  if (gate.hardBlocked) {
    // fail-closed: a human-required blocker must not be auto-merged or silently
    // closed — escalate so a human resolves it.
    return {
      merged: false,
      escalateReason: `auto-merge gate hard-blocked: ${gate.blockers.join(", ")}`,
    };
  }
  // transient (CI not green yet): leave the PR open for a later merge.
  return { merged: false };
}

/** Gather the consensus + human-override approval facts for the merge gate. */
function gatherApproval(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): { consensus: MergeGateConsensus | null; humanApproved: boolean } {
  const active = new ReviewConsensusRepository(db).findActive(runId);
  let consensus: MergeGateConsensus | null = null;
  if (active !== null) {
    const summary = JSON.parse(active.summaryJson) as ConsensusSummary;
    consensus = {
      status: active.status,
      quorumSatisfied: quorumSatisfiedFromRequirements(summary.requirements),
    };
  }
  const override = new ReviewOverridesRepository(db).findLatest(runId);
  return { consensus, humanApproved: override?.decision === "approved" };
}
