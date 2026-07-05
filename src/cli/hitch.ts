import type { Command } from "commander";
import type { RegisterHitchCommandsOptions } from "./hitch/helpers.js";
import { registerHitchLifecycleCommands } from "./hitch/lifecycle-commands.js";
import { registerHitchAttemptCommands } from "./hitch/attempt-commands.js";
import { registerHitchFindingCommands } from "./hitch/finding-commands.js";
import { registerHitchReviewCommands } from "./hitch/review-commands.js";
import { registerHitchConvergenceCommands } from "./hitch/convergence-commands.js";
import { registerHitchSummaryCommands } from "./hitch/summary-commands.js";
import { registerHitchEvidenceCommands } from "./hitch/evidence-commands.js";

// Public surface kept import-compatible across the #125 A15 split: tests import
// these helpers from "src/cli/hitch.js" (hitch-await-merge-cli / hitch-base-branch-
// override / hitch-cli / cli-format), so re-export them from here.
export {
  resolveHitchCloseRunnerDeps,
  resolveHitchCoderRunnerDeps,
  mapHitchErrorExit,
  formatHitchStatusLine,
  formatHitchFindingList,
} from "./hitch/helpers.js";
export {
  formatHitchOrchestrateProgressLine,
  formatHitchOrchestrateResultLine,
} from "./hitch/orchestrate-format.js";
export type { RegisterHitchCommandsOptions } from "./hitch/helpers.js";

/**
 * `harness hitch` の registrar。#125 A15: per-concern サブモジュール（src/cli/hitch/*）
 * へ behaviour-zero 分割した薄い orchestrator。command 群を 7 sub-registrar
 * （lifecycle / attempt / finding / review / convergence / summary / evidence）へ
 * 登録順どおりに委譲し、共有 helper は hitch/helpers.ts に集約（HitchContext⇔
 * HitchCliError の相互参照ゆえ 1 モジュール）。registration 順 = commander help
 * 列挙順 = golden 凍結。`summary`（#84）は read-only reporter ゆえ末尾近くに登録。
 * `evidence`（#91）は operator attesting surface ゆえ最後に登録。
 */
export function registerHitchCommands(
  program: Command,
  opts: RegisterHitchCommandsOptions,
): void {
  const hitchCmd = program
    .command("hitch")
    .description("hitch convergence controller");

  registerHitchLifecycleCommands(hitchCmd, opts);
  registerHitchAttemptCommands(hitchCmd, opts);
  registerHitchFindingCommands(hitchCmd, opts);
  registerHitchReviewCommands(hitchCmd, opts);
  registerHitchConvergenceCommands(hitchCmd, opts);
  registerHitchSummaryCommands(hitchCmd, opts);
  registerHitchEvidenceCommands(hitchCmd, opts);
}
