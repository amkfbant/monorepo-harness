import process from "node:process";
import type { Command } from "commander";
import { hitchTokenUsage } from "../../db/repositories/aggregates.js";
import { ConvergenceService } from "../../hitch/convergence.js";
import { parseHitchCloseConditions, parseHitchPolicy, parseHitchScope } from "../../hitch/schemas.js";
import { HITCH_STATUSES } from "../../hitch/types.js";
import { assertRecoverDivergingGate, formatHitchStatusLine, formatPrReference, HitchCliError, parseChoice, parseNonNegativeInt, parsePositiveInt, parsePrReference, readStructuredFile, type RegisterHitchCommandsOptions, withHitchErrorExit, withHitchRepo, writeOutput } from "./helpers.js";

/**
 * `harness hitch` lifecycle (start/list/status/close/cancel/reopen/recover-diverging/adopt-pr/update)（#125 A15: cli/hitch.ts から behaviour-zero 分割）。
 * registration 順は golden で凍結。共有 helper は ./helpers から。
 */
export function registerHitchLifecycleCommands(
  hitchCmd: Command,
  opts: RegisterHitchCommandsOptions,
): void {
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
          const evidence = repo.listEvidence(hitchId);
          return {
            session,
            findings,
            decisions,
            lifecycleEvents,
            closeChecks,
            convergence,
            tokenUsage,
            evidence,
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
    .command("recover-diverging")
    .description(
      "sanctioned recovery for a cumulatively-diverging hitch (#280): return it " +
        "to live `open` and extend the divergence budget, GATED deterministically " +
        "on open in-scope P0/P1==0 + all required close-checks green + a " +
        "session-budget trigger. NOT a gate-skip (fail-closed; refuses otherwise)",
    )
    .argument("<hitch-id>", "hitch id")
    .requiredOption("--reason <text>", "recovery reason (audited)")
    .option("--created-by <actor>", "actor label", "cli")
    .option(
      "--extend-divergence-budget <n>",
      "amount added to max_total_new_findings (default: minimal extension that " +
        "lifts the cumulative count above the budget)",
    )
    .option("--json", "emit JSON", false)
    .action((hitchId: string, raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const extendOverride =
          raw.extendDivergenceBudget !== undefined
            ? parseNonNegativeInt(
                raw.extendDivergenceBudget,
                "--extend-divergence-budget",
              )
            : undefined;
        const result = withHitchRepo(opts, ({ repo }) => {
          // Pre-check: surface a clean message/exit and compute the extension
          // BEFORE opening the write transaction. The SAME gate is re-run inside
          // the repo transaction via `revalidate` (P2#2) against fresh DB state.
          const { extend } = assertRecoverDivergingGate(
            repo,
            hitchId,
            extendOverride,
          );
          return repo.recoverDivergingSession(hitchId, {
            reason: String(raw.reason),
            createdBy: String(raw.createdBy),
            extendDivergenceBudget: extend,
            // P2#2 — re-derive the deterministic gate from fresh state inside the
            // transaction; throws fail-closed on any concurrent drift. The fixed
            // `extend` (from the pre-check) is re-proven against fresh metrics.
            revalidate: (txRepo) => {
              assertRecoverDivergingGate(txRepo, hitchId, extend);
            },
          });
        });
        writeOutput(
          raw,
          result,
          `hitch=${result.hitchId} status=${result.status} recovered ` +
            `(divergence budget: ${result.maxTotalNewFindings}; reason: ` +
            `${String(raw.reason)})\n`,
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

}
