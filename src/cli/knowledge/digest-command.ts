import process from "node:process";
import { join } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { buildKnowledgeDigest, formatDigest } from "../../core/knowledge-digest.js";
import { parseDuration } from "../../core/maintenance.js";
import { hasScopeFilter, runScopedKnowledgeDigest } from "../db-scope.js";

/**
 * `harness knowledge digest` 集計コマンド（#125 A15: cli/knowledge.ts から
 * behaviour-zero 分割）。top-level digest（scope filter は db-scope へ委譲）。
 */
export function registerKnowledgeDigestCommand(
  knowledgeCmd: Command,
  getHarnessRoot: () => string,
): void {
  knowledgeCmd
    .command("digest")
    .description("aggregate knowledge candidates / promotions / rejections")
    .option("--since <dur>", "only items within this window, e.g. 7d / 12h")
    .option("--domain <domain>", "restrict to one domain")
    .option("--project <id>", "scope to a project (DB-backed, Phase 6)")
    .option("--repo-id <id>", "scope to a repo (DB-backed, Phase 6)")
    .option("--json", "emit JSON instead of text")
    .action(async (raw: Record<string, unknown>) => {
      if (hasScopeFilter(raw)) {
        runScopedKnowledgeDigest(getHarnessRoot(), raw);
        return;
      }
      const harnessRoot = getHarnessRoot();
      const paths = harnessPaths(harnessRoot);
      let since: Date | undefined;
      if (raw.since !== undefined) {
        try {
          since = new Date(Date.now() - parseDuration(String(raw.since)));
        } catch (e) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
      }
      const digest = await buildKnowledgeDigest({
        runsDir: paths.runsDir,
        knowledgeDir: join(harnessRoot, "docs", "knowledge"),
        ...(since ? { since } : {}),
        ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
      });
      process.stdout.write(formatDigest(digest));
    });
}
