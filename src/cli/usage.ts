import process from "node:process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import {
  subagentUsageSummary,
  type SubagentUsageFilter,
  type SubagentUsageSummary,
} from "../db/repositories/subagent-usage.js";
import { writeOutput } from "./course/helpers.js";

/**
 * `harness usage` — read-only agent usage telemetry (ops-facing).
 *
 * Why: Surfaces Claude token consumption aggregated from agent_invocation +
 * agent_usage_turn (schema v36+): `subagents` = ops-driven external subagents
 * (tool=claude, role=external); `internal` = the harness's own claude
 * coder/reviewer/evaluator runs (#191). Designed for ops-mode inspection
 * without risk of accidental migration (readonly: true).
 *
 * Fail-open tail: if the DB is absent or the schema pre-dates v36 (tables
 * missing), the command logs a diagnostic and emits a zero-shaped summary
 * rather than crashing — keeps ops shell scripts from hard-failing on fresh
 * checkouts.
 *
 * Read before editing: docs/specs/cli.md ##`harness usage`
 */
/**
 * Short lock-acquire timeout for this observational command. Under a held
 * EXCLUSIVE maintenance lock the default (30s) would block; 2s fails open fast.
 */
const USAGE_LOCK_TIMEOUT_MS = 2000;

/** Internal harness roles backed by a claude `-p` runner (#191). */
const INTERNAL_CLAUDE_ROLES = ["coder", "reviewer", "evaluator"] as const;

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
      runUsageQuery(deps.getHarnessRoot, opts, (since) =>
        since !== undefined ? { since } : {},
      );
    });

  usageGroup
    .command("internal")
    .description(
      "aggregate the harness's own Claude coder/reviewer/evaluator token usage (#191)",
    )
    .option("--since <iso>", "only invocations created at or after this ISO timestamp")
    .option("--json", "emit JSON instead of text")
    .action((opts: Record<string, unknown>) => {
      runUsageQuery(deps.getHarnessRoot, opts, (since) => ({
        roles: INTERNAL_CLAUDE_ROLES,
        ...(since !== undefined ? { since } : {}),
      }));
    });
}

/**
 * Shared fail-open execution for the read-only usage subcommands. `buildFilter`
 * picks the role scope (external subagents vs internal coder/reviewer/evaluator);
 * every absent/corrupt/locked-DB path yields the zero-shaped summary, never a
 * hard exit.
 */
function runUsageQuery(
  getHarnessRoot: () => string,
  opts: Record<string, unknown>,
  buildFilter: (since: string | undefined) => SubagentUsageFilter,
): void {
  const paths = harnessPaths(getHarnessRoot());

  // Fail-open: missing DB → zero-shaped summary with a diagnostic note.
  if (!existsSync(paths.dbPath)) {
    process.stderr.write(
      "usage: DB not initialised — run 'harness db init'. Emitting zero summary.\n",
    );
    emitZero(opts);
    return;
  }

  // readonly: true — must NOT runMigrations on an observational command.
  // Fail-open (#351): a corrupt DB ("file is not a database") or a shared-lock
  // acquire timeout under a held EXCLUSIVE maintenance lock must yield the zero
  // summary, NOT a hard exit. Short timeout so lock contention fails fast.
  let managed: ReturnType<typeof openManagedDb>;
  try {
    managed = openManagedDb({
      dbPath: paths.dbPath,
      readonly: true,
      timeoutMs: USAGE_LOCK_TIMEOUT_MS,
    });
  } catch (e) {
    process.stderr.write(
      `usage: cannot open DB (${e instanceof Error ? e.message : String(e)}). ` +
        "Emitting zero summary.\n",
    );
    emitZero(opts);
    return;
  }
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
      emitZero(opts);
      return;
    }

    const since = opts.since as string | undefined;
    const summary = subagentUsageSummary(managed.db, buildFilter(since));
    writeOutput(opts, summary, formatSubagentUsageText(summary));
  } catch (e) {
    // Any read-side failure (corrupt page, etc.) is fail-open too.
    process.stderr.write(
      `usage: query failed (${e instanceof Error ? e.message : String(e)}). ` +
        "Emitting zero summary.\n",
    );
    emitZero(opts);
  } finally {
    managed.close();
  }
}

function emitZero(opts: Record<string, unknown>): void {
  const empty = buildZeroSummary();
  writeOutput(opts, empty, formatSubagentUsageText(empty));
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
  if (s.rows.length === 0) return "No Claude usage recorded.\n";
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
