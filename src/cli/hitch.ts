import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import type Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";
import { harnessPaths } from "../config/paths.js";
import {
  hitchTokenUsage,
  type DbHitchTokenUsage,
} from "../db/repositories/aggregates.js";
import { BacklogError } from "../core/backlog.js";
import { DbError } from "../db/connection.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations, readSchemaVersion } from "../db/migrations.js";
import { evaluateSchemaCompatibility } from "../db/schema-compat.js";
import {
  classifyFindingForHitch,
  type ClassifiableHitchFinding,
} from "../hitch/classification.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { codexBinaryVersion } from "../codex/codex-version.js";
import {
  createGhPrPublisher,
  createGhPrMerger,
  createGhCiStatus,
  createGhReviewVerdicts,
} from "../core/gh-pr-publisher.js";
import { createGhCopilotReviewer } from "../core/copilot-reviewer-gh.js";
import type { PrMergeMethod } from "../core/pr-creator.js";
import { ConvergenceService } from "../hitch/convergence.js";
import {
  evaluateConvergenceAndRecordStatus,
  recordConvergenceDecisionWithStatus,
} from "../hitch/convergence-status.js";
import { deferFindingToBacklog } from "../hitch/followups.js";
import { HitchOrchestrator } from "../hitch/orchestrator.js";
import {
  awaitHitchMerge,
  awaitStepFromCloseResult,
  type AwaitMergeStep,
} from "../hitch/await-merge.js";
import { findTransientLeaseCause } from "../workspace/db-domain-lock.js";
import { classifyChainDecision } from "../hitch/classify-rerun.js";
import { linkAgentWorkspaceToHitch } from "../workspace/workspace-hitch-link.js";
import { decideOrchestratorAction } from "../hitch/orchestrator-dispatch.js";
import {
  createOrchestratorRunners,
  HitchNotCloseReadyError,
  type OrchestratorRunnerDeps,
} from "../hitch/orchestrator-runners.js";
import {
  HitchRepository,
  OPEN_FINDING_LIFECYCLES,
  type CompleteHitchReviewCycleInput,
  type UpsertHitchFindingInput,
} from "../hitch/repository.js";
import {
  parseHitchCloseConditions,
  parseHitchPolicy,
  parseHitchScope,
} from "../hitch/schemas.js";
import {
  HITCH_ATTEMPT_STATUSES,
  HITCH_ATTEMPT_TYPES,
  HITCH_CLOSE_CHECK_STATUSES,
  HITCH_FINDING_SEVERITIES,
  HITCH_FINDING_SOURCES,
  HITCH_REVIEW_MODES,
  HITCH_SCOPE_STATUSES,
  HITCH_STATUSES,
  HitchValidationError,
  type HitchFinding,
  type HitchAttemptStatus,
  type HitchAttemptType,
  type HitchCloseCheckStatus,
  type HitchConvergenceResult,
  type HitchFindingSeverity,
  type HitchFindingSource,
  type HitchReviewMode,
  type HitchScopeStatus,
  type HitchStatus,
} from "../hitch/types.js";
import type { HitchOrchestrationResult } from "../hitch/orchestrator-types.js";
import { prepareProjectRun } from "../project/run-project.js";

export interface RegisterHitchCommandsOptions {
  getHarnessRoot: () => string;
}

interface HitchContext {
  root: string;
  paths: ReturnType<typeof harnessPaths>;
  repo: HitchRepository;
  db: Database.Database;
}

function hitchGoalText(session: { title: string; description: string | null }): string {
  return [session.title, session.description ?? ""]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}

export function resolveHitchCloseRunnerDeps(input: {
  dbPath: string;
  hitchId: string;
  repoPath: string;
  /** explicit `--base-branch`; defaults to "main" when omitted (#236). */
  baseBranch?: string;
}): Pick<OrchestratorRunnerDeps, "repoPath" | "baseBranch"> {
  const { db, close } = openManagedDb({ dbPath: input.dbPath });
  try {
    runMigrations(db);
    new HitchRepository(db).requireSession(input.hitchId);
  } finally {
    close();
  }
  return {
    repoPath: input.repoPath,
    baseBranch: input.baseBranch ?? "main",
  };
}

export async function resolveHitchCoderRunnerDeps(input: {
  harnessRoot: string;
  dbPath: string;
  hitchId: string;
  repoPath: string;
  /**
   * Explicit `--base-branch`. When set it OVERRIDES the project profile's
   * `repo.base_branch` (#236); when omitted, a project-scoped hitch falls back to
   * the profile's base branch and a project-less hitch to "main".
   */
  baseBranch?: string;
}): Promise<
  Pick<
    OrchestratorRunnerDeps,
    | "repoPath"
    | "baseBranch"
    | "resolveRunContext"
    | "projectRuntime"
  >
> {
  const { db, close } = openManagedDb({ dbPath: input.dbPath });
  let projectId: string | null;
  let domain: string | null;
  try {
    runMigrations(db);
    const session = new HitchRepository(db).requireSession(input.hitchId);
    projectId = session.projectId;
    domain = session.domain;
  } finally {
    close();
  }

  if (projectId === null) {
    return resolveHitchCloseRunnerDeps({
      dbPath: input.dbPath,
      hitchId: input.hitchId,
      repoPath: input.repoPath,
      ...(input.baseBranch !== undefined
        ? { baseBranch: input.baseBranch }
        : {}),
    });
  }
  if (domain === null) {
    throw new HitchCliError(
      `hitch ${input.hitchId} has projectId ${projectId} but no domain`,
    );
  }

  const prepared = await prepareProjectRun({
    harnessRoot: input.harnessRoot,
    projectId,
    domain,
    repoOverride: input.repoPath,
  });
  // #236 — an explicit `--base-branch` overrides the profile's base branch.
  // `prepareProjectRun` only RETURNS base_branch (nothing internal depends on
  // it), so overriding here is safe; the run resolves origin/<name> downstream.
  const baseBranch = input.baseBranch ?? prepared.baseBranch;
  return {
    repoPath: prepared.repoPath,
    baseBranch,
    resolveRunContext: (session) => ({
      repoPath: prepared.repoPath,
      repoId: prepared.repoId,
      domain: prepared.domain,
      goal: hitchGoalText(session),
      baseBranch,
    }),
    projectRuntime: {
      compiledPolicy: prepared.compiledPolicy,
      reviewRuleResolution: prepared.reviewRuleResolution,
      project: prepared.project,
      ...(prepared.projectContextPacks !== undefined
        ? { projectContextPacks: prepared.projectContextPacks }
        : {}),
    },
  };
}

export function registerHitchCommands(
  program: Command,
  opts: RegisterHitchCommandsOptions,
): void {
  const hitchCmd = program
    .command("hitch")
    .description("hitch convergence controller");

  hitchCmd
    .command("start")
    .description("create a hitch session")
    .requiredOption("--title <text>", "hitch title")
    .option("--hitch-id <id>", "explicit hitch id")
    .option("--description <text>", "hitch description")
    .option("--project <id>", "project id")
    .option("--repo-id <id>", "repo id")
    .option("--domain <domain>", "hitch domain")
    .option("--backlog-item-id <id>", "source backlog item id")
    .option("--scope-file <path>", "YAML/JSON hitch scope file")
    .option("--close-file <path>", "YAML/JSON close conditions file")
    .option("--policy-file <path>", "YAML/JSON policy file")
    .option("--max-iterations <n>", "iteration budget")
    .option("--max-review-cycles <n>", "review cycle budget")
    .option("--max-reruns <n>", "rerun budget")
    .option("--max-total-new-findings <n>", "new finding budget")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const result = withHitchRepo(opts, ({ repo }) =>
          repo.createSession({
            ...(raw.hitchId !== undefined ? { hitchId: String(raw.hitchId) } : {}),
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
                : parseHitchScope(readStructuredFile(String(raw.scopeFile))),
            closeConditions:
              raw.closeFile === undefined
                ? []
                : parseHitchCloseConditions(
                    readStructuredFile(String(raw.closeFile)),
                  ),
            ...(raw.policyFile !== undefined
              ? { policy: parseHitchPolicy(readStructuredFile(String(raw.policyFile))) }
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
        writeOutput(raw, result, `hitch=${result.hitchId} status=${result.status}\n`);
      });
    });

  hitchCmd
    .command("list")
    .description("list hitch sessions")
    .option("--status <status>", "filter by status")
    .option("--project <id>", "filter by project id")
    .option("--repo-id <id>", "filter by repo id")
    .option("--domain <domain>", "filter by domain")
    .option("--limit <n>", "max rows", "50")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const rows = withHitchRepo(opts, ({ repo }) =>
          repo.listSessions({
            ...(raw.status !== undefined
              ? { status: parseChoice(raw.status, HITCH_STATUSES, "--status") }
              : {}),
            ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
            ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
            ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
            limit: parsePositiveInt(raw.limit, "--limit"),
          }),
        );
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ hitches: rows }, null, 2)}\n`);
        } else {
          process.stdout.write(
            rows
              .map(
                (g) =>
                  `${g.hitchId}\t${g.status}\t${g.domain ?? "-"}\t${g.title}`,
              )
              .join("\n") + (rows.length > 0 ? "\n" : ""),
          );
        }
      });
    });

  hitchCmd
    .command("status")
    .description("show a hitch session with current convergence")
    .argument("<hitch-id>", "hitch id")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const result = withHitchRepo(opts, ({ repo, db }) => {
          const session = repo.requireSession(hitchId);
          const findings = repo.listFindings({ hitchId, limit: 10_000 });
          const decisions = repo.listDecisions(hitchId);
          const lifecycleEvents = repo.listLifecycleEvents(hitchId);
          const closeChecks = repo.listCloseChecks(hitchId);
          const convergence = new ConvergenceService(repo).evaluate(hitchId);
          const tokenUsage = hitchTokenUsage(db, hitchId);
          return {
            session,
            findings,
            decisions,
            lifecycleEvents,
            closeChecks,
            convergence,
            tokenUsage,
          };
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatHitchStatusLine(result)}\n`);
        }
      });
    });

  hitchCmd
    .command("close")
    .description("close a hitch after convergence says close_ready")
    .argument("<hitch-id>", "hitch id")
    .requiredOption("--summary <text>", "close summary")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--force", "close even when convergence is not close_ready", false)
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const result = withHitchRepo(opts, ({ repo }) => {
          const convergence = new ConvergenceService(repo).evaluate(hitchId);
          if (convergence.decision !== "close_ready" && raw.force !== true) {
            throw new HitchCliError(
              `hitch ${hitchId} is not close_ready (decision=${convergence.decision}); use --force to override`,
            );
          }
          return repo.updateStatus(hitchId, "closed", String(raw.summary), {
            createdBy: String(raw.createdBy),
          });
        });
        writeOutput(raw, result, `hitch=${result.hitchId} status=${result.status}\n`);
      });
    });

  hitchCmd
    .command("cancel")
    .description("cancel a hitch")
    .argument("<hitch-id>", "hitch id")
    .requiredOption("--reason <text>", "cancel reason")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const result = withHitchRepo(opts, ({ repo }) =>
          repo.updateStatus(hitchId, "cancelled", String(raw.reason), {
            createdBy: String(raw.createdBy),
          }),
        );
        writeOutput(raw, result, `hitch=${result.hitchId} status=${result.status}\n`);
      });
    });

  hitchCmd
    .command("reopen")
    .description(
      "reopen a terminal hitch (closed/budget_exhausted/escalated) to fix a late " +
        "finding on the existing branch instead of re-implementing (#76)",
    )
    .argument("<hitch-id>", "hitch id")
    .requiredOption("--reason <text>", "reopen reason")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--extend-iterations <n>", "extend the iteration budget", "3")
    .option("--extend-review-cycles <n>", "extend the review-cycle budget", "3")
    .option("--extend-reruns <n>", "extend the rerun budget", "2")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const result = withHitchRepo(opts, ({ repo }) =>
          repo.reopenSession(hitchId, {
            reason: String(raw.reason),
            createdBy: String(raw.createdBy),
            extendIterations: parseNonNegativeInt(
              raw.extendIterations,
              "--extend-iterations",
            ),
            extendReviewCycles: parseNonNegativeInt(
              raw.extendReviewCycles,
              "--extend-review-cycles",
            ),
            extendReruns: parseNonNegativeInt(
              raw.extendReruns,
              "--extend-reruns",
            ),
          }),
        );
        writeOutput(
          raw,
          result,
          `hitch=${result.hitchId} status=${result.status} reopened ` +
            `(budget: iter=${result.maxIterations} review=${result.maxReviewCycles} ` +
            `rerun=${result.maxReruns}; reason: ${String(raw.reason)})\n`,
        );
      });
    });

  hitchCmd
    .command("adopt-pr")
    .description("record an operator-adopted PR for hitch status/audit only")
    .argument("<hitch-id>", "hitch id")
    .argument("<pr-url-or-number>", "adopted PR URL or number")
    .requiredOption("--reason <text>", "adoption reason")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, prArg: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const pr = parsePrReference(prArg);
        const result = withHitchRepo(opts, ({ repo }) =>
          repo.adoptPr({
            hitchId,
            ...pr,
            reason: String(raw.reason),
            createdBy: String(raw.createdBy),
          }),
        );
        writeOutput(
          raw,
          result,
          `hitch=${result.hitchId} adoptedPr=${formatPrReference(pr)} status=${result.status}\n`,
        );
      });
    });

  hitchCmd
    .command("update")
    .description("update a live hitch's scope, close conditions, or policy")
    .argument("<hitch-id>", "hitch id")
    .option("--close-file <path>", "YAML/JSON close conditions file")
    .option("--scope-file <path>", "YAML/JSON hitch scope file")
    .option("--policy-file <path>", "YAML/JSON hitch policy file")
    .requiredOption("--reason <text>", "update reason")
    .option("--allow-scope-widen", "permit scope-widening changes", false)
    .option("--allow-gate-loosen", "permit close-gate loosening changes", false)
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        if (
          raw.closeFile === undefined &&
          raw.scopeFile === undefined &&
          raw.policyFile === undefined
        ) {
          throw new HitchCliError(
            "hitch update requires at least one of --close-file, --scope-file, or --policy-file",
          );
        }
        const result = withHitchRepo(opts, ({ repo }) =>
          repo.updateSessionConfig({
            hitchId,
            ...(raw.scopeFile !== undefined
              ? { scope: parseHitchScope(readStructuredFile(String(raw.scopeFile))) }
              : {}),
            ...(raw.closeFile !== undefined
              ? {
                  closeConditions: parseHitchCloseConditions(
                    readStructuredFile(String(raw.closeFile)),
                  ),
                }
              : {}),
            ...(raw.policyFile !== undefined
              ? { policy: parseHitchPolicy(readStructuredFile(String(raw.policyFile))) }
              : {}),
            reason: String(raw.reason),
            allowScopeWiden: raw.allowScopeWiden === true,
            allowGateLoosen: raw.allowGateLoosen === true,
            createdBy: String(raw.createdBy),
          }),
        );
        writeOutput(
          raw,
          result,
          `hitch=${result.hitchId} status=${result.status} updated\n`,
        );
      });
    });

  const attemptCmd = hitchCmd.command("attempt").description("hitch attempts");
  attemptCmd
    .command("start")
    .description("start a hitch attempt")
    .argument("<hitch-id>", "hitch id")
    .requiredOption("--type <type>", "attempt type")
    .option("--iteration <n>", "explicit iteration")
    .option("--operation-id <id>", "operation id")
    .option("--run-id <id>", "run id")
    .option("--parent-attempt-id <id>", "parent attempt id")
    .option("--input-json <json>", "input JSON object")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const attempt = withHitchRepo(opts, ({ repo }) =>
          repo.createAttempt({
            hitchId,
            attemptType: parseChoice(
              raw.type,
              HITCH_ATTEMPT_TYPES,
              "--type",
            ) as HitchAttemptType,
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
          `attempt=${attempt.attemptId} hitch=${attempt.hitchId} status=${attempt.status}\n`,
        );
      });
    });

  attemptCmd
    .command("complete")
    .description("complete a hitch attempt")
    .argument("<attempt-id>", "attempt id")
    .requiredOption("--status <status>", "succeeded | failed | cancelled")
    .option("--operation-id <id>", "operation id")
    .option("--run-id <id>", "run id")
    .option("--result-json <json>", "result JSON object")
    .option("--error <text>", "error message")
    .option("--json", "emit JSON", false)
    .action((attemptId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const status = parseChoice(
          raw.status,
          ["succeeded", "failed", "cancelled"],
          "--status",
        ) as Exclude<HitchAttemptStatus, "pending" | "running">;
        const attempt = withHitchRepo(opts, ({ repo }) =>
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

  const findingCmd = hitchCmd.command("finding").description("hitch findings");
  findingCmd
    .command("list")
    .description("list findings for a hitch")
    .argument("<hitch-id>", "hitch id")
    .option("--open", "only open, reopened, or escalated findings", false)
    .option("--severity <severity>", "P0 | P1 | P2 | P3 | info")
    .option("--scope <scope>", "in-scope | out-of-scope | unknown | duplicate")
    .option("--limit <n>", "max rows")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const findings = withHitchRepo(opts, ({ repo }) => {
          repo.requireSession(hitchId);
          return repo.listFindings({
            hitchId,
            ...(raw.open === true
              ? { lifecycleStatusIn: OPEN_FINDING_LIFECYCLES }
              : {}),
            ...(raw.severity !== undefined
              ? {
                  severity: parseChoice(
                    raw.severity,
                    HITCH_FINDING_SEVERITIES,
                    "--severity",
                  ) as HitchFindingSeverity,
                }
              : {}),
            ...(raw.scope !== undefined ? { scopeStatus: parseScope(raw.scope) } : {}),
            limit:
              raw.limit === undefined
                ? 10_000
                : parsePositiveInt(raw.limit, "--limit"),
          });
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
        } else {
          process.stdout.write(formatHitchFindingList(findings));
        }
      });
    });

  findingCmd
    .command("add")
    .description("record a finding")
    .argument("<hitch-id>", "hitch id")
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
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const result = withHitchRepo(opts, ({ repo }) => {
          const session = repo.requireSession(hitchId);
          const source = parseChoice(
            raw.source,
            HITCH_FINDING_SOURCES,
            "--source",
          ) as HitchFindingSource;
          const findingForClassification: ClassifiableHitchFinding = {
            source,
            severity: parseChoice(
              raw.severity,
              HITCH_FINDING_SEVERITIES,
              "--severity",
            ) as HitchFindingSeverity,
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
              ? classifyFindingForHitch(session, findingForClassification)
              : {
                  scopeStatus: parseScope(raw.scope),
                  reason: "manual scope supplied by CLI",
                };
          const input: UpsertHitchFindingInput = {
            hitchId,
            source,
            severity: findingForClassification.severity as HitchFindingSeverity,
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
    .option(
      "--then-rerun",
      "after classifying, auto-run the orchestrator IFF the hitch is now needs_fix (chains a coder rerun to address the newly in-scope finding); requires --repo",
      false,
    )
    .option("--repo <path>", "target git repo (required with --then-rerun)")
    .option(
      "--base-branch <name>",
      "base branch for the rerun (overrides the project profile base branch; default: profile base branch, else main)",
    )
    .option("--max-steps <n>", "orchestrator step cap for the chained rerun", "20")
    .option("--json", "emit JSON", false)
    .action(async (findingId: string, raw: Record<string, unknown>) => {
      await withHitchErrorExitAsync(async () => {
        const thenRerun = raw.thenRerun === true;
        const classifyInput = {
          findingId,
          scopeStatus: parseScope(raw.scope),
          reason: String(raw.reason),
          ...(raw.duplicateOf !== undefined
            ? { duplicateOf: String(raw.duplicateOf) }
            : {}),
        };

        // Default (no --then-rerun): classify only, original output unchanged.
        if (!thenRerun) {
          const finding = withHitchRepo(opts, ({ repo }) =>
            repo.classifyFinding(classifyInput),
          );
          writeOutput(
            raw,
            finding,
            `finding=${finding.findingId} scope=${finding.scopeStatus} lifecycle=${finding.lifecycleStatus}\n`,
          );
          return;
        }

        // --then-rerun: classify (the operator-owned, human-in-the-loop
        // boundary), then re-evaluate + record convergence — like the MCP
        // classify tool — so the chain decision reads a fresh decision.
        const { finding, decision } = withHitchRepo(opts, ({ repo }) => {
          const f = repo.classifyFinding(classifyInput);
          const conv = evaluateConvergenceAndRecordStatus({
            repository: repo,
            hitchId: f.hitchId,
            createdBy: "cli",
          });
          return { finding: f, decision: conv.decision };
        });

        const chain = classifyChainDecision(thenRerun, decision);
        if (!chain.chain) {
          writeOutput(
            raw,
            { ...finding, decision, chained: false, skipReason: chain.reason },
            `finding=${finding.findingId} scope=${finding.scopeStatus} ` +
              `lifecycle=${finding.lifecycleStatus} decision=${decision} ` +
              `rerun=skipped(${chain.reason})\n`,
          );
          return;
        }

        // chain a coder rerun via the orchestrator (deterministic + gated): the
        // operator's classification is the trigger, convergence drives the step.
        if (typeof raw.repo !== "string" || raw.repo === "") {
          throw new HitchCliError(
            "hitch finding classify --then-rerun requires --repo <path>",
          );
        }
        const dbPath = harnessPaths(opts.getHarnessRoot()).dbPath;
        const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
        const repoPath = String(raw.repo);
        const runnerDeps = await resolveHitchCoderRunnerDeps({
          harnessRoot: opts.getHarnessRoot(),
          dbPath,
          hitchId: finding.hitchId,
          repoPath,
          ...(raw.baseBranch !== undefined
            ? { baseBranch: String(raw.baseBranch) }
            : {}),
        });
        // #236 — surface the effective run base (CLI override vs profile/default)
        // so an implicit override is never silent.
        process.stderr.write(
          `hitch ${finding.hitchId}: using base branch ${runnerDeps.baseBranch}\n`,
        );
        const result = await new HitchOrchestrator({ dbPath }).run({
          hitchId: finding.hitchId,
          runners: createOrchestratorRunners({
            dbPath,
            harnessRoot: opts.getHarnessRoot(),
            createdBy: "cli",
            coderRunner: createCodexCliRunner({ codexBin, sandbox: "workspace-write" }),
            coderCodexBinaryVersion: codexBinaryVersion(codexBin),
            reviewerRunner: createCodexCliRunner({ codexBin, sandbox: "read-only" }),
            // no publisher: --then-rerun reruns the coder and halts at
            // close_ready; it never opens a PR (stopAtCloseReady below).
            ...runnerDeps,
          }),
          maxSteps: parsePositiveInt(raw.maxSteps ?? 20, "--max-steps"),
          createdBy: "cli",
          // halt before close/PR: a coder rerun must not silently open a PR /
          // close the hitch — that stays a deliberate `orchestrate` / `await-merge`.
          stopAtCloseReady: true,
        });
        writeOutput(
          raw,
          { ...finding, decision, chained: true, orchestration: result },
          `finding=${finding.findingId} scope=${finding.scopeStatus} ` +
            `lifecycle=${finding.lifecycleStatus} decision=${decision} ` +
            `rerun=chained outcome=${result.outcome}\n`,
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
      withHitchErrorExit(() => {
        const finding = withHitchRepo(opts, ({ repo }) =>
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
    .option(
      "--classify-out-of-scope",
      "classify the finding out of scope before deferring it",
      false,
    )
    .requiredOption("--reason <text>", "deferral reason")
    .option("--json", "emit JSON", false)
    .action(async (findingId: string, raw: Record<string, unknown>) => {
      await withHitchErrorExitAsync(async () => {
        const result = await withHitchRepoAsync(opts, async (ctx) =>
          deferFindingToBacklog({
            repository: ctx.repo,
            findingId,
            reason: String(raw.reason),
            createBacklogItem: raw.backlog === true,
            classifyOutOfScope: raw.classifyOutOfScope === true,
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
        warnBacklogExport(result.exportWarning);
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

  const cycleCmd = hitchCmd
    .command("review-cycle")
    .description("hitch review cycles");
  cycleCmd
    .command("start")
    .description("start a review cycle")
    .argument("<hitch-id>", "hitch id")
    .requiredOption("--mode <mode>", "initial | delta | close | regression | manual")
    .option("--trigger-attempt-id <id>", "trigger attempt id")
    .option("--source-review-id <id>", "source review id")
    .option("--source-run-id <id>", "source run id")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const cycle = withHitchRepo(opts, ({ repo }) =>
          repo.startReviewCycle({
            hitchId,
            reviewMode: parseChoice(
              raw.mode,
              HITCH_REVIEW_MODES,
              "--mode",
            ) as HitchReviewMode,
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
      withHitchErrorExit(() => {
        const fileInput =
          raw.fromFindings === undefined
            ? {}
            : parseCycleCounts(readStructuredFile(String(raw.fromFindings)));
        const cycle = withHitchRepo(opts, ({ repo }) =>
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

  const closeCheckCmd = hitchCmd
    .command("close-check")
    .description("hitch close checks");
  closeCheckCmd
    .command("record")
    .description("record close-check evidence")
    .argument("<hitch-id>", "hitch id")
    .requiredOption("--condition <id>", "close condition id")
    .requiredOption("--status <status>", "pending | passed | failed | skipped | unknown")
    .option("--checked-by <actor>", "actor label", "cli")
    .option("--message <text>", "message")
    .option("--evidence-json <json>", "evidence JSON object")
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const check = withHitchRepo(opts, ({ repo }) =>
          repo.recordCloseCheck({
            hitchId,
            conditionId: String(raw.condition),
            status: parseChoice(
              raw.status,
              HITCH_CLOSE_CHECK_STATUSES,
              "--status",
            ) as HitchCloseCheckStatus,
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
            coderRunner: createCodexCliRunner({ codexBin, sandbox: "workspace-write" }),
            coderCodexBinaryVersion: codexBinaryVersion(codexBin),
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
            coderRunner: createCodexCliRunner({ codexBin, sandbox: "workspace-write" }),
            coderCodexBinaryVersion: codexBinaryVersion(codexBin),
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

export function formatHitchOrchestrateResultLine(
  hitchId: string,
  result: HitchOrchestrationResult,
  link: { linked: boolean; agent?: string },
): string {
  return (
    `hitch=${hitchId} outcome=${result.outcome}` +
    (result.draft !== undefined ? ` draft=${result.draft}` : "") +
    (result.prUrl !== undefined ? ` pr=${result.prUrl}` : "") +
    (result.escalateReason !== undefined
      ? ` escalate=${result.escalateReason}`
      : "") +
    (link.linked ? ` workspace=${link.agent}` : "")
  );
}

export function formatHitchStatusLine(result: {
  session: {
    hitchId: string;
    status: string;
    closeConditions: Array<{ id: string; kind: string; required: boolean }>;
  };
  convergence: {
    decision: string;
    metrics: { openInScopeP1: number; openUnknownScope: number };
  };
  closeChecks: Array<{
    conditionId: string;
    status: string;
    checkedAt?: string;
    evidence?: Record<string, unknown>;
  }>;
  lifecycleEvents?: Array<{
    event: string;
    createdAt?: string;
    detail?: Record<string, unknown> | null;
  }>;
  tokenUsage?: DbHitchTokenUsage;
}): string {
  const reviewAdvisoryCount = countReviewConsensusAdvisories(result);
  const staticConsensus = hasPassedReviewConsensusCheck(result)
    ? " review_consensus=static_pass tests=not_run_by_consensus"
    : "";
  const advisories =
    reviewAdvisoryCount > 0 ? ` review_advisories=${reviewAdvisoryCount}` : "";
  const adoptedPr = latestAdoptedPrEvent(result.lifecycleEvents ?? []);
  const adoptedPrText =
    adoptedPr === null ? "" : formatAdoptedPrStatusFields(adoptedPr.detail);
  const statusLine =
    `hitch=${result.session.hitchId} status=${result.session.status} ` +
    `decision=${result.convergence.decision} ` +
    `openP1=${result.convergence.metrics.openInScopeP1} ` +
    `unknown=${result.convergence.metrics.openUnknownScope}` +
    adoptedPrText +
    staticConsensus +
    advisories;
  return statusLine + formatHitchTokenUsageLine(result.tokenUsage);
}

/**
 * Render the per-hitch token usage as a second status line (retry-inclusive
 * sum over the hitch's attempts, with the coder/reviewer/evaluator split).
 * Empty string when no usage telemetry is present so older hitches stay quiet.
 */
function formatHitchTokenUsageLine(usage?: DbHitchTokenUsage): string {
  if (usage === undefined || usage.runsWithUsage === 0) return "";
  const k = usage.byKind;
  return (
    `\ntokens total=${usage.totalTokens} ` +
    `(in=${usage.inputTokens} cached=${usage.cachedInputTokens} ` +
    `out=${usage.outputTokens} reasoning=${usage.reasoningOutputTokens}) ` +
    `runsWithUsage=${usage.runsWithUsage} ` +
    `byKind[coder=${k.coder.totalTokens} reviewer=${k.reviewer.totalTokens} ` +
    `evaluator=${k.evaluator.totalTokens}]`
  );
}

export function formatHitchFindingList(findings: HitchFinding[]): string {
  if (findings.length === 0) return "";
  return (
    findings
      .map((finding) =>
        [
          finding.findingId,
          finding.severity,
          finding.lifecycleStatus,
          finding.scopeStatus,
          finding.category,
          finding.summary,
        ].join("\t"),
      )
      .join("\n") + "\n"
  );
}

function hasPassedReviewConsensusCheck(result: {
  session: { closeConditions: Array<{ id: string; kind: string }> };
  closeChecks: Array<{ conditionId: string; status: string; checkedAt?: string }>;
}): boolean {
  const reviewConditionIds = new Set(
    result.session.closeConditions
      .filter((condition) => condition.kind === "review_consensus")
      .map((condition) => condition.id),
  );
  for (const conditionId of reviewConditionIds) {
    const latest = latestCloseCheck(result.closeChecks, conditionId);
    if (latest?.status === "passed") return true;
  }
  return false;
}

function latestAdoptedPrEvent(
  events: Array<{
    event: string;
    createdAt?: string;
    detail?: Record<string, unknown> | null;
  }>,
): { detail: Record<string, unknown> | null } | null {
  let latest: { createdAt: string; detail: Record<string, unknown> | null } | null =
    null;
  for (const event of events) {
    if (event.event !== "pr_adopted") continue;
    const normalized = {
      createdAt: event.createdAt ?? "",
      detail: event.detail ?? null,
    };
    if (latest === null || normalized.createdAt >= latest.createdAt) {
      latest = normalized;
    }
  }
  return latest === null ? null : { detail: latest.detail };
}

function formatAdoptedPrStatusFields(
  detail: Record<string, unknown> | null,
): string {
  const adopted = readPrRef(detail, "adoptedPr");
  const superseded = readPrRef(detail, "supersededPr");
  const adoptedText = adopted === null ? null : formatPrReference(adopted);
  const supersededText =
    superseded === null ? null : formatPrReference(superseded);
  return (
    (adoptedText === null ? "" : ` pr=${adoptedText}`) +
    (supersededText === null ? "" : ` supersededPr=${supersededText}`)
  );
}

function readPrRef(
  detail: Record<string, unknown> | null,
  key: string,
): { prUrl?: string | null; prNumber?: number | null } | null {
  if (detail === null) return null;
  const value = detail[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : null;
  const number = typeof record.number === "number" ? record.number : null;
  if (url === null && number === null) return null;
  return { prUrl: url, prNumber: number };
}

function countReviewConsensusAdvisories(result: {
  session: { closeConditions: Array<{ id: string; kind: string }> };
  closeChecks: Array<{
    conditionId: string;
    status: string;
    checkedAt?: string;
    evidence?: Record<string, unknown>;
  }>;
}): number {
  const reviewConditionIds = new Set(
    result.session.closeConditions
      .filter((condition) => condition.kind === "review_consensus")
      .map((condition) => condition.id),
  );
  let count = 0;
  for (const conditionId of reviewConditionIds) {
    const latest = latestCloseCheck(result.closeChecks, conditionId);
    const advisories = latest?.evidence?.reviewerAdvisories;
    if (Array.isArray(advisories)) count += advisories.length;
  }
  return count;
}

function latestCloseCheck(
  checks: Array<{
    conditionId: string;
    status: string;
    checkedAt?: string;
    evidence?: Record<string, unknown>;
  }>,
  conditionId: string,
): {
  conditionId: string;
  status: string;
  checkedAt?: string;
  evidence?: Record<string, unknown>;
} | null {
  return checks
    .filter((check) => check.conditionId === conditionId)
    .reduce<{
      conditionId: string;
      status: string;
      checkedAt?: string;
      evidence?: Record<string, unknown>;
    } | null>(
      (latest, check) => {
        if (latest === null) return check;
        if ((check.checkedAt ?? "") >= (latest.checkedAt ?? "")) return check;
        return latest;
      },
      null,
    );
}

/**
 * Early schema-version-skew preflight for `hitch orchestrate` (#271). Opens a
 * read-only handle (shared lock — non-contending), reads the on-disk schema
 * version WITHOUT migrating, and throws a friendly, actionable `DbError`
 * (mapped to exit 1 by the hitch CLI error mapper) BEFORE any deep work when
 * the DB is newer than this harness. The `runMigrations` guard inside
 * `withHitchRepo*` remains the fail-closed backstop.
 */
function assertHitchOrchestrateSchemaCompatible(
  opts: RegisterHitchCommandsOptions,
): void {
  const paths = harnessPaths(opts.getHarnessRoot());
  // A fresh/uninitialized harness root has no DB to be skewed against — skip the
  // read-only preflight and let the normal create+migrate path run (with the
  // runMigrations backstop). The read-only handle below requires the file to
  // exist (fileMustExist), so opening it on a fresh root would throw.
  if (!existsSync(paths.dbPath)) return;
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  try {
    const dbVersion = readSchemaVersion(handle.db);
    const compat = evaluateSchemaCompatibility(dbVersion);
    if (compat.kind === "db-newer-than-harness") {
      throw new DbError(compat.message);
    }
  } finally {
    handle.close();
  }
}

function withHitchRepo<T>(
  opts: RegisterHitchCommandsOptions,
  fn: (ctx: HitchContext) => T,
): T {
  const root = opts.getHarnessRoot();
  const paths = harnessPaths(root);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    return fn({ root, paths, repo: new HitchRepository(handle.db), db: handle.db });
  } finally {
    handle.close();
  }
}

async function withHitchRepoAsync<T>(
  opts: RegisterHitchCommandsOptions,
  fn: (ctx: HitchContext) => Promise<T>,
): Promise<T> {
  const root = opts.getHarnessRoot();
  const paths = harnessPaths(root);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    return await fn({
      root,
      paths,
      repo: new HitchRepository(handle.db),
      db: handle.db,
    });
  } finally {
    handle.close();
  }
}

function withHitchErrorExit(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    hitchError(e);
  }
}

async function withHitchErrorExitAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    hitchError(e);
  }
}

function hitchError(e: unknown): never {
  const mapped = mapHitchErrorExit(e);
  if (mapped !== null) {
    process.stderr.write(`harness error: ${mapped.message}\n`);
    process.exit(mapped.code);
  }
  throw e;
}

export function mapHitchErrorExit(
  e: unknown,
): { code: 1; message: string } | null {
  const lease = findTransientLeaseCause(e);
  if (lease !== undefined) {
    return {
      code: 1,
      message: `hitch deferred/lock_busy (${lease.name}): ${lease.message}`,
    };
  }
  if (
    e instanceof HitchCliError ||
    e instanceof DbError ||
    e instanceof BacklogError ||
    e instanceof HitchValidationError
  ) {
    return { code: 1, message: e.message };
  }
  return null;
}

class HitchCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HitchCliError";
  }
}

function writeOutput(raw: Record<string, unknown>, value: unknown, text: string): void {
  process.stdout.write(raw.json === true ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function warnBacklogExport(exportWarning: string | undefined): void {
  if (exportWarning !== undefined) {
    process.stderr.write(`warning: ${exportWarning}\n`);
  }
}

function writeConvergence(
  raw: Record<string, unknown>,
  value: HitchConvergenceResult & { decisionRecord: unknown },
): void {
  if (raw.json === true) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `hitch=${value.hitchId} decision=${value.decision} reason=${value.reason}\n`,
  );
}

function parsePrReference(text: string): {
  prUrl?: string | null;
  prNumber?: number | null;
} {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new HitchCliError("<pr-url-or-number> must not be empty");
  }
  if (/^\d+$/.test(trimmed)) {
    return { prNumber: Number(trimmed) };
  }
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(trimmed);
  return {
    prUrl: trimmed,
    ...(match?.[1] !== undefined ? { prNumber: Number(match[1]) } : {}),
  };
}

function formatPrReference(input: {
  prUrl?: string | null;
  prNumber?: number | null;
}): string {
  if (input.prUrl !== undefined && input.prUrl !== null) return input.prUrl;
  if (input.prNumber !== undefined && input.prNumber !== null) {
    return `#${input.prNumber}`;
  }
  return "-";
}

function readStructuredFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(text) as unknown;
  return parseYaml(text) as unknown;
}

function parseJsonRecord(text: string, flag: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HitchCliError(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseScope(value: unknown): HitchScopeStatus {
  const normalized = String(value).replace(/-/g, "_");
  return parseChoice(normalized, HITCH_SCOPE_STATUSES, "--scope") as HitchScopeStatus;
}

function parseChoice<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  flag: string,
): T[number] {
  const str = String(value);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new HitchCliError(
      `${flag} must be one of ${allowed.join("|")} (got ${JSON.stringify(str)})`,
    );
  }
  return str as T[number];
}

function parsePositiveInt(value: unknown, flag: string): number {
  const parsed = parseNonNegativeInt(value, flag);
  if (parsed < 1) throw new HitchCliError(`${flag} must be a positive integer`);
  return parsed;
}

function parseMergeMethod(value: unknown): PrMergeMethod {
  if (value === "squash" || value === "merge" || value === "rebase") {
    return value;
  }
  throw new HitchCliError("--merge-method must be one of: squash, merge, rebase");
}

function parseNonNegativeInt(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new HitchCliError(`${flag} must be a non-negative integer`);
  }
  return n;
}

function countOption(
  raw: Record<string, unknown>,
  key: keyof CompleteHitchReviewCycleInput,
  flag: string,
): Partial<CompleteHitchReviewCycleInput> {
  const value = raw[key];
  return value === undefined ? {} : { [key]: parseNonNegativeInt(value, flag) };
}

function parseCycleCounts(value: unknown): Partial<CompleteHitchReviewCycleInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HitchCliError("--from-findings must contain an object");
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
  key: keyof CompleteHitchReviewCycleInput,
): Partial<CompleteHitchReviewCycleInput> {
  return raw[key] === undefined
    ? {}
    : { [key]: parseNonNegativeInt(raw[key], key) };
}
