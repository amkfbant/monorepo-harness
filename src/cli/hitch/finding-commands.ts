import process from "node:process";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { classifyFindingForHitch, type ClassifiableHitchFinding } from "../../hitch/classification.js";
import { createCodexCliRunner } from "../../codex/codex-cli-runner.js";
import { coderRunnerDeps } from "../../core/agent-runner.js";
import { codexBinaryVersion } from "../../codex/codex-version.js";
import { evaluateConvergenceAndRecordStatus } from "../../hitch/convergence-status.js";
import { deferFindingToBacklog } from "../../hitch/followups.js";
import { HitchOrchestrator } from "../../hitch/orchestrator.js";
import { classifyChainDecision } from "../../hitch/classify-rerun.js";
import { createOrchestratorRunners } from "../../hitch/orchestrator-runners.js";
import { OPEN_FINDING_LIFECYCLES, type UpsertHitchFindingInput } from "../../hitch/repository.js";
import { HITCH_FINDING_SEVERITIES, HITCH_FINDING_SOURCES, type HitchFindingSeverity, type HitchFindingSource } from "../../hitch/types.js";
import { formatHitchFindingList, HitchCliError, parseChoice, parsePositiveInt, parseScope, type RegisterHitchCommandsOptions, resolveHitchCoderRunnerDeps, warnBacklogExport, withHitchErrorExit, withHitchErrorExitAsync, withHitchRepo, withHitchRepoAsync, writeOutput } from "./helpers.js";

/**
 * `harness hitch` finding (list/add/classify/fixed/defer)（#125 A15: cli/hitch.ts から behaviour-zero 分割）。
 * registration 順は golden で凍結。共有 helper は ./helpers から。
 */
export function registerHitchFindingCommands(
  hitchCmd: Command,
  opts: RegisterHitchCommandsOptions,
): void {
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
            ...coderRunnerDeps(codexBin),
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

}
