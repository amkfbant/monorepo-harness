import { randomUUID } from "node:crypto";

import { join } from "node:path";

import { openManagedDb, withManagedDb } from "../db/managed-connection.js";
import { harnessPaths } from "../config/paths.js";
import { conventionalPrTitle } from "./conventional-pr-title.js";

import { runDomainCoding, RunFinalizedError } from "../core/workflow-runner.js";

import { runReviewerAgent } from "../core/reviewer-agent.js";

import { runRefuteAgent } from "../core/refute-agent.js";

import { processReviewDecision } from "../core/review-processor.js";
import { createPullRequest, pushReviewedBranchForEscalation } from "../core/pr-creator.js";
import { evaluateMergeGate } from "../core/merge-gate.js";

import { startOperation, succeedOperation, failOperation } from "../db/repositories/operations.js";

import { runCopilotReview } from "../core/copilot-review-run.js";

import { HitchRepository, UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES } from "./repository.js";
import { augmentGoalWithFailedCloseChecks, augmentGoalWithFailedRun, augmentGoalWithOpenFindings } from "./coder-goal-context.js";
import { runClassifyDeliberation, type JuryRunContext } from "./jury/classify-runner.js";

import { deferFindingToBacklog } from "./followups.js";
import { ConvergenceService } from "./convergence.js";

import { assertHitchCanStartMutation } from "./mutation-gate.js";
import { importReviewProposalToHitch, selectProcessedProposalForReviewImport } from "./review-integration.js";
import { runCommandCloseChecks } from "./orchestrator-close-check-runner.js";
import { classifyAndRecordClosePushFailure } from "./close-push-retry.js";
import { dbConsensusSnapshotProvider } from "./consensus-stall-check.js";

import type { OrchestratorRunners } from "./orchestrator-types.js";

import { findTransientLeaseCause } from "../workspace/db-domain-lock.js";
import { FINDING_BATCH_LIMIT, JURY_BATCH_LIMIT, JURY_CODEX_TIMEOUT_MS, OPEN_FINDING_LIFECYCLE_SET, HitchNotCloseReadyError, HitchHasAdoptedPrError } from "./orchestrator-runners-types.js";
import type { OrchestratorRunnerDeps } from "./orchestrator-runners-types.js";
import { assertCoderProjectRuntime, assertProjectRuntimeComplete, projectRuntimeFields, resolveRunContext, latestRunId, latestCodingRunOrNull, gateContinuation, readParentContinuationFacts, resolveGitTimeoutMs, resolveJuryCompiledPolicy } from "./orchestrator-runners-continuation.js";
import type { ContinuationResolution } from "./orchestrator-runners-continuation.js";
import { cleanReviewerFailureReason, failedRequiredCloseChecks, findReviewerDispatchLeaseLossCause, isUnresolvedOutOfScopeFinding, prepareRefuteDispatchPlan, prepareReviewDispatchPlan, recordPendingConsensusReview, refuteRecorderForDb, reviewModeForHitch, shouldRecordFrozenPendingConsensus, tryShortCircuitApprovedDecidedReview } from "./orchestrator-runners-review.js";
import type { ReviewerDispatchFailure } from "./orchestrator-runners-types.js";
import { gatherApproval, effectiveAutoMergeTier, runAutoMerge } from "./orchestrator-runners-automerge.js";

export { selectProcessedProposalForReviewImport } from "./review-integration.js";
// Re-export the public surface that moved to the split modules so existing
// importers keep using "./orchestrator-runners.js".
export {
  HitchNotCloseReadyError,
  HitchHasAdoptedPrError,
} from "./orchestrator-runners-types.js";
export type {
  HitchRunContext,
  ProjectRuntimeDeps,
  OrchestratorRunnerDeps,
} from "./orchestrator-runners-types.js";
export { latestRunId } from "./orchestrator-runners-continuation.js";
export { tryShortCircuitApprovedDecidedReview } from "./orchestrator-runners-review.js";
export { ConsensusReviewPreflightError } from "./orchestrator-runners-types.js";
export type { ConsensusPreflightCauseKind } from "./orchestrator-runners-types.js";

export function createOrchestratorRunners(
  deps: OrchestratorRunnerDeps,
): OrchestratorRunners {
  assertProjectRuntimeComplete(deps.projectRuntime);
  const paths = harnessPaths(deps.harnessRoot);
  const assertGate = (
    hitchId: string,
    mutationKind: "run.start" | "review.auto",
  ): void => {
    withManagedDb({ dbPath: deps.dbPath }, (db) => {
      assertHitchCanStartMutation({
        repository: new HitchRepository(db),
        hitchId,
        mutationKind,
        syncCreatedBy: deps.createdBy,
      });
    });
  };

  return {
    coder: async (hitchId) => {
      assertGate(hitchId, "run.start");
      const { attemptId, context, goalText, parentFacts, isRerun } = withManagedDb(
        { dbPath: deps.dbPath },
        (db) => {
          const repo = new HitchRepository(db);
          const s = repo.requireSession(hitchId);
          assertCoderProjectRuntime(deps, s);
          const ctx = resolveRunContext(deps, s);
          // a hitch that already has a coding attempt is iterating on review
          // feedback → "rerun"; the first pass is "implement".
          const codingAttempts = repo
            .listAttempts(hitchId)
            .filter(
              (a) =>
                a.attemptType === "implement" || a.attemptType === "rerun",
            );
          const prior = codingAttempts.length > 0;
          // (#163) On a rerun, gather the read-only facts needed to CONTINUE the
          // parent run's work (parent run row + chain root + worktree path) in
          // this same DB read. The async base-equality gate runs AFTER the DB
          // handle closes (no async work under withManagedDb). The first
          // `implement` pass has no parent → no continuation.
          const facts = prior
            ? readParentContinuationFacts({
                db,
                repo,
                hitchId,
                harnessRoot: deps.harnessRoot,
              })
            : null;
          // If the most recent coding run failed before review, this is a
          // recovery rerun — inject the failed run status so the coder fixes the
          // cause rather than re-coding blind (convergence routes here).
          const latestCoding = codingAttempts[codingAttempts.length - 1];
          const failedRunStatus =
            latestCoding?.status === "failed"
              ? String(
                  (latestCoding.result as { runStatus?: unknown } | undefined)
                    ?.runStatus ?? "failed",
                )
              : "";
          // On a rerun, inject the open in-scope findings review raised into the
          // coder goal so it knows what to fix (the hitch-mode analogue of the
          // run-level required_changes injection). The first `implement` pass
          // has none. unknown-scope findings are intentionally excluded — they
          // must be classified first (fail-closed).
          const openInScope = prior
            ? repo
                .listFindings({ hitchId, scopeStatus: "in_scope", limit: 200 })
                .filter((fnd) =>
                  OPEN_FINDING_LIFECYCLE_SET.has(fnd.lifecycleStatus),
                )
            : [];
          const closeCheckFailures = prior
            ? failedRequiredCloseChecks(repo, s)
            : [];
          const attempt = repo.createAttempt({
            hitchId,
            attemptType: prior ? "rerun" : "implement",
            status: "running",
          });
          return {
            attemptId: attempt.attemptId,
            context: ctx,
            parentFacts: facts,
            isRerun: prior,
            goalText: augmentGoalWithFailedRun(
              augmentGoalWithFailedCloseChecks(
                augmentGoalWithOpenFindings(ctx.goal, openInScope),
                closeCheckFailures,
              ),
              failedRunStatus,
            ),
          };
        },
      );
      // (#163) Resolve the continuation OUTSIDE the DB handle: the base-equality
      // gate does a read-only `git rev-parse` (async). A skipped/absent
      // continuation → fresh-from-base (the runDomainCoding default); no throw,
      // no escalation. `runDomainCoding` records the skip reason as a run event.
      const continuation: ContinuationResolution =
        parentFacts !== null
          ? await gateContinuation({
              facts: parentFacts,
              context,
              gitTimeoutMs: await resolveGitTimeoutMs(deps, context),
            })
          : isRerun
            ? // a rerun with no resolvable parent run row: fail closed and record
              // why (the run still proceeds fresh-from-base).
              { skippedReason: "parent_run_missing" }
            : {};
      try {
        const result = await runDomainCoding({
          harnessRoot: deps.harnessRoot,
          repoPath: context.repoPath,
          repoId: context.repoId,
          domain: context.domain,
          goal: goalText,
          baseBranch: context.baseBranch,
          codexRunner: deps.coderRunner,
          ...(deps.coderBackend !== undefined
            ? { coderBackend: deps.coderBackend }
            : {}),
          codexBinaryVersion: deps.coderCodexBinaryVersion ?? null,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          ...projectRuntimeFields(deps),
          // (#163) Continuation: when the gate passed, carry the parent run's
          // uncommitted work into this run's worktree and pin the gate-validated
          // base; the lineage fields populate meta.json + the rerun chain.
          ...(continuation.continueFrom !== undefined
            ? { continueFrom: continuation.continueFrom }
            : {}),
          ...(continuation.resolvedBaseSha !== undefined
            ? { resolvedBaseSha: continuation.resolvedBaseSha }
            : {}),
          // (#163 P2) lineage (parent_run_id + dup-fence) is forwarded for a
          // rerun whether or not materialization happened — only the carry is
          // gated, not the chain/audit. A skipped continuation must still record
          // its real parent (never become a new root) and be fenced to one child.
          ...(continuation.parentRunId !== undefined
            ? { continuationParentRunId: continuation.parentRunId }
            : {}),
          ...(continuation.rootRunId !== undefined
            ? { rootRunId: continuation.rootRunId }
            : {}),
          ...(continuation.rerunAttempt !== undefined
            ? { rerunAttempt: continuation.rerunAttempt }
            : {}),
          ...(continuation.skippedReason !== undefined
            ? { continueFromSkipped: continuation.skippedReason }
            : {}),
        });
        const succeeded = result.status === "needs_review";
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new HitchRepository(db).completeAttempt({
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
        const transientLeaseError = findTransientLeaseCause(e);
        if (transientLeaseError !== undefined) {
          try {
            withManagedDb({ dbPath: deps.dbPath }, (db) => {
              new HitchRepository(db).discardAttempt(attemptId);
            });
          } catch {
            // Preserve the original transient lock/lease error. A cleanup race
            // must not convert a fail-closed retry condition into escalation.
          }
          throw transientLeaseError;
        }
        // a finalized run still produced a runId — record the failed attempt
        // so convergence can see the budget was spent.
        const runId =
          e instanceof RunFinalizedError ? e.runId : undefined;
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new HitchRepository(db).completeAttempt({
            attemptId,
            status: "failed",
            ...(runId !== undefined ? { runId } : {}),
            errorMessage: (e as Error).message,
          });
        });
        throw e;
      }
    },
    review: async (hitchId) => {
      assertGate(hitchId, "review.auto");
      const runId = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        latestRunId(new HitchRepository(db), hitchId),
      );
      const decided = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        tryShortCircuitApprovedDecidedReview({
          db,
          hitchId,
          runId,
          createdBy: deps.createdBy,
        }),
      );
      if (decided !== null) return decided;

      const dispatchPlan = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        prepareReviewDispatchPlan({
          db,
          runId,
          now: new Date().toISOString(),
        }),
      );
      const failedReviewers: ReviewerDispatchFailure[] = [];
      if (dispatchPlan.kind === "frozen-consensus") {
        for (const reviewer of dispatchPlan.reviewers) {
          try {
            await runReviewerAgent({
              runsDir: paths.runsDir,
              runId,
              dbPath: deps.dbPath,
              reviewerName: reviewer.reviewerId,
              ...(reviewer.reviewerLens !== undefined
                ? { reviewerLens: reviewer.reviewerLens }
                : {}),
              allowOverwrite: true,
              codexRunner: deps.reviewerRunner,
              ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
            });
          } catch (e) {
            // Symmetry with the coder path (:findTransientLeaseCause rethrow):
            // a lost lease / aborted signal must rethrow BEFORE the clean
            // classification, never demote to pending under a lost lease.
            const leaseLoss = findReviewerDispatchLeaseLossCause(
              e,
              deps.signal,
            );
            if (leaseLoss !== undefined) throw leaseLoss;
            const reason = cleanReviewerFailureReason(e);
            if (reason !== null) {
              failedReviewers.push({ reviewerId: reviewer.reviewerId, reason });
              continue;
            }
            throw e;
          }
        }
      } else {
        // 1. produce a review proposal (review_proposals row) for the run.
        await runReviewerAgent({
          runsDir: paths.runsDir,
          runId,
          dbPath: deps.dbPath,
          codexRunner: deps.reviewerRunner,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        });
      }
      const refutePlan = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        prepareRefuteDispatchPlan({
          db,
          runId,
          now: new Date().toISOString(),
        }),
      );
      if (refutePlan !== null) {
        for (const target of refutePlan.targets) {
          for (const reviewerId of refutePlan.reviewerIds) {
            try {
              await runRefuteAgent({
                runsDir: paths.runsDir,
                runId,
                repository: refuteRecorderForDb(deps.dbPath),
                activeRequiredChanges: [target],
                reviewerName: reviewerId,
                codexRunner: deps.reviewerRunner,
                hitchId,
                ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
              });
            } catch (e) {
              const leaseLoss = findReviewerDispatchLeaseLossCause(
                e,
                deps.signal,
              );
              if (leaseLoss !== undefined) throw leaseLoss;
              throw e;
            }
          }
        }
      }
      // 2. promote the proposal to the run's status (approved / ...).
      let processed: Awaited<ReturnType<typeof processReviewDecision>>;
      try {
        processed = await processReviewDecision({
          runsDir: paths.runsDir,
          runId,
          locksDir: paths.locksDir,
          dbPath: deps.dbPath,
        });
      } catch (e) {
        if (
          shouldRecordFrozenPendingConsensus({
            error: e,
            dispatchPlan,
            failedReviewers,
          })
        ) {
          const pending = withManagedDb({ dbPath: deps.dbPath }, (db) =>
            recordPendingConsensusReview({
              db,
              hitchId,
              runId,
              createdBy: deps.createdBy,
              failedReviewers,
            }),
          );
          return { runId, decision: pending.decision };
        }
        throw e;
      }

      // 3. fold the processed proposal into the hitch: a review cycle, any
      //    findings it carried, and the `review_consensus` close-check that
      //    lets convergence advance toward close.
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new HitchRepository(db);
        const session = repo.requireSession(hitchId);
        const proposal = selectProcessedProposalForReviewImport({ db, runId });
        if (proposal === null) {
          // no DB proposal (should not happen on the db-first path) — still
          // record an empty cycle so the budget reflects the review.
          const cycle = repo.startReviewCycle({
            hitchId,
            reviewMode: reviewModeForHitch(repo, session),
            sourceRunId: runId,
          });
          repo.completeReviewCycle({
            cycleId: cycle.cycleId,
            summary: `decision=${processed.newStatus}`,
          });
          return;
        }
        importReviewProposalToHitch({
          repository: repo,
          hitchId,
          proposal,
          processResult: processed,
          createdBy: deps.createdBy,
          // Phase 2-3: escalate if the consensus for this hitch's review runs
          // is stuck (long pending / no progress). No-op for the common
          // single-reviewer, decisive-verdict flow.
          consensusStall: { provider: dbConsensusSnapshotProvider(db) },
        });
      });
      return { runId, decision: processed.newStatus };
    },
    closeCheck: async (hitchId) =>
      runCommandCloseChecks({
        deps,
        hitchId,
        resolveContext: (session) => {
          assertCoderProjectRuntime(deps, session);
          return resolveRunContext(deps, session);
        },
      }),
    classify: async (hitchId) => {
      // (#230) 3-phase deliberation classify runner (design §7.1). The runner
      // manages its own DB handles (READ-ONLY snapshot -> CLOSED for the LLM ->
      // re-open to persist+classify). #132 (round-2 FIX 2): the run-context /
      // worktree / policy is resolved LAZILY — only when the runner's READ-ONLY
      // Phase 1 found actual jury candidates. A session without repoId/domain
      // whose unknown findings are ONLY operator-origin or heuristic-classifiable
      // must NOT trigger run-context resolution (which would throw and route to a
      // generic orchestrator escalation instead of the intended manual-
      // classification packet / heuristic write). The latest coding run's
      // worktree is where the jury's file-kind citations resolve.
      const resolveJuryContext = async (): Promise<JuryRunContext> => {
        const { context, latestRun } = withManagedDb(
          { dbPath: deps.dbPath },
          (db) => {
            const repo = new HitchRepository(db);
            const session = repo.requireSession(hitchId);
            return {
              context: resolveRunContext(deps, session),
              latestRun: latestCodingRunOrNull(repo, hitchId),
            };
          },
        );
        const compiledPolicy = await resolveJuryCompiledPolicy(deps, context);
        const worktreePath =
          latestRun !== null
            ? join(paths.workspacesDir, latestRun.runId, "repo")
            : context.repoPath;
        return {
          worktreePath,
          compiledPolicy,
          runId: latestRun?.runId ?? null,
        };
      };
      return runClassifyDeliberation(
        {
          dbPath: deps.dbPath,
          harnessRoot: deps.harnessRoot,
          reviewerRunner: deps.reviewerRunner,
          resolveJuryContext,
          juryBatchLimit: JURY_BATCH_LIMIT,
          timeoutMs: JURY_CODEX_TIMEOUT_MS,
          // #132: thread the orchestrator's lease signal so a mid-deliberation
          // lease loss aborts the in-flight jury codex AND blocks any Phase-3
          // mutation (a non-authoritative drive mutates no state, fail-closed).
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        },
        hitchId,
      );
    },
    defer: async (hitchId) => {
      // No mutation gate: deferral is a hitch-repo bookkeeping op (moving an
      // out-of-scope follow-up to the backlog), not a workspace mutation.
      // `deferFindingToBacklog` opens its own managed db for the backlog write,
      // so collect the finding ids under one open, close it, then loop the
      // async defers each with a fresh repo to avoid a same-dbPath lock clash.
      const filter = {
        hitchId,
        scopeStatus: "out_of_scope" as const,
        lifecycleStatusIn: UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
      };
      let deferred = 0;
      let previousRemaining = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        new HitchRepository(db).countFindings(filter),
      );
      while (true) {
        const findingIds = withManagedDb({ dbPath: deps.dbPath }, (db) => {
          const repo = new HitchRepository(db);
          return repo
            .listFindings({ ...filter, limit: FINDING_BATCH_LIMIT })
            .map((f) => f.findingId);
        });
        if (findingIds.length === 0) break;

        let batchDeferred = 0;
        for (const findingId of findingIds) {
          const { db, close } = openManagedDb({ dbPath: deps.dbPath });
          try {
            const result = await deferFindingToBacklog({
              repository: new HitchRepository(db),
              findingId,
              reason:
                "auto-deferred by orchestrator (out-of-scope follow-up)",
              createBacklogItem: true,
              backlogContext: {
                backlogDir: paths.backlogDir,
                dbPath: deps.dbPath,
              },
            });
            if (
              result.finding.lifecycleStatus === "deferred" &&
              !isUnresolvedOutOfScopeFinding(result.finding)
            ) {
              batchDeferred += 1;
            }
          } finally {
            close();
          }
        }
        deferred += batchDeferred;

        const remaining = withManagedDb({ dbPath: deps.dbPath }, (db) =>
          new HitchRepository(db).countFindings(filter),
        );
        if (remaining === 0) return { deferred };
        if (batchDeferred === 0 || remaining >= previousRemaining) {
          return { deferred };
        }
        previousRemaining = remaining;
      }
      // Loop only breaks when the unresolved out-of-scope set is empty, so
      // `deferred` already reflects every finding that reached the backlog.
      return { deferred };
    },
    closeAndPr: async (hitchId) => {
      // No mutation gate here: closeAndPr is only dispatched on a
      // `close_ready` convergence decision, which deliberately denies
      // run.start/review. Closing + PR is the terminal step, not a run.
      if (deps.publisher === undefined) {
        throw new Error(
          "closeAndPr requires a publisher in OrchestratorRunnerDeps",
        );
      }
      const { runId, base, repoPath, prTitle } = withManagedDb(
        { dbPath: deps.dbPath },
        (db) => {
          const repo = new HitchRepository(db);
          const session = repo.requireSession(hitchId);
          // Safety boundary (#169): an operator-adopted PR is audit/status-only
          // and human-merge only. The merge execution path is shared by
          // closeAndPr / orchestrate --auto-merge / await-merge, so the guard
          // must live here — before any PR create/reuse/merge side effect —
          // not only on the await-merge CLI. Fail closed: never let the harness
          // create or auto-merge a PR for a hitch whose record points at an
          // adopted (externally verified) PR.
          if (repo.hasAdoptedPr(hitchId)) {
            throw new HitchHasAdoptedPrError(hitchId);
          }
          // Defense in depth: closeAndPr must only ever run on a hitch whose
          // convergence is `close_ready`. The orchestrator dispatch already
          // guarantees this, but a direct caller (or a future code path) must
          // not be able to close a non-ready hitch — fail closed.
          const convergence = new ConvergenceService(repo).evaluate(hitchId);
          if (convergence.decision !== "close_ready") {
            throw new HitchNotCloseReadyError(hitchId, convergence.decision);
          }
          const context = resolveRunContext(deps, session);
          const rid = latestRunId(repo, hitchId);
          return {
            runId: rid,
            base: context.baseBranch,
            repoPath: context.repoPath,
            // #103 — Conventional-Commit title derived from the hitch title so
            // release-please picks the squash commit up.
            prTitle: conventionalPrTitle({
              hitchTitle: session.title ?? "",
              runId: rid,
            }),
          };
        },
      );

      // Phase 3: when auto-merge is enabled, preflight the APPROVAL portion of
      // the merge gate (close-ready ∧ consensus approved w/ quorum, or human
      // override) BEFORE creating a non-draft PR. If it is hard-blocked, the PR
      // (which would be ready/mergeable) is never created — escalate instead.
      // CI is not part of the preflight (it needs the PR to exist).
      if (deps.autoMerge !== undefined) {
        const preflight = withManagedDb({ dbPath: deps.dbPath }, (db) => {
          const repo = new HitchRepository(db);
          const closeReady =
            new ConvergenceService(repo).evaluate(hitchId).decision === "close_ready";
          const { consensus, humanApproved } = gatherApproval(db, runId);
          return evaluateMergeGate({
            autoMergeEnabled: true,
            closeReady,
            consensus,
            humanApproved,
            ciGreen: true, // CI is checked after the PR exists
            tierEligible:
              effectiveAutoMergeTier(db, runId, deps.harnessRoot) === 0,
          });
        });
        if (preflight.hardBlocked) {
          // Return escalateReason only; the orchestrator performs the
          // escalated status transition (consistent with runAutoMerge).
          return {
            prUrl: "",
            draft: false,
            escalateReason: `auto-merge preflight hard-blocked: ${preflight.blockers.join(", ")}`,
          };
        }
      }

      // Create the PR FIRST. A PR failure must NOT leave a permanently-closed
      // hitch with no PR, so the close is the last side effect.
      let pr: Awaited<ReturnType<typeof createPullRequest>>;
      try {
        pr = await createPullRequest({
          runsDir: paths.runsDir,
          workspacesDir: paths.workspacesDir,
          locksDir: paths.locksDir,
          runId,
          base,
          title: prTitle,
          // A draft PR cannot be merged; when auto-merge is enabled the PR must be
          // ready so `gh pr merge` can complete. Otherwise keep the safe default
          // (draft) so a human opens it.
          draft: deps.autoMerge === undefined,
          publisher: deps.publisher,
          dbPath: deps.dbPath,
        });
      } catch (e) {
        // (#396 part 2) Only a transient `git push` failure rechecks; everything
        // else (gates / publish / adopted / not-ready / permanent / exhaustion)
        // rethrows or escalates. See `close-push-retry.ts` + hitch-convergence.md.
        const decision = classifyAndRecordClosePushFailure(
          { dbPath: deps.dbPath },
          hitchId,
          runId,
          e,
          deps.signal?.aborted === true,
        );
        if (decision.kind === "rethrow") throw e;
        // abort/lease-loss beats BOTH escalate and recheck — re-read the live
        // signal so an abort routes through the orchestrator's abort-first catch.
        if (deps.signal?.aborted === true) throw e;
        if (decision.kind === "escalate") {
          return { prUrl: "", draft: false, escalateReason: decision.reason };
        }
        // transient under budget → non-terminal `close_ready` (the CI-not-green
        // recheck lane): a later pass re-derives close_ready and re-pushes. The
        // branch+commit exist locally and no PR was created, so it is idempotent.
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new HitchRepository(db).updateStatus(
            hitchId,
            "close_ready",
            decision.summary,
            { createdBy: deps.createdBy },
          );
        });
        // pushRetryPending distinguishes this from the CI-not-green recheck so
        // await-merge stops (no PR to await) instead of re-polling and burning the
        // budget, and orchestrate reports `push_retry_pending` not `pr_created`.
        return { prUrl: "", draft: false, merged: false, pushRetryPending: true };
      }

      // Best-effort Copilot review (opt-in). Observational only: it NEVER
      // gates close/merge, and ANY failure (including an unexpected throw) is
      // swallowed — the hitch proceeds regardless (existing safety boundary:
      // external output must not drive a state transition).
      if (deps.copilotReview !== undefined) {
        try {
          // Capture the start before the review runs so the audit `started_at`
          // reflects when the work began (the DB write happens after, contrast
          // with auto-merge which starts its operation before the external work).
          const startedAt = new Date();
          const outcome = await runCopilotReview({
            reviewer: deps.copilotReview.reviewer,
            prNumber: pr.prNumber,
            ...(deps.copilotReview.config !== undefined
              ? { config: deps.copilotReview.config }
              : {}),
          });
          withManagedDb({ dbPath: deps.dbPath }, (db) => {
            const operationId = `op-${randomUUID()}`;
            startOperation(db, {
              operationId,
              operationType: "copilot-review",
              targetType: "pr",
              targetId: String(pr.prNumber),
              actor: deps.createdBy,
              dryRun: false,
              input: { hitchId, prNumber: pr.prNumber },
              now: startedAt,
            });
            if (outcome.status === "failed") {
              failOperation(
                db,
                operationId,
                "copilot_review_failed",
                outcome.detail,
              );
            } else {
              // reviewed | skipped are terminal best-effort outcomes (the result
              // JSON's `status` distinguishes them). `pending` would be misread
              // as deferred work and flagged stale by the doctor.
              succeedOperation(db, operationId, outcome);
            }
          });
        } catch {
          // non-gating: a Copilot review failure must never break close/merge.
        }
      }

      // Phase 3: opt-in auto-merge after the PR exists. Default OFF.
      if (deps.autoMerge !== undefined) {
        const outcome = await runAutoMerge(
          deps,
          hitchId,
          runId,
          repoPath,
          pr.prNumber,
          pr.headSha,
        );
        if (outcome.escalateReason !== undefined) {
          return {
            prUrl: pr.prUrl,
            draft: pr.draft,
            escalateReason: outcome.escalateReason,
          };
        }
        // merged → closed. A CI-not-green transient (recheckable) leaves the
        // hitch `close_ready` with the PR open: a later `hitch orchestrate`
        // re-enters closeAndPr (idempotent PR + a fresh gate evaluation) and
        // merges once CI is green — the resumable "later merge" path, no new
        // status / migration needed. Any other transient (e.g. tier-not-eligible)
        // is permanent for a re-check, so the hitch closes for a human merge.
        const nextStatus = outcome.merged
          ? "closed"
          : outcome.recheckable === true
            ? "close_ready"
            : "closed";
        const summary = outcome.merged
          ? "hitch converged; PR merged"
          : outcome.recheckable === true
            ? "PR open; awaiting CI — re-run orchestrate to merge"
            : "hitch converged; PR opened";
        withManagedDb({ dbPath: deps.dbPath }, (db) => {
          new HitchRepository(db).updateStatus(hitchId, nextStatus, summary, {
            createdBy: deps.createdBy,
          });
        });
        return { prUrl: pr.prUrl, draft: pr.draft, merged: outcome.merged };
      }

      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        new HitchRepository(db).updateStatus(
          hitchId,
          "closed",
          "hitch converged; PR opened",
          { createdBy: deps.createdBy },
        );
      });
      return { prUrl: pr.prUrl, draft: pr.draft, merged: false };
    },
    salvageReviewBranch: async (hitchId) => {
      const runId = withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const rid = latestRunId(new HitchRepository(db), hitchId);
        const run = db
          .prepare("SELECT status FROM runs WHERE run_id = ?")
          .get(rid) as { status: string } | undefined;
        return run !== undefined && run.status !== "needs_review"
          ? null
          : rid;
      });
      if (runId === null) return null;
      return pushReviewedBranchForEscalation({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        runId,
        dbPath: deps.dbPath,
      });
    },
  };
}
