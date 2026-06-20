import process from "node:process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import {
  subagentUsageSummary,
  type SubagentUsageSummary,
} from "../db/repositories/subagent-usage.js";
import { writeOutput } from "./course/helpers.js";

/**
 * `harness usage` — read-only agent usage telemetry (ops-facing).
 *
 * Why: Surfaces ops-driven Claude subagent token consumption aggregated from
 * agent_invocation + agent_usage_turn (schema v36+). Designed for ops-mode
 * inspection without risk of accidental migration (readonly: true).
 *
 * Fail-open tail: if the DB is absent or the schema pre-dates v36 (tables
 * missing), the command logs a diagnostic and emits a zero-shaped summary
 * rather than crashing — keeps ops shell scripts from hard-failing on fresh
 * checkouts.
 *
 * Read before editing: docs/specs/cli.md ##`harness usage`
 */
export function registerUsageCommands(
  program: Command,
  deps: { getHarnessRoot: () => string },
): void {
  const usageGroup = program
    .command("usage")
    .description("read-only agent usage telemetry");

  usageGroup
    .command("subagents")
    .description(
      "aggregate ops-driven Claude subagent token usage (tool=claude, role=external)",
    )
    .option("--since <iso>", "only invocations created at or after this ISO timestamp")
    .option("--json", "emit JSON instead of text")
    .action((opts: Record<string, unknown>) => {
      const paths = harnessPaths(deps.getHarnessRoot());

      // Fail-open: missing DB → zero-shaped summary with a diagnostic note.
      if (!existsSync(paths.dbPath)) {
        process.stderr.write(
          "usage: DB not initialised — run 'harness db init'. Emitting zero summary.\n",
        );
        const empty = buildZeroSummary();
        writeOutput(opts, empty, formatSubagentUsageText(empty));
        return;
      }

      // readonly: true — must NOT runMigrations on an observational command.
      const managed = openManagedDb({ dbPath: paths.dbPath, readonly: true });
      try {
        // Fail-open: tables missing (schema pre-v36) → zero-shaped summary.
        const hasTable = managed.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_invocation'",
          )
          .get();
        if (hasTable === undefined) {
          process.stderr.write(
            "usage: agent_invocation table absent (schema < v36). " +
              "Run 'harness db migrate'. Emitting zero summary.\n",
          );
          const empty = buildZeroSummary();
          writeOutput(opts, empty, formatSubagentUsageText(empty));
          return;
        }

        const since = opts.since as string | undefined;
        const filter = since !== undefined ? { since } : {};
        const summary = subagentUsageSummary(managed.db, filter);
        writeOutput(opts, summary, formatSubagentUsageText(summary));
      } finally {
        managed.close();
      }
    });
}

function buildZeroSummary(): SubagentUsageSummary {
  return {
    rows: [],
    totals: {
      invocations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
    },
  };
}

function formatSubagentUsageText(s: SubagentUsageSummary): string {
  if (s.rows.length === 0) return "No Claude subagent usage recorded.\n";
  const lines = s.rows.map(
    (r) =>
      `${r.agentType ?? "-"}\t${r.model ?? "-"}\t` +
      `invocations=${r.invocations}\t` +
      `in=${r.inputTokens}\t` +
      `out=${r.outputTokens}\t` +
      `cache_read=${r.cacheReadInputTokens}\t` +
      `total=${r.totalTokens}`,
  );
  lines.push(
    `TOTAL\t-\t` +
      `invocations=${s.totals.invocations}\t` +
      `in=${s.totals.inputTokens}\t` +
      `out=${s.totals.outputTokens}\t` +
      `total=${s.totals.totalTokens}`,
  );
  return `${lines.join("\n")}\n`;
}
