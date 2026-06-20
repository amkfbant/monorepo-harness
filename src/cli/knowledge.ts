import type { Command } from "commander";
import { registerKnowledgeEntryCommands } from "./knowledge/entry-commands.js";
import { registerKnowledgeOpsCommands } from "./knowledge/ops-commands.js";
import { registerKnowledgeDigestCommand } from "./knowledge/digest-command.js";

/**
 * `harness knowledge`（build-context/list/reject/promote/deprecate/import/export/show/edit
 * + nested ops + digest）の registrar。#125 A15: per-concern サブモジュール
 * （src/cli/knowledge/*）へ behaviour-zero 分割した薄い orchestrator。registrar の
 * 呼出順 = commander の help 列挙順なので golden（cli-help-surface.test.ts）で凍結。
 * getHarnessRoot は opts 経由で遅延解決し各 sub-registrar へ渡す。
 */
export function registerKnowledgeCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const getHarnessRoot = opts.getHarnessRoot;
  const knowledgeCmd = program
    .command("knowledge")
    .description("review and promote knowledge-candidates");
  registerKnowledgeEntryCommands(knowledgeCmd, getHarnessRoot);
  registerKnowledgeOpsCommands(knowledgeCmd, getHarnessRoot);
  registerKnowledgeDigestCommand(knowledgeCmd, getHarnessRoot);
}
