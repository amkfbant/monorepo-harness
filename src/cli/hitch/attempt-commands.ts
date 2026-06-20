import type { Command } from "commander";
import { HITCH_ATTEMPT_TYPES, type HitchAttemptStatus, type HitchAttemptType } from "../../hitch/types.js";
import { parseChoice, parseJsonRecord, parsePositiveInt, type RegisterHitchCommandsOptions, withHitchErrorExit, withHitchRepo, writeOutput } from "./helpers.js";

/**
 * `harness hitch` attempt (start/complete)（#125 A15: cli/hitch.ts から behaviour-zero 分割）。
 * registration 順は golden で凍結。共有 helper は ./helpers から。
 */
export function registerHitchAttemptCommands(
  hitchCmd: Command,
  opts: RegisterHitchCommandsOptions,
): void {
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

}
