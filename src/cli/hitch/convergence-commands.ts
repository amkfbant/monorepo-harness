import process from "node:process";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { createCodexCliRunner } from "../../codex/codex-cli-runner.js";
import { coderRunnerDeps } from "../../core/agent-runner.js";
import { createGhPrPublisher, createGhPrMerger, createGhCiStatus, createGhReviewVerdicts } from "../../core/gh-pr-publisher.js";
import { createGhCopilotReviewer } from "../../core/copilot-reviewer-gh.js";
import { ConvergenceService } from "../../hitch/convergence.js";
import { recordConvergenceDecisionWithStatus } from "../../hitch/convergence-status.js";
import { HitchOrchestrator } from "../../hitch/orchestrator.js";
import { awaitHitchMerge, awaitStepFromCloseResult, type AwaitMergeStep } from "../../hitch/await-merge.js";
import { linkAgentWorkspaceToHitch } from "../../workspace/workspace-hitch-link.js";
import { decideOrchestratorAction } from "../../hitch/orchestrator-dispatch.js";
import { createOrchestratorRunners, HitchNotCloseReadyError } from "../../hitch/orchestrator-runners.js";
import { assertHitchOrchestrateSchemaCompatible, formatHitchOrchestrateResultLine, HitchCliError, latestAdoptedPrEvent, parseMergeMethod, parseNonNegativeInt, parsePositiveInt, type RegisterHitchCommandsOptions, resolveHitchCloseRunnerDeps, resolveHitchCoderRunnerDeps, withHitchErrorExit, withHitchErrorExitAsync, withHitchRepo, writeConvergence } from "./helpers.js";
import { ingestClaudeSubagentUsage } from "../../telemetry/ingest-claude-subagent-usage.js";

/**
 * `harness hitch` check-convergence / orchestrate / await-merge（#125 A15: cli/hitch.ts から behaviour-zero 分割）。
 * registration 順は golden で凍結。共有 helper は ./helpers から。
 */
export function registerHitchConvergenceCommands(
  hitchCmd: Command,
  opts: RegisterHitchCommandsOptions,
): void {
  hitchCmd
    .command("check-convergence")
    .description("evaluate and record a hitch convergence decision")
    .argument("<hitch-id>", "hitch id")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--no-record", "evaluate without recording a decision")
    .option("--no-status-update", "do not update hitch status from the decision")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const out = withHitchRepo(opts, ({ repo }) => {
          const result = new ConvergenceService(repo).evaluate(hitchId);
          if (raw.record === false) {
            return { ...result, decisionRecord: null, hitchStatus: null };
          }
          const recorded = recordConvergenceDecisionWithStatus({
            repository: repo,
            hitchId,
            decision: result.decision,
            reason: result.reason,
            metrics: { ...result.metrics },
            recommendedNextAction: result.recommendedNextAction,
            createdBy: String(raw.createdBy),
            updateStatus: raw.statusUpdate !== false,
          });
          return { ...result, ...recorded };
        });
        writeConvergence(raw, out);
        if (
          out.decision === "diverging" ||
          out.decision === "budget_exhausted" ||
          out.decision === "escalate" ||
          out.decision === "needs_classification"
        ) {
          process.exit(2);
        }
      });
    });

  hitchCmd
    .command("orchestrate")
    .description("drive a hitch to a terminal state (run/review/rerun/close/pr)")
    .argument("<hitch-id>", "hitch id")
    .option("--repo <path>", "path to the target git repo (required unless --dry-run)")
    .option(
      "--base-branch <name>",
      "base branch for runs and the PR (overrides the project profile base branch; default: profile base branch, else main)",
    )
    .option("--max-steps <n>", "loop step cap", "50")
    .option("--dry-run", "print the next action only; do not execute", false)
    .option(
      "--auto-merge",
      "opt-in: auto-merge the PR when the merge gate passes (default OFF)",
      false,
    )
    .option(
      "--merge-method <method>",
      "merge method for --auto-merge (squash|merge|rebase)",
      "squash",
    )
    .option(
      "--ci-await-timeout <seconds>",
      "seconds to await pending CI before auto-merge fails closed",
      "1200",
    )
    .option(
      "--request-copilot-review",
      "opt-in: best-effort request a Copilot review on the PR (non-gating)",
      false,
    )
    .option(
      "--ingest-external-reviews",
      "opt-in: ingest external PR review verdicts; a CHANGES_REQUESTED review becomes an advisory finding and escalates the auto-merge gate (fail-closed)",
      false,
    )
    .option(
      "--external-review-timeout <seconds>",
      "seconds to await async external reviews (codex App / Copilot) before evaluating the gate; 0 = single check (requires --ingest-external-reviews)",
      "0",
    )
    .action(async (hitchId: string, raw: Record<string, unknown>) => {
      await withHitchErrorExitAsync(async () => {
        // #271: surface DB-newer-than-harness skew with friendly, actionable
        // guidance BEFORE any orchestration work begins.
        assertHitchOrchestrateSchemaCompatible(opts);
        if (raw.dryRun === true) {
          const { convergence, action } = withHitchRepo(opts, ({ repo }) => {
            const result = new ConvergenceService(repo).evaluate(hitchId);
            return { convergence: result, action: decideOrchestratorAction(result) };
          });
          process.stdout.write(
            `hitch=${hitchId} decision=${convergence.decision} next-action=${action.kind}\n`,
          );
          return;
        }
        if (typeof raw.repo !== "string" || raw.repo === "") {
          throw new Error("hitch orchestrate requires --repo <path> unless --dry-run");
        }
        const dbPath = harnessPaths(opts.getHarnessRoot()).dbPath;
        const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
        const repoPath = String(raw.repo);
        const ghBin = process.env.HARNESS_GH_BIN ?? "gh";
        const ciAwaitTimeoutMs =
          parseNonNegativeInt(raw.ciAwaitTimeout, "--ci-await-timeout") * 1_000;
        const externalReviewTimeoutMs =
          parseNonNegativeInt(
            raw.externalReviewTimeout,
            "--external-review-timeout",
          ) * 1_000;
        // Phase 3: auto-merge is opt-in (default OFF). Only when --auto-merge is
        // passed do we construct the merger + CI probe; otherwise the
        // orchestrator just creates the PR.
        const autoMerge =
          raw.autoMerge === true
            ? {
                merger: createGhPrMerger(ghBin),
                ciStatus: createGhCiStatus(repoPath, ghBin, undefined, {
                  awaitTimeoutMs: ciAwaitTimeoutMs,
                }),
                method: parseMergeMethod(raw.mergeMethod),
                ...(raw.ingestExternalReviews === true
                  ? {
                      reviewVerdicts: createGhReviewVerdicts(repoPath, ghBin),
                      ...(externalReviewTimeoutMs > 0
                        ? {
                            reviewAwait: {
                              timeoutMs: externalReviewTimeoutMs,
                              intervalMs: 15_000,
                            },
                          }
                        : {}),
                    }
                  : {}),
              }
            : undefined;
        // Best-effort Copilot review is opt-in (default OFF). Non-gating: the
        // outcome never affects close/merge.
        const copilotReview =
          raw.requestCopilotReview === true
            ? { reviewer: createGhCopilotReviewer(repoPath, ghBin) }
            : undefined;
        const runnerDeps = await resolveHitchCoderRunnerDeps({
          harnessRoot: opts.getHarnessRoot(),
          dbPath,
          hitchId,
          repoPath,
          ...(raw.baseBranch !== undefined
            ? { baseBranch: String(raw.baseBranch) }
            : {}),
        });
        // #236 — surface the effective run base (CLI override vs profile/default)
        // so an implicit override is never silent.
        process.stderr.write(
          `hitch ${hitchId}: using base branch ${runnerDeps.baseBranch}\n`,
        );
        const result = await new HitchOrchestrator({ dbPath }).run({
          hitchId,
          runners: createOrchestratorRunners({
            dbPath,
            harnessRoot: opts.getHarnessRoot(),
            createdBy: "cli",
            ...coderRunnerDeps(codexBin),
            reviewerRunner: createCodexCliRunner({ codexBin, sandbox: "read-only" }),
            publisher: createGhPrPublisher(),
            ...(autoMerge !== undefined ? { autoMerge } : {}),
            ...(copilotReview !== undefined ? { copilotReview } : {}),
            ...runnerDeps,
          }),
          maxSteps: parsePositiveInt(raw.maxSteps ?? 50, "--max-steps"),
          createdBy: "cli",
        });
        // Best-effort: if this ran in an agent worktree, link the workspace to
        // the hitch so `workspace status` reflects who is driving it. Never fails
        // the orchestration.
        const link = await linkAgentWorkspaceToHitch({
          repoPath,
          hitchId,
          harnessRoot: opts.getHarnessRoot(),
        });
        process.stdout.write(
          `${formatHitchOrchestrateResultLine(hitchId, result, link)}\n`,
        );
        // Fail-open telemetry: record ops-driven Claude subagent usage after the pass.
        // MUST never throw here — orchestrate already succeeded and output was written.
        ingestClaudeSubagentUsage({
          harnessRoot: opts.getHarnessRoot(),
          ...(process.env.HARNESS_CLAUDE_PROJECTS_DIR !== undefined
            ? { claudeProjectDir: process.env.HARNESS_CLAUDE_PROJECTS_DIR }
            : {}),
        });
      });
    });

  hitchCmd
    .command("await-merge")
    .description(
      "poll a close_ready hitch's open PR and merge it once the gate passes",
    )
    .argument("[hitch-id]", "hitch id (omit when using --all)")
    .option("--all", "drive EVERY close_ready hitch of --repo-id to merge", false)
    .option("--repo <path>", "path to the target git repo (required)")
    .option(
      "--repo-id <id>",
      "repo id to scope which hitches are driven (REQUIRED with --all; the gh CI/merge probes are bound to the single --repo, so --all must not span repos)",
    )
    .option(
      "--base-branch <name>",
      "base branch for the merge gate (default: main)",
    )
    .option(
      "--merge-method <method>",
      "merge method (squash|merge|rebase)",
      "squash",
    )
    .option(
      "--ci-await-timeout <seconds>",
      "seconds to await pending CI per attempt before failing closed",
      "1200",
    )
    .option(
      "--poll-interval <seconds>",
      "seconds between merge attempts while the PR awaits CI",
      "30",
    )
    .option(
      "--max-wait <seconds>",
      "total seconds to wait for the merge (0 = a single attempt)",
      "1800",
    )
    .option(
      "--ingest-external-reviews",
      "opt-in: ingest external PR review verdicts; a CHANGES_REQUESTED review escalates the gate (fail-closed)",
      false,
    )
    .option(
      "--external-review-timeout <seconds>",
      "seconds to await async external reviews before evaluating the gate; 0 = single check",
      "0",
    )
    .action(async (hitchArg: string | undefined, raw: Record<string, unknown>) => {
      await withHitchErrorExitAsync(async () => {
        const all = raw.all === true;
        if (all === (typeof hitchArg === "string" && hitchArg !== "")) {
          throw new HitchCliError(
            "hitch await-merge requires exactly one of <hitch-id> or --all",
          );
        }
        if (typeof raw.repo !== "string" || raw.repo === "") {
          throw new HitchCliError("hitch await-merge requires --repo <path>");
        }
        const repoIdScope =
          typeof raw.repoId === "string" && raw.repoId !== ""
            ? raw.repoId
            : undefined;
        // --all fans out across hitches but the gh CI/merge probes are bound to the
        // single --repo working dir; without a repo scope it could drive (and
        // merge) a PR of a DIFFERENT repo. Require --repo-id so --all never spans
        // repos. (Single-hitch mode names the hitch explicitly, like orchestrate.)
        if (all && repoIdScope === undefined) {
          throw new HitchCliError(
            "hitch await-merge --all requires --repo-id <id> (it must not span repos)",
          );
        }
        const dbPath = harnessPaths(opts.getHarnessRoot()).dbPath;
        const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
        const ghBin = process.env.HARNESS_GH_BIN ?? "gh";
        const repoPath = String(raw.repo);
        const ciAwaitTimeoutMs =
          parseNonNegativeInt(raw.ciAwaitTimeout, "--ci-await-timeout") * 1_000;
        const externalReviewTimeoutMs =
          parseNonNegativeInt(
            raw.externalReviewTimeout,
            "--external-review-timeout",
          ) * 1_000;
        const pollIntervalMs =
          parsePositiveInt(raw.pollInterval, "--poll-interval") * 1_000;
        const maxWaitMs =
          parseNonNegativeInt(raw.maxWait, "--max-wait") * 1_000;

        // await-merge ALWAYS merges (that is its purpose), so the auto-merge deps
        // are always constructed — same gate/CI/ingest wiring as `orchestrate
        // --auto-merge`. BOTH bounded awaits (CI and external-review) are CLAMPED
        // to the wall-clock budget left, so a single attempt cannot block past
        // `--max-wait`; the runners are rebuilt per poll with the fresh clamps.
        const buildRunners = async (hitchId: string, remainingMs: number) => {
          const ciAwaitMs = Math.min(ciAwaitTimeoutMs, remainingMs);
          const reviewTimeoutMs = Math.min(externalReviewTimeoutMs, remainingMs);
          const runnerDeps = resolveHitchCloseRunnerDeps({
            dbPath,
            hitchId,
            repoPath,
            ...(raw.baseBranch !== undefined
              ? { baseBranch: String(raw.baseBranch) }
              : {}),
          });
          return createOrchestratorRunners({
            dbPath,
            harnessRoot: opts.getHarnessRoot(),
            createdBy: "cli",
            ...coderRunnerDeps(codexBin),
            reviewerRunner: createCodexCliRunner({ codexBin, sandbox: "read-only" }),
            publisher: createGhPrPublisher(),
            autoMerge: {
              merger: createGhPrMerger(ghBin),
              ciStatus: createGhCiStatus(repoPath, ghBin, undefined, {
                awaitTimeoutMs: ciAwaitMs,
              }),
              method: parseMergeMethod(raw.mergeMethod),
              // External-review ingestion is budget-bounded too: the verdict
              // FETCH (`gh pr view`) timeout is clamped to the remaining budget,
              // and with no budget left (e.g. --max-wait 0) ingestion is omitted
              // entirely so a single fetch cannot block past the wall-clock.
              ...(raw.ingestExternalReviews === true && remainingMs > 0
                ? {
                    reviewVerdicts: createGhReviewVerdicts(
                      repoPath,
                      ghBin,
                      remainingMs,
                    ),
                    ...(reviewTimeoutMs > 0
                      ? {
                          reviewAwait: {
                            timeoutMs: reviewTimeoutMs,
                            intervalMs: 15_000,
                          },
                        }
                      : {}),
                  }
                : {}),
            },
            ...runnerDeps,
          });
        };

        const evalDecision = (hitchId: string): string =>
          withHitchRepo(opts, ({ repo }) =>
            new ConvergenceService(repo).evaluate(hitchId).decision,
          );

        // One probe: re-evaluate convergence and run AT MOST the close/merge step
        // (`closeAndPr` — the close/merge-ONLY runner; it can never run a coder or
        // review). A hitch that is not close_ready is reported as not_awaiting
        // without mutating anything. `remainingMs` clamps this attempt's awaits to
        // the budget left.
        const probe =
          (hitchId: string) =>
          async (remainingMs: number): Promise<AwaitMergeStep> => {
            const decision = evalDecision(hitchId);
            if (decision !== "close_ready") {
              return { kind: "not_awaiting", decision };
            }
            const runners = await buildRunners(hitchId, remainingMs);
            let result;
            try {
              result = await runners.closeAndPr(hitchId);
            } catch (e) {
              // Distinguish a benign DRIFT from a real close/merge failure by the
              // error TYPE (not a racy convergence re-read): closeAndPr throws a
              // typed HitchNotCloseReadyError from its pre-side-effect guard, so a
              // drift means nothing was mutated → just stop. ANY other throw is a
              // real PR-create/push/merge failure → escalate (fail-closed, as the
              // generic orchestrator does); never swallow it as not_awaiting.
              if (e instanceof HitchNotCloseReadyError) {
                return { kind: "not_awaiting", decision: e.decision };
              }
              const reason = e instanceof Error ? e.message : String(e);
              withHitchRepo(opts, ({ repo }) =>
                repo.updateStatus(hitchId, "escalated", reason, {
                  createdBy: "cli",
                }),
              );
              return { kind: "escalated", reason };
            }
            const step = awaitStepFromCloseResult(result);
            if (step.kind === "escalated") {
              // closeAndPr surfaces escalateReason but does NOT persist the
              // status (the generic orchestrator does); mirror that here so a
              // hard-blocked gate leaves the hitch `escalated` for a human.
              withHitchRepo(opts, ({ repo }) =>
                repo.updateStatus(
                  hitchId,
                  "escalated",
                  result.escalateReason as string,
                  { createdBy: "cli" },
                ),
              );
            }
            return step;
          };

        // --all: drive every close_ready hitch OF THE SCOPED REPO. The cap is
        // generous; if it is hit, surface the truncation explicitly rather than
        // silently dropping hitches.
        const ALL_CAP = 10_000;
        const hitchIds = all
          ? withHitchRepo(opts, ({ repo }) =>
              repo
                .listSessions({
                  status: "close_ready",
                  ...(repoIdScope !== undefined ? { repoId: repoIdScope } : {}),
                  limit: ALL_CAP,
                })
                .map((s) => s.hitchId),
            )
          : [String(hitchArg)];

        // Single-hitch mode: if a --repo-id was given, the named hitch must belong
        // to it — refuse to merge a hitch whose repo differs from the --repo dir.
        if (!all && repoIdScope !== undefined) {
          const namedHitchId = String(hitchArg);
          const session = withHitchRepo(opts, ({ repo }) =>
            repo.getSession(namedHitchId),
          );
          if (session !== null && session.repoId !== repoIdScope) {
            throw new HitchCliError(
              `hitch ${namedHitchId} belongs to repo "${session.repoId}", not "${repoIdScope}"`,
            );
          }
        }

        const adopted = withHitchRepo(opts, ({ repo }) =>
          hitchIds.filter(
            (hitchId) => latestAdoptedPrEvent(repo.listLifecycleEvents(hitchId)) !== null,
          ),
        );
        if (adopted.length > 0) {
          throw new HitchCliError(
            `hitch ${adopted.join(", ")} has an adopted PR; adopted PR is human merge only. ` +
              "Use hitch close --force after the human merge to close the record.",
          );
        }

        if (all && hitchIds.length === 0) {
          process.stdout.write("no close_ready hitches to await\n");
          return;
        }
        if (all && hitchIds.length === ALL_CAP) {
          process.stderr.write(
            `warning: --all processed the first ${ALL_CAP} close_ready hitches; ` +
              `more may remain — re-run to continue\n`,
          );
        }

        for (const hitchId of hitchIds) {
          const result = await awaitHitchMerge(
            {
              pollOnce: probe(hitchId),
              sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              now: () => Date.now(),
            },
            { pollIntervalMs, maxWaitMs },
          );
          process.stdout.write(
            `hitch=${hitchId} await-merge=${result.outcome} polls=${result.polls}` +
              ("prUrl" in result && result.prUrl !== undefined
                ? ` pr=${result.prUrl}`
                : "") +
              ("decision" in result ? ` decision=${result.decision}` : "") +
              ("reason" in result && result.reason !== undefined
                ? ` escalate=${result.reason}`
                : "") +
              "\n",
          );
        }
      });
    });
}
