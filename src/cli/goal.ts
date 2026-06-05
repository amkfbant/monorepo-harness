import process from "node:process";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { harnessPaths } from "../config/paths.js";
import { BacklogError } from "../core/backlog.js";
import { DbError } from "../db/connection.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import {
  classifyFindingForGoal,
  type ClassifiableGoalFinding,
} from "../goal/classification.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import {
  createGhPrPublisher,
  createGhPrMerger,
  createGhCiStatus,
  createGhReviewVerdicts,
} from "../core/gh-pr-publisher.js";
import { createGhCopilotReviewer } from "../core/copilot-reviewer-gh.js";
import type { PrMergeMethod } from "../core/pr-creator.js";
import { ConvergenceService } from "../goal/convergence.js";
import { recordConvergenceDecisionWithStatus } from "../goal/convergence-status.js";
import { deferFindingToBacklog } from "../goal/followups.js";
import { GoalOrchestrator } from "../goal/orchestrator.js";
import { decideOrchestratorAction } from "../goal/orchestrator-dispatch.js";
import { createOrchestratorRunners } from "../goal/orchestrator-runners.js";
import {
  GoalRepository,
  type CompleteReviewCycleInput,
  type UpsertGoalFindingInput,
} from "../goal/repository.js";
import {
  parseGoalCloseConditions,
  parseGoalPolicy,
  parseGoalScope,
} from "../goal/schemas.js";
import {
  GOAL_ATTEMPT_STATUSES,
  GOAL_ATTEMPT_TYPES,
  GOAL_CLOSE_CHECK_STATUSES,
  GOAL_FINDING_SEVERITIES,
  GOAL_FINDING_SOURCES,
  GOAL_REVIEW_MODES,
  GOAL_SCOPE_STATUSES,
  GOAL_STATUSES,
  type GoalAttemptStatus,
  type GoalAttemptType,
  type GoalCloseCheckStatus,
  type GoalConvergenceResult,
  type GoalFindingSeverity,
  type GoalFindingSource,
  type GoalReviewMode,
  type GoalScopeStatus,
  type GoalStatus,
} from "../goal/types.js";

export interface RegisterGoalCommandsOptions {
  getHarnessRoot: () => string;
}

interface GoalContext {
  root: string;
  paths: ReturnType<typeof harnessPaths>;
  repo: GoalRepository;
}

export function registerGoalCommands(
  program: Command,
  opts: RegisterGoalCommandsOptions,
): void {
  const goalCmd = program
    .command("goal")
    .description("goal convergence controller");

  goalCmd
    .command("start")
    .description("create a goal session")
    .requiredOption("--title <text>", "goal title")
    .option("--goal-id <id>", "explicit goal id")
    .option("--description <text>", "goal description")
    .option("--project <id>", "project id")
    .option("--repo-id <id>", "repo id")
    .option("--domain <domain>", "goal domain")
    .option("--backlog-item-id <id>", "source backlog item id")
    .option("--scope-file <path>", "YAML/JSON goal scope file")
    .option("--close-file <path>", "YAML/JSON close conditions file")
    .option("--policy-file <path>", "YAML/JSON policy file")
    .option("--max-iterations <n>", "iteration budget")
    .option("--max-review-cycles <n>", "review cycle budget")
    .option("--max-reruns <n>", "rerun budget")
    .option("--max-total-new-findings <n>", "new finding budget")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const result = withGoalRepo(opts, ({ repo }) =>
          repo.createSession({
            ...(raw.goalId !== undefined ? { goalId: String(raw.goalId) } : {}),
            title: String(raw.title),
            ...(raw.description !== undefined
              ? { description: String(raw.description) }
              : {}),
            ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
            ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
            ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
            ...(raw.backlogItemId !== undefined
              ? { backlogItemId: String(raw.backlogItemId) }
              : {}),
            scope:
              raw.scopeFile === undefined
                ? {}
                : parseGoalScope(readStructuredFile(String(raw.scopeFile))),
            closeConditions:
              raw.closeFile === undefined
                ? []
                : parseGoalCloseConditions(
                    readStructuredFile(String(raw.closeFile)),
                  ),
            ...(raw.policyFile !== undefined
              ? { policy: parseGoalPolicy(readStructuredFile(String(raw.policyFile))) }
              : {}),
            ...(raw.maxIterations !== undefined
              ? { maxIterations: parsePositiveInt(raw.maxIterations, "--max-iterations") }
              : {}),
            ...(raw.maxReviewCycles !== undefined
              ? {
                  maxReviewCycles: parsePositiveInt(
                    raw.maxReviewCycles,
                    "--max-review-cycles",
                  ),
                }
              : {}),
            ...(raw.maxReruns !== undefined
              ? { maxReruns: parseNonNegativeInt(raw.maxReruns, "--max-reruns") }
              : {}),
            ...(raw.maxTotalNewFindings !== undefined
              ? {
                  maxTotalNewFindings: parseNonNegativeInt(
                    raw.maxTotalNewFindings,
                    "--max-total-new-findings",
                  ),
                }
              : {}),
            createdBy: String(raw.createdBy),
            createdSource: "cli",
          }),
        );
        writeOutput(raw, result, `goal=${result.goalId} status=${result.status}\n`);
      });
    });

  goalCmd
    .command("list")
    .description("list goal sessions")
    .option("--status <status>", "filter by status")
    .option("--project <id>", "filter by project id")
    .option("--repo-id <id>", "filter by repo id")
    .option("--domain <domain>", "filter by domain")
    .option("--limit <n>", "max rows", "50")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const rows = withGoalRepo(opts, ({ repo }) =>
          repo.listSessions({
            ...(raw.status !== undefined
              ? { status: parseChoice(raw.status, GOAL_STATUSES, "--status") }
              : {}),
            ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
            ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
            ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
            limit: parsePositiveInt(raw.limit, "--limit"),
          }),
        );
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ goals: rows }, null, 2)}\n`);
        } else {
          process.stdout.write(
            rows
              .map(
                (g) =>
                  `${g.goalId}\t${g.status}\t${g.domain ?? "-"}\t${g.title}`,
              )
              .join("\n") + (rows.length > 0 ? "\n" : ""),
          );
        }
      });
    });

  goalCmd
    .command("status")
    .description("show a goal session with current convergence")
    .argument("<goal-id>", "goal id")
    .option("--json", "emit JSON", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const result = withGoalRepo(opts, ({ repo }) => {
          const session = repo.requireSession(goalId);
          const findings = repo.listFindings({ goalId, limit: 10_000 });
          const decisions = repo.listDecisions(goalId);
          const convergence = new ConvergenceService(repo).evaluate(goalId);
          return { session, findings, decisions, convergence };
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(
            `goal=${result.session.goalId} status=${result.session.status} ` +
              `decision=${result.convergence.decision} ` +
              `openP1=${result.convergence.metrics.openInScopeP1} ` +
              `unknown=${result.convergence.metrics.openUnknownScope}\n`,
          );
        }
      });
    });

  goalCmd
    .command("close")
    .description("close a goal after convergence says close_ready")
    .argument("<goal-id>", "goal id")
    .requiredOption("--summary <text>", "close summary")
    .option("--force", "close even when convergence is not close_ready", false)
    .option("--json", "emit JSON", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const result = withGoalRepo(opts, ({ repo }) => {
          const convergence = new ConvergenceService(repo).evaluate(goalId);
          if (convergence.decision !== "close_ready" && raw.force !== true) {
            throw new GoalCliError(
              `goal ${goalId} is not close_ready (decision=${convergence.decision}); use --force to override`,
            );
          }
          return repo.updateStatus(goalId, "closed", String(raw.summary));
        });
        writeOutput(raw, result, `goal=${result.goalId} status=${result.status}\n`);
      });
    });

  goalCmd
    .command("cancel")
    .description("cancel a goal")
    .argument("<goal-id>", "goal id")
    .requiredOption("--reason <text>", "cancel reason")
    .option("--json", "emit JSON", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const result = withGoalRepo(opts, ({ repo }) =>
          repo.updateStatus(goalId, "cancelled", String(raw.reason)),
        );
        writeOutput(raw, result, `goal=${result.goalId} status=${result.status}\n`);
      });
    });

  const attemptCmd = goalCmd.command("attempt").description("goal attempts");
  attemptCmd
    .command("start")
    .description("start a goal attempt")
    .argument("<goal-id>", "goal id")
    .requiredOption("--type <type>", "attempt type")
    .option("--iteration <n>", "explicit iteration")
    .option("--operation-id <id>", "operation id")
    .option("--run-id <id>", "run id")
    .option("--parent-attempt-id <id>", "parent attempt id")
    .option("--input-json <json>", "input JSON object")
    .option("--json", "emit JSON", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const attempt = withGoalRepo(opts, ({ repo }) =>
          repo.createAttempt({
            goalId,
            attemptType: parseChoice(
              raw.type,
              GOAL_ATTEMPT_TYPES,
              "--type",
            ) as GoalAttemptType,
            ...(raw.iteration !== undefined
              ? { iteration: parsePositiveInt(raw.iteration, "--iteration") }
              : {}),
            ...(raw.operationId !== undefined
              ? { operationId: String(raw.operationId) }
              : {}),
            ...(raw.runId !== undefined ? { runId: String(raw.runId) } : {}),
            ...(raw.parentAttemptId !== undefined
              ? { parentAttemptId: String(raw.parentAttemptId) }
              : {}),
            ...(raw.inputJson !== undefined
              ? { input: parseJsonRecord(String(raw.inputJson), "--input-json") }
              : {}),
          }),
        );
        writeOutput(
          raw,
          attempt,
          `attempt=${attempt.attemptId} goal=${attempt.goalId} status=${attempt.status}\n`,
        );
      });
    });

  attemptCmd
    .command("complete")
    .description("complete a goal attempt")
    .argument("<attempt-id>", "attempt id")
    .requiredOption("--status <status>", "succeeded | failed | cancelled")
    .option("--operation-id <id>", "operation id")
    .option("--run-id <id>", "run id")
    .option("--result-json <json>", "result JSON object")
    .option("--error <text>", "error message")
    .option("--json", "emit JSON", false)
    .action((attemptId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const status = parseChoice(
          raw.status,
          ["succeeded", "failed", "cancelled"],
          "--status",
        ) as Exclude<GoalAttemptStatus, "pending" | "running">;
        const attempt = withGoalRepo(opts, ({ repo }) =>
          repo.completeAttempt({
            attemptId,
            status,
            ...(raw.operationId !== undefined
              ? { operationId: String(raw.operationId) }
              : {}),
            ...(raw.runId !== undefined ? { runId: String(raw.runId) } : {}),
            ...(raw.resultJson !== undefined
              ? { result: parseJsonRecord(String(raw.resultJson), "--result-json") }
              : {}),
            ...(raw.error !== undefined ? { errorMessage: String(raw.error) } : {}),
          }),
        );
        writeOutput(
          raw,
          attempt,
          `attempt=${attempt.attemptId} status=${attempt.status}\n`,
        );
      });
    });

  const findingCmd = goalCmd.command("finding").description("goal findings");
  findingCmd
    .command("add")
    .description("record a finding")
    .argument("<goal-id>", "goal id")
    .requiredOption("--severity <severity>", "P0 | P1 | P2 | P3 | info")
    .requiredOption("--category <category>", "finding category")
    .requiredOption("--summary <text>", "finding summary")
    .option("--detail <text>", "finding detail")
    .option("--file <path>", "file path")
    .option("--symbol <symbol>", "symbol")
    .option("--suggested-fix <text>", "suggested fix")
    .option("--source <source>", "review | test | doctor | human | mcp | codex | other", "human")
    .option("--source-ref <ref>", "source reference")
    .option("--source-attempt-id <id>", "source attempt id")
    .option("--source-cycle-id <id>", "source review cycle id")
    .option("--scope <scope>", "in-scope | out-of-scope | unknown | duplicate")
    .option("--json", "emit JSON", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const result = withGoalRepo(opts, ({ repo }) => {
          const session = repo.requireSession(goalId);
          const source = parseChoice(
            raw.source,
            GOAL_FINDING_SOURCES,
            "--source",
          ) as GoalFindingSource;
          const findingForClassification: ClassifiableGoalFinding = {
            source,
            severity: parseChoice(
              raw.severity,
              GOAL_FINDING_SEVERITIES,
              "--severity",
            ) as GoalFindingSeverity,
            category: String(raw.category),
            summary: String(raw.summary),
            ...(raw.detail !== undefined ? { detail: String(raw.detail) } : {}),
            ...(raw.file !== undefined ? { filePath: String(raw.file) } : {}),
            ...(raw.symbol !== undefined ? { symbol: String(raw.symbol) } : {}),
            ...(raw.sourceRef !== undefined
              ? { sourceRef: String(raw.sourceRef) }
              : {}),
          };
          const classification =
            raw.scope === undefined
              ? classifyFindingForGoal(session, findingForClassification)
              : {
                  scopeStatus: parseScope(raw.scope),
                  reason: "manual scope supplied by CLI",
                };
          const input: UpsertGoalFindingInput = {
            goalId,
            source,
            severity: findingForClassification.severity as GoalFindingSeverity,
            category: String(raw.category),
            scopeStatus: classification.scopeStatus,
            summary: String(raw.summary),
            classificationReason: classification.reason,
            ...(raw.detail !== undefined ? { detail: String(raw.detail) } : {}),
            ...(raw.file !== undefined ? { filePath: String(raw.file) } : {}),
            ...(raw.symbol !== undefined ? { symbol: String(raw.symbol) } : {}),
            ...(raw.suggestedFix !== undefined
              ? { suggestedFix: String(raw.suggestedFix) }
              : {}),
            ...(raw.sourceRef !== undefined
              ? { sourceRef: String(raw.sourceRef) }
              : {}),
            ...(raw.sourceAttemptId !== undefined
              ? { sourceAttemptId: String(raw.sourceAttemptId) }
              : {}),
            ...(raw.sourceCycleId !== undefined
              ? { sourceCycleId: String(raw.sourceCycleId) }
              : {}),
          };
          return repo.upsertFinding(input);
        });
        writeOutput(
          raw,
          result,
          `finding=${result.finding.findingId} created=${result.created} scope=${result.finding.scopeStatus} lifecycle=${result.finding.lifecycleStatus}\n`,
        );
      });
    });

  findingCmd
    .command("classify")
    .description("manually classify a finding")
    .argument("<finding-id>", "finding id")
    .requiredOption("--scope <scope>", "in-scope | out-of-scope | unknown | duplicate")
    .requiredOption("--reason <text>", "classification reason")
    .option("--duplicate-of <finding-id>", "canonical duplicate finding id")
    .option("--json", "emit JSON", false)
    .action((findingId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const finding = withGoalRepo(opts, ({ repo }) =>
          repo.classifyFinding({
            findingId,
            scopeStatus: parseScope(raw.scope),
            reason: String(raw.reason),
            ...(raw.duplicateOf !== undefined
              ? { duplicateOf: String(raw.duplicateOf) }
              : {}),
          }),
        );
        writeOutput(
          raw,
          finding,
          `finding=${finding.findingId} scope=${finding.scopeStatus} lifecycle=${finding.lifecycleStatus}\n`,
        );
      });
    });

  findingCmd
    .command("fixed")
    .description("mark a finding fixed")
    .argument("<finding-id>", "finding id")
    .option("--note <text>", "resolution note")
    .option("--json", "emit JSON", false)
    .action((findingId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const finding = withGoalRepo(opts, ({ repo }) =>
          repo.markFindingFixed({
            findingId,
            ...(raw.note !== undefined ? { note: String(raw.note) } : {}),
          }),
        );
        writeOutput(
          raw,
          finding,
          `finding=${finding.findingId} lifecycle=${finding.lifecycleStatus}\n`,
        );
      });
    });

  findingCmd
    .command("defer")
    .description("defer an out-of-scope finding")
    .argument("<finding-id>", "finding id")
    .option("--backlog", "create and link a backlog follow-up", false)
    .requiredOption("--reason <text>", "deferral reason")
    .option("--json", "emit JSON", false)
    .action(async (findingId: string, raw: Record<string, unknown>) => {
      await withGoalErrorExitAsync(async () => {
        const result = await withGoalRepoAsync(opts, async (ctx) =>
          deferFindingToBacklog({
            repository: ctx.repo,
            findingId,
            reason: String(raw.reason),
            createBacklogItem: raw.backlog === true,
            ...(raw.backlog === true
              ? {
                  backlogContext: {
                    backlogDir: ctx.paths.backlogDir,
                    dbPath: ctx.paths.dbPath,
                  },
                }
              : {}),
          }),
        );
        writeOutput(
          raw,
          result,
          `finding=${result.finding.findingId} lifecycle=${result.finding.lifecycleStatus}` +
            (result.backlogItemId !== null
              ? ` backlogItem=${result.backlogItemId}`
              : "") +
            "\n",
        );
      });
    });

  const cycleCmd = goalCmd
    .command("review-cycle")
    .description("goal review cycles");
  cycleCmd
    .command("start")
    .description("start a review cycle")
    .argument("<goal-id>", "goal id")
    .requiredOption("--mode <mode>", "initial | delta | close | regression | manual")
    .option("--trigger-attempt-id <id>", "trigger attempt id")
    .option("--source-review-id <id>", "source review id")
    .option("--source-run-id <id>", "source run id")
    .option("--json", "emit JSON", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const cycle = withGoalRepo(opts, ({ repo }) =>
          repo.startReviewCycle({
            goalId,
            reviewMode: parseChoice(
              raw.mode,
              GOAL_REVIEW_MODES,
              "--mode",
            ) as GoalReviewMode,
            ...(raw.triggerAttemptId !== undefined
              ? { triggerAttemptId: String(raw.triggerAttemptId) }
              : {}),
            ...(raw.sourceReviewId !== undefined
              ? { sourceReviewId: String(raw.sourceReviewId) }
              : {}),
            ...(raw.sourceRunId !== undefined
              ? { sourceRunId: String(raw.sourceRunId) }
              : {}),
          }),
        );
        writeOutput(
          raw,
          cycle,
          `cycle=${cycle.cycleId} number=${cycle.cycleNumber} mode=${cycle.reviewMode}\n`,
        );
      });
    });

  cycleCmd
    .command("complete")
    .description("complete a review cycle")
    .argument("<cycle-id>", "cycle id")
    .option("--from-findings <path>", "YAML/JSON summary with finding counts")
    .option("--findings-seen <n>", "findings seen")
    .option("--findings-new <n>", "new findings")
    .option("--findings-reopened <n>", "reopened findings")
    .option("--findings-fixed <n>", "fixed findings")
    .option("--findings-deferred <n>", "deferred findings")
    .option("--findings-in-scope-open <n>", "open in-scope findings")
    .option("--summary <text>", "review cycle summary")
    .option("--json", "emit JSON", false)
    .action((cycleId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const fileInput =
          raw.fromFindings === undefined
            ? {}
            : parseCycleCounts(readStructuredFile(String(raw.fromFindings)));
        const cycle = withGoalRepo(opts, ({ repo }) =>
          repo.completeReviewCycle({
            cycleId,
            ...fileInput,
            ...countOption(raw, "findingsSeen", "--findings-seen"),
            ...countOption(raw, "findingsNew", "--findings-new"),
            ...countOption(raw, "findingsReopened", "--findings-reopened"),
            ...countOption(raw, "findingsFixed", "--findings-fixed"),
            ...countOption(raw, "findingsDeferred", "--findings-deferred"),
            ...countOption(
              raw,
              "findingsInScopeOpen",
              "--findings-in-scope-open",
            ),
            ...(raw.summary !== undefined ? { summary: String(raw.summary) } : {}),
          }),
        );
        writeOutput(
          raw,
          cycle,
          `cycle=${cycle.cycleId} findingsNew=${cycle.findingsNew}\n`,
        );
      });
    });

  const closeCheckCmd = goalCmd
    .command("close-check")
    .description("goal close checks");
  closeCheckCmd
    .command("record")
    .description("record close-check evidence")
    .argument("<goal-id>", "goal id")
    .requiredOption("--condition <id>", "close condition id")
    .requiredOption("--status <status>", "pending | passed | failed | skipped | unknown")
    .option("--checked-by <actor>", "actor label", "cli")
    .option("--message <text>", "message")
    .option("--evidence-json <json>", "evidence JSON object")
    .option("--json", "emit JSON", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const check = withGoalRepo(opts, ({ repo }) =>
          repo.recordCloseCheck({
            goalId,
            conditionId: String(raw.condition),
            status: parseChoice(
              raw.status,
              GOAL_CLOSE_CHECK_STATUSES,
              "--status",
            ) as GoalCloseCheckStatus,
            checkedBy: String(raw.checkedBy),
            ...(raw.message !== undefined ? { message: String(raw.message) } : {}),
            ...(raw.evidenceJson !== undefined
              ? {
                  evidence: parseJsonRecord(
                    String(raw.evidenceJson),
                    "--evidence-json",
                  ),
                }
              : {}),
          }),
        );
        writeOutput(raw, check, `check=${check.checkId} status=${check.status}\n`);
      });
    });

  goalCmd
    .command("check-convergence")
    .description("evaluate and record a goal convergence decision")
    .argument("<goal-id>", "goal id")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--no-record", "evaluate without recording a decision")
    .option("--no-status-update", "do not update goal status from the decision")
    .option("--json", "emit JSON", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(() => {
        const out = withGoalRepo(opts, ({ repo }) => {
          const result = new ConvergenceService(repo).evaluate(goalId);
          if (raw.record === false) {
            return { ...result, decisionRecord: null, goalStatus: null };
          }
          const recorded = recordConvergenceDecisionWithStatus({
            repository: repo,
            goalId,
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

  goalCmd
    .command("orchestrate")
    .description("drive a goal to a terminal state (run/review/rerun/close/pr)")
    .argument("<goal-id>", "goal id")
    .option("--repo <path>", "path to the target git repo (required unless --dry-run)")
    .option("--base-branch <name>", "base branch for runs and the PR", "main")
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
    .action(async (goalId: string, raw: Record<string, unknown>) => {
      await withGoalErrorExitAsync(async () => {
        if (raw.dryRun === true) {
          const { convergence, action } = withGoalRepo(opts, ({ repo }) => {
            const result = new ConvergenceService(repo).evaluate(goalId);
            return { convergence: result, action: decideOrchestratorAction(result) };
          });
          process.stdout.write(
            `goal=${goalId} decision=${convergence.decision} next-action=${action.kind}\n`,
          );
          return;
        }
        if (typeof raw.repo !== "string" || raw.repo === "") {
          throw new Error("goal orchestrate requires --repo <path> unless --dry-run");
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
        const result = await new GoalOrchestrator({ dbPath }).run({
          goalId,
          runners: createOrchestratorRunners({
            dbPath,
            harnessRoot: opts.getHarnessRoot(),
            createdBy: "cli",
            coderRunner: createCodexCliRunner({ codexBin, sandbox: "workspace-write" }),
            reviewerRunner: createCodexCliRunner({ codexBin, sandbox: "read-only" }),
            publisher: createGhPrPublisher(),
            ...(autoMerge !== undefined ? { autoMerge } : {}),
            ...(copilotReview !== undefined ? { copilotReview } : {}),
            repoPath,
            baseBranch: String(raw.baseBranch ?? "main"),
          }),
          maxSteps: parsePositiveInt(raw.maxSteps ?? 50, "--max-steps"),
          createdBy: "cli",
        });
        process.stdout.write(
          `goal=${goalId} outcome=${result.outcome}` +
            (result.prUrl !== undefined ? ` pr=${result.prUrl}` : "") +
            (result.escalateReason !== undefined
              ? ` escalate=${result.escalateReason}`
              : "") +
            "\n",
        );
      });
    });
}

function withGoalRepo<T>(
  opts: RegisterGoalCommandsOptions,
  fn: (ctx: GoalContext) => T,
): T {
  const root = opts.getHarnessRoot();
  const paths = harnessPaths(root);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    return fn({ root, paths, repo: new GoalRepository(handle.db) });
  } finally {
    handle.close();
  }
}

async function withGoalRepoAsync<T>(
  opts: RegisterGoalCommandsOptions,
  fn: (ctx: GoalContext) => Promise<T>,
): Promise<T> {
  const root = opts.getHarnessRoot();
  const paths = harnessPaths(root);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    return await fn({ root, paths, repo: new GoalRepository(handle.db) });
  } finally {
    handle.close();
  }
}

function withGoalErrorExit(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    goalError(e);
  }
}

async function withGoalErrorExitAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    goalError(e);
  }
}

function goalError(e: unknown): never {
  if (e instanceof GoalCliError || e instanceof DbError || e instanceof BacklogError) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

class GoalCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalCliError";
  }
}

function writeOutput(raw: Record<string, unknown>, value: unknown, text: string): void {
  process.stdout.write(raw.json === true ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function writeConvergence(
  raw: Record<string, unknown>,
  value: GoalConvergenceResult & { decisionRecord: unknown },
): void {
  if (raw.json === true) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `goal=${value.goalId} decision=${value.decision} reason=${value.reason}\n`,
  );
}

function readStructuredFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(text) as unknown;
  return parseYaml(text) as unknown;
}

function parseJsonRecord(text: string, flag: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GoalCliError(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseScope(value: unknown): GoalScopeStatus {
  const normalized = String(value).replace(/-/g, "_");
  return parseChoice(normalized, GOAL_SCOPE_STATUSES, "--scope") as GoalScopeStatus;
}

function parseChoice<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  flag: string,
): T[number] {
  const str = String(value);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new GoalCliError(
      `${flag} must be one of ${allowed.join("|")} (got ${JSON.stringify(str)})`,
    );
  }
  return str as T[number];
}

function parsePositiveInt(value: unknown, flag: string): number {
  const parsed = parseNonNegativeInt(value, flag);
  if (parsed < 1) throw new GoalCliError(`${flag} must be a positive integer`);
  return parsed;
}

function parseMergeMethod(value: unknown): PrMergeMethod {
  if (value === "squash" || value === "merge" || value === "rebase") {
    return value;
  }
  throw new GoalCliError("--merge-method must be one of: squash, merge, rebase");
}

function parseNonNegativeInt(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new GoalCliError(`${flag} must be a non-negative integer`);
  }
  return n;
}

function countOption(
  raw: Record<string, unknown>,
  key: keyof CompleteReviewCycleInput,
  flag: string,
): Partial<CompleteReviewCycleInput> {
  const value = raw[key];
  return value === undefined ? {} : { [key]: parseNonNegativeInt(value, flag) };
}

function parseCycleCounts(value: unknown): Partial<CompleteReviewCycleInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GoalCliError("--from-findings must contain an object");
  }
  const raw = value as Record<string, unknown>;
  return {
    ...parseCountField(raw, "findingsSeen"),
    ...parseCountField(raw, "findingsNew"),
    ...parseCountField(raw, "findingsReopened"),
    ...parseCountField(raw, "findingsFixed"),
    ...parseCountField(raw, "findingsDeferred"),
    ...parseCountField(raw, "findingsInScopeOpen"),
    ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
  };
}

function parseCountField(
  raw: Record<string, unknown>,
  key: keyof CompleteReviewCycleInput,
): Partial<CompleteReviewCycleInput> {
  return raw[key] === undefined
    ? {}
    : { [key]: parseNonNegativeInt(raw[key], key) };
}
