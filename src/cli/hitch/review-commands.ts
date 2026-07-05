import type { Command } from "commander";
import { HITCH_CLOSE_CHECK_STATUSES, HITCH_REVIEW_MODES, type HitchCloseCheckStatus, type HitchReviewMode } from "../../hitch/types.js";
import { countOption, parseChoice, parseCycleCounts, parseJsonRecord, readStructuredFile, type RegisterHitchCommandsOptions, withHitchErrorExit, withHitchRepo, writeOutput } from "./helpers.js";

/**
 * `harness hitch` review-cycle + close-check（#125 A15: cli/hitch.ts から behaviour-zero 分割）。
 * registration 順は golden で凍結。共有 helper は ./helpers から。
 */
export function registerHitchReviewCommands(
  hitchCmd: Command,
  opts: RegisterHitchCommandsOptions,
): void {
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
    .description("record manually recordable close-check evidence")
    .argument("<hitch-id>", "hitch id")
    .requiredOption(
      "--condition <id>",
      "close condition id (manual record rejects evaluator-only kinds)",
    )
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

}
