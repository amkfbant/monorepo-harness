import type { Command } from "commander";
import type { RegisterCourseCommandsOptions } from "./course/helpers.js";
import { registerCourseSubcommands } from "./course/course-commands.js";
import { registerPhaseSubcommands } from "./course/phase-commands.js";

// noteForMarkdownLine is part of the public surface (tests/unit/cli/course-note
// imports it from here); re-export so the #125 A15 split stays import-compatible.
export { noteForMarkdownLine } from "./course/helpers.js";
export type { RegisterCourseCommandsOptions } from "./course/helpers.js";

/**
 * `harness course` / `harness phase` の registrar。#125 A15: per-concern サブモジュール
 * （src/cli/course/*）へ behaviour-zero 分割した薄い orchestrator。course と phase の
 * 2 つの top-level group を登録順（= commander help 列挙順 = golden 凍結）どおりに
 * 構築し、共有 helper は course/helpers.ts に集約。
 */
export function registerCourseCommands(
  program: Command,
  opts: RegisterCourseCommandsOptions,
): void {
  // ── course ──────────────────────────────────────────────────────────────────
  const courseCmd = program
    .command("course")
    .description("course roadmap management");
  registerCourseSubcommands(courseCmd, opts);

  // ── phase ──────────────────────────────────────────────────────────────────
  const phaseCmd = program
    .command("phase")
    .description("course phase management");
  registerPhaseSubcommands(phaseCmd, opts);
}
