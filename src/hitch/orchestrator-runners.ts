import { randomUUID } from "node:crypto";
import { openManagedDb, withManagedDb } from "../db/managed-connection.js";
import { harnessPaths } from "../config/paths.js";
import { conventionalPrTitle } from "./conventional-pr-title.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import {
  runDomainCoding,
  RunFinalizedError,
} from "../core/workflow-runner.js";
import { runReviewerAgent } from "../core/reviewer-agent.js";
import { processReviewDecision } from "../core/review-processor.js";
import {
  createPullRequest,
  pushReviewedBranchForEscalation,
  type PrPublisher,
  type PrMerger,
  type PrMergeMethod,
} from "../core/pr-creator.js";
import {
  evaluateMergeGate,
  quorumSatisfiedFromRequirements,
  type MergeGateConsensus,
} from "../core/merge-gate.js";
import {
  computeAutoMergeTier,
  type AutoMergeTier,
} from "../core/automerge-tiers.js";
import { loadAutoMergeSensitivityMap } from "../core/automerge-tiers-config.js";
import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import { ReviewOverridesRepository } from "../db/repositories/review-overrides.js";
import {
  startOperation,
  succeedOperation,
  failOperation,
} from "../db/repositories/operations.js";
import type { CopilotReviewer } from "../core/copilot-reviewer.js";
import {
  runCopilotReview,
  type CopilotReviewConfig,
} from "../core/copilot-review-run.js";
import type { ConsensusSummary } from "../core/review-consensus.js";
import {
  HitchRepository,
  OPEN_FINDING_LIFECYCLES,
  UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
} from "./repository.js";
import {
  augmentGoalWithFailedRun,
  augmentGoalWithOpenFindings,
} from "./coder-goal-context.js";
import { classifyFindingForHitch } from "./classification.js";
import { deferFindingToBacklog } from "./followups.js";
import { ConvergenceService } from "./convergence.js";
import { assertHitchCanStartMutation } from "./mutation-gate.js";
import { importReviewProposalToHitch } from "./review-integration.js";
import { dbConsensusSnapshotProvider } from "./consensus-stall-check.js";
import { nextReviewMode } from "./review-mode.js";
import type { OrchestratorRunners } from "./orchestrator-types.js";
import type {
  HitchFinding,
  HitchAttemptType,
  HitchLifecycleStatus,
  HitchReviewMode,
  HitchSession,
} from "./types.js";

const FINDING_BATCH_LIMIT = 200;

const OPEN_FINDING_LIFECYCLE_SET: ReadonlySet<HitchLifecycleStatus> = new Set(
  OPEN_FINDING_LIFECYCLES,
);
const UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET: ReadonlySet<HitchLifecycleStatus> =
  new Set(UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES);

/**
 * Thrown by `closeAndPr`'s pre-side-effect guard when the hitch is not
 * `close_ready`. It is raised BEFORE any side effect (no PR/push/merge), so a
 * caller (e.g. `hitch await-merge`) can distinguish a benign convergence DRIFT
 * from a real close/merge failure by the error TYPE rather than re-reading
 * convergence (which is racy).
 */
export class HitchNotCloseReadyError extends Error {
  constructor(
    readonly hitchId: string,
    readonly decision: string,
  ) {
    super(
      `hitch ${hitchId} is not close_ready (decision=${decision}); ` +
        `refusing to close and open a PR`,
    );
    this.name = "HitchNotCloseReadyError";
  }
}

/**
 * Lifecycle states that still demand attention (i.e. an "open" finding). A
 * finding whose scope is `unknown` and whose lifecycle is one of these must be
 * deterministically classified before the hitch can converge.
 */
/**
 * The concrete repo/run context a hitch session does not itself store. The
 * session has `repoId` / `domain` and the goal text (title/description), but
 * the on-disk repo path and base branch must be supplied by the caller. The
 * CLI resolves these from its `--repo` / `--base-branch` flags; tests pass a
 * throwaway git repo.
 */
export interface HitchRunContext {
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
    /**
     * Opt-in: fetch the PR's external review verdicts (codex GitHub App /
     * Copilot). A `CHANGES_REQUESTED` verdict is ingested ONCE as an
     * unknown-scope advisory hitch finding so the merge gate escalates
     * (fail-closed) for the operator to classify (§6: external output is
     * advisory, never auto-trusted). Approvals have NO gating effect.
     */
    reviewVerdicts?: (
      prNumber: number,
    ) => Promise<{ author: string; state: string }[]>;
    /**
     * Opt-in bounded await for external review verdicts, symmetric with the CI
     * bounded await: external reviewers (codex App / Copilot) post their verdict
     * asynchronously after the PR opens, so a one-shot orchestrate may evaluate
     * the gate before they weigh in. When set, poll `reviewVerdicts` until a
     * CHANGES_REQUESTED appears or the budget is spent. Fail-safe: a late verdict
     * is still caught by the resumable close_ready re-check on a later run.
     */
    reviewAwait?: {
      timeoutMs: number;
      intervalMs: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    };
  };
  /**
   * Best-effort Copilot PR review (opt-in; default OFF). When present,
   * `closeAndPr` requests a Copilot review after creating the PR and records
   * an audit row. The outcome is observational ONLY — it never gates close or
   * auto-merge, and any exception is swallowed (non-gating safety boundary).
   */
  copilotReview?: {
    reviewer: CopilotReviewer;
    config?: Partial<CopilotReviewConfig>;
  };
  /**
   * Resolve the repo/run context for a hitch's session. Defaults to deriving
   * the goal text from the session title/description, the repoId/domain from
   * the session, and the base branch to `main`; the repo path is taken from
   * `repoPath` below. Override for full control (e.g. project-mode runs).
   */
  resolveRunContext?: (session: HitchSession) => HitchRunContext;
  /**
   * Repo path used by the default `resolveRunContext`. Ignored when a custom
   * `resolveRunContext` is supplied.
   */
  repoPath?: string;
  /** Base branch used by the default `resolveRunContext` (default "main"). */
  baseBranch?: string;
}

function defaultGoalText(session: HitchSession): string {
  const parts = [session.title, session.description ?? ""]
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return parts.join("\n\n");
}

function resolveRunContext(
  deps: OrchestratorRunnerDeps,
  session: HitchSession,
): HitchRunContext {
  if (deps.resolveRunContext !== undefined) {
    return deps.resolveRunContext(session);
  }
  if (session.repoId === null || session.domain === null) {
    throw new Error(
      `hitch ${session.hitchId} has no repoId/domain; cannot run the coder ` +
        `(provide resolveRunContext or set the hitch's repoId+domain)`,
    );
  }
  if (deps.repoPath === undefined) {
    throw new Error(
      `hitch ${session.hitchId}: no repoPath configured for the orchestrator ` +
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
const CODING_ATTEMPT_TYPES = new Set<HitchAttemptType>(["implement", "rerun"]);

/**
 * The latest run id recorded against a hitch — the run the review / pr steps
 * operate on. Attempts are ordered (iteration ASC, created_at ASC), so the
 * last CODING attempt (implement / rerun) carrying a runId is the most recent
 * run. A close-check or other attempt's runId must not be picked.
 */
export function latestRunId(repo: HitchRepository, hitchId: string): string {
  const attempts = repo.listAttempts(hitchId);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    const runId = attempt.runId;
    if (typeof runId === "string" && runId !== "") return runId;
  }
  throw new Error(
    `hitch ${hitchId} has no recorded run yet; run the coder before reviewing`,
  );
}

function reviewModeForHitch(
  repo: HitchRepository,
  session: HitchSession,
): HitchReviewMode {
  return nextReviewMode(session, repo.listReviewCycles(session.hitchId));
}

function isUnresolvedOutOfScopeFinding(finding: HitchFinding): boolean {
  return (
    finding.scopeStatus === "out_of_scope" &&
    UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET.has(finding.lifecycleStatus)
  );
}

export function createOrchestratorRunners(
  deps: OrchestratorRunnerDeps,
): OrchestratorRunners {
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
      });
    });
  };

  return {
    coder: async (hitchId) => {
      assertGate(hitchId, "run.start");
      const { attemptId, context, goalText } = withManagedDb(
        { dbPath: deps.dbPath },
        (db) => {
          const repo = new HitchRepository(db);
          const s = repo.requireSession(hitchId);
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
          const attempt = repo.createAttempt({
            hitchId,
            attemptType: prior ? "rerun" : "implement",
            status: "running",
          });
          return {
            attemptId: attempt.attemptId,
            context: ctx,
            goalText: augmentGoalWithFailedRun(
              augmentGoalWithOpenFindings(ctx.goal, openInScope),
              failedRunStatus,
            ),
          };
        },
      );
      try {
        const result = await runDomainCoding({
          harnessRoot: deps.harnessRoot,
          repoPath: context.repoPath,
          repoId: context.repoId,
          domain: context.domain,
          goal: goalText,
          baseBranch: context.baseBranch,
          codexRunner: deps.coderRunner,
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

      // 3. fold the processed proposal into the hitch: a review cycle, any
      //    findings it carried, and the `review_consensus` close-check that
      //    lets convergence advance toward close.
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new HitchRepository(db);
        const session = repo.requireSession(hitchId);
        const proposal = new ReviewProposalRepository(
          db,
        ).getLatestProcessedProposal(runId);
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
      return { runId, decision: reviewResult.decision };
    },
    classify: async (hitchId) =>
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        const repo = new HitchRepository(db);
        const session = repo.requireSession(hitchId);
        const filter = {
          hitchId,
          scopeStatus: "unknown" as const,
          lifecycleStatusIn: OPEN_FINDING_LIFECYCLES,
        };
        let previousRemaining = repo.countFindings(filter);
        while (true) {
          const batch = repo.listFindings({
            ...filter,
            limit: FINDING_BATCH_LIMIT,
          });
          if (batch.length === 0) break;

          for (const finding of batch) {
            const classification = classifyFindingForHitch(session, finding);
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

          const remaining = repo.countFindings(filter);
          if (remaining === 0) return { resolved: true };
          if (remaining >= previousRemaining) {
            return {
              resolved: false,
              escalateReason:
                `classification made no progress for hitch ${hitchId}; ` +
                `${remaining} unknown findings remain`,
            };
          }
          previousRemaining = remaining;
        }
        const remaining = repo.countFindings(filter);
        if (remaining === 0) return { resolved: true };
        return {
          resolved: false,
          escalateReason:
            `classification did not drain hitch ${hitchId}; ` +
            `${remaining} unknown findings remain`,
        };
      }),
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
      const pr = await createPullRequest({
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
          new HitchRepository(db).updateStatus(hitchId, nextStatus, summary);
        });
        return { prUrl: pr.prUrl, draft: pr.draft, merged: outcome.merged };
      }

      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        new HitchRepository(db).updateStatus(
          hitchId,
          "closed",
          "hitch converged; PR opened",
        );
      });
      return { prUrl: pr.prUrl, draft: pr.draft, merged: false };
    },
    salvageReviewBranch: async (hitchId) => {
      const runId = withManagedDb({ dbPath: deps.dbPath }, (db) =>
        latestRunId(new HitchRepository(db), hitchId),
      );
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

/**
 * Phase 3: evaluate the merge gate for a freshly-created PR and, if it passes,
 * merge (recording an operation-audit row). A hard-blocked gate returns an
 * escalateReason (fail-closed: do NOT merge, do NOT close). CI-not-green
 * returns `{ merged: false }` so the caller closes the hitch and leaves the PR
 * open for a later merge.
 */
async function runAutoMerge(
  deps: OrchestratorRunnerDeps,
  hitchId: string,
  runId: string,
  repoPath: string,
  prNumber: number,
  reviewedHeadSha: string | undefined,
): Promise<{ merged: boolean; escalateReason?: string; recheckable?: boolean }> {
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
  // Advisory ingestion of external review verdicts (opt-in). A
  // CHANGES_REQUESTED verdict becomes an unknown-scope finding, which makes the
  // close-readiness re-eval below fail → the gate escalates for the operator to
  // classify (fail-closed; external approvals are never trusted to merge).
  await ingestExternalReviewVerdicts(deps, hitchId, prNumber);
  const tier = withManagedDb({ dbPath: deps.dbPath }, (db) =>
    effectiveAutoMergeTier(db, runId, deps.harnessRoot),
  );
  const tierEligible = tier === 0;
  const ciGreen = tierEligible
    ? await autoMerge.ciStatus(prNumber, expectedHeadSha)
    : true;
  const gate = withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    // Re-evaluate close-readiness at merge time from the DB facts — a finding
    // or close-check could have changed since the PR was created.
    const closeReady =
      new ConvergenceService(repo).evaluate(hitchId).decision === "close_ready";
    const { consensus, humanApproved } = gatherApproval(db, runId);
    return evaluateMergeGate({
      autoMergeEnabled: true,
      closeReady,
      consensus,
      humanApproved,
      ciGreen,
      tierEligible,
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
        input: {
          hitchId,
          runId,
          prNumber,
          method,
          expectedHeadSha,
          ciGreen,
          tier,
          gate,
        },
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
  // transient: leave the PR open for a later merge. `recheckable` is true only
  // for CI-not-green (a temporal blocker that a re-run can clear); a
  // tier_not_auto_eligible block is permanent (the path's tier never changes),
  // so the hitch closes for a human merge rather than waiting on a re-check.
  return { merged: false, recheckable: gate.blockers.includes("ci_not_green") };
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

function changedPathsForRun(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT path
       FROM run_changed_files
       WHERE run_id = ? AND allowed = 1 AND status <> 'ignored'
       ORDER BY path`,
    )
    .all(runId) as { path: string }[];
  const dbPaths = rows
    .map((r) => r.path)
    .filter((p): p is string => typeof p === "string" && p !== "");
  if (dbPaths.length > 0) return dbPaths;

  const row = db
    .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
    .get(runId) as { meta_json: string | null } | undefined;
  if (row?.meta_json === undefined || row.meta_json === null) return [];
  const meta = JSON.parse(row.meta_json) as {
    reviewed?: { paths?: unknown };
  };
  const reviewedPaths = meta.reviewed?.paths;
  if (!Array.isArray(reviewedPaths)) return [];
  return reviewedPaths.filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
}

/** Whether the run's captured diff weakened the test suite (run-time signal). */
function runWeakensTests(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): boolean {
  const row = db
    .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
    .get(runId) as { meta_json: string | null } | undefined;
  if (row?.meta_json === undefined || row.meta_json === null) return false;
  try {
    const meta = JSON.parse(row.meta_json) as {
      reviewed?: { weakensTests?: unknown };
    };
    return meta.reviewed?.weakensTests === true;
  } catch {
    return false;
  }
}

/**
 * Auto-merge tier for a run: the sensitivity-map tier, but a Tier-0
 * (tests/docs-only) change that WEAKENS tests (deletes a test file or adds a
 * skip/only marker) is downgraded to Tier-1 so it cannot auto-merge — coverage
 * must not be removed by an automatic merge. Fail-closed (only tightens).
 */
function effectiveAutoMergeTier(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
  harnessRoot: string,
): AutoMergeTier {
  const base = computeAutoMergeTier(
    changedPathsForRun(db, runId),
    loadAutoMergeSensitivityMap(harnessRoot),
  );
  return base === 0 && runWeakensTests(db, runId) ? 1 : base;
}

/**
 * Opt-in advisory ingestion of external PR review verdicts (codex GitHub App /
 * Copilot). Each `CHANGES_REQUESTED` verdict is recorded ONCE as an
 * unknown-scope hitch finding; the close-readiness re-eval in the merge gate
 * then fails, so the gate escalates for the operator to classify. External
 * approvals are NEVER ingested — an external "approve" cannot authorise a merge
 * (§0/§6: external output may only push fail-closed, never approve). Best
 * effort: a fetch failure is swallowed so it cannot break the merge path.
 */
function defaultReviewSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch the PR's CHANGES_REQUESTED verdicts once; a fetch failure yields none. */
async function fetchBlockingVerdicts(
  fetchVerdicts: (prNumber: number) => Promise<{ author: string; state: string }[]>,
  prNumber: number,
): Promise<{ author: string; state: string }[]> {
  try {
    const verdicts = await fetchVerdicts(prNumber);
    return verdicts.filter((v) => v.state.toUpperCase() === "CHANGES_REQUESTED");
  } catch {
    return [];
  }
}

async function ingestExternalReviewVerdicts(
  deps: OrchestratorRunnerDeps,
  hitchId: string,
  prNumber: number,
): Promise<void> {
  const fetchVerdicts = deps.autoMerge?.reviewVerdicts;
  if (fetchVerdicts === undefined) return;
  let blocking = await fetchBlockingVerdicts(fetchVerdicts, prNumber);
  const awaitCfg = deps.autoMerge?.reviewAwait;
  if (blocking.length === 0 && awaitCfg !== undefined) {
    // Bounded await: give async external reviewers a window to weigh in before
    // the gate is evaluated. Stop on the first blocking verdict or budget spent.
    const now = awaitCfg.now ?? Date.now;
    const sleep = awaitCfg.sleep ?? defaultReviewSleep;
    const start = now();
    while (now() - start < awaitCfg.timeoutMs) {
      const remaining = awaitCfg.timeoutMs - (now() - start);
      await sleep(Math.min(awaitCfg.intervalMs, remaining));
      blocking = await fetchBlockingVerdicts(fetchVerdicts, prNumber);
      if (blocking.length > 0) break;
    }
  }
  if (blocking.length === 0) return;
  withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    const seen = new Set(
      repo.listFindings({ hitchId, limit: 10_000 }).map((f) => f.stableKey),
    );
    for (const v of blocking) {
      const stableKey = `external-review:${prNumber}:${v.author}`;
      if (seen.has(stableKey)) continue; // ingest each verdict once (no reopen loop)
      repo.upsertFinding({
        hitchId,
        source: "review",
        sourceRef: `external_review:${prNumber}:${v.author}`,
        severity: "P1",
        category: "external-review-changes-requested",
        scopeStatus: "unknown",
        summary: `External reviewer ${v.author} requested changes on PR #${prNumber}`,
        classificationReason:
          "external review verdict ingested as advisory; classify before acting",
        stableKey,
      });
    }
  });
}
