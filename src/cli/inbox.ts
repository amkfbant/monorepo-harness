import process from "node:process";
import { join } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import {
  buildInbox,
  formatInbox,
  formatInboxJson,
  type InboxSection,
} from "../core/inbox.js";
import { hasScopeFilter, runScopedInbox } from "./db-scope.js";

/**
 * `harness inbox` — today's queue（run.ts から behavior-zero で抽出）。
 * getHarnessRoot は action 実行時に opts 経由で遅延解決する。
 */
export function registerInboxCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  program
    .command("inbox")
    .description(
      "today's queue: needs_review / changes_requested / failed / cleanup / knowledge",
    )
    .option("--today", "only runs started today", false)
    .option(
      "--needs-action",
      "only sections that need an action (exclude knowledge)",
      false,
    )
    .option("--failed", "only the failed section", false)
    .option("--cleanup", "only the cleanup-candidates section", false)
    .option("--project <id>", "scope to a project (DB-backed, Phase 6)")
    .option("--repo-id <id>", "scope to a repo (DB-backed, Phase 6)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      // a project/repo/domain scope answers from the DB read model (Phase 6-6)
      if (hasScopeFilter(raw)) {
        runScopedInbox(opts.getHarnessRoot(), raw);
        return;
      }
      const harnessRoot = opts.getHarnessRoot();
      const paths = harnessPaths(harnessRoot);
      const inbox = await buildInbox({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        knowledgeDir: join(harnessRoot, "docs", "knowledge"),
        ...(raw.today ? { today: new Date() } : {}),
      });
      // section selection is decided BEFORE the json branch so --failed /
      // --cleanup / --needs-action apply to JSON output too.
      let sections: InboxSection[] | undefined;
      if (raw.failed) sections = ["failed"];
      else if (raw.cleanup) sections = ["cleanupCandidates"];
      else if (raw.needsAction) {
        sections = [
          "needsReview",
          "changesRequested",
          "failed",
          "cleanupCandidates",
        ];
      }
      if (raw.json) {
        process.stdout.write(
          sections ? formatInboxJson(inbox, sections) : formatInboxJson(inbox),
        );
        return;
      }
      process.stdout.write(
        sections ? formatInbox(inbox, sections) : formatInbox(inbox),
      );
    });
}
