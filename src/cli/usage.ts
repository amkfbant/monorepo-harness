import process from "node:process";
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import {
  subagentUsageSummary,
  type SubagentUsageSummary,
} from "../db/repositories/subagent-usage.js";
import {
  codexUsageSummary,
  type CodexUsageFilter,
  type CodexUsageSummary,
} from "../db/repositories/codex-usage.js";
import { writeOutput } from "./course/helpers.js";

/**
 * `harness usage` — read-only agent usage telemetry (ops-facing).
 *
 * Why: Surfaces token consumption aggregated from agent_invocation +
 * agent_usage_turn (schema v36+):
 *   - `subagents` = ops-driven external claude subagents (tool=claude, role=external);
 *   - `internal`  = the harness's own claude coder/reviewer/evaluator runs (#191);
 *   - `codex`     = external codex usage written by the `harness codex exec`
 *                   wrapper (tool=codex, role=external), grouped by
 *                   course/hitch/external_label (#403).
 * Designed for ops-mode inspection without risk of accidental migration
 * (readonly: true).
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
      const since = opts.since as string | undefined;
      runUsageQuery(deps.getHarnessRoot, opts, {
        query: (db) =>
          subagentUsageSummary(db, since !== undefined ? { since } : {}),
        zero: buildZeroSubagentSummary,
        format: formatSubagentUsageText,
      });
    });

  usageGroup
    .command("internal")
    .description(
      "aggregate the harness's own Claude coder/reviewer/evaluator token usage (#191)",
    )
    .option("--since <iso>", "only invocations created at or after this ISO timestamp")
    .option("--json", "emit JSON instead of text")
    .action((opts: Record<string, unknown>) => {
      const since = opts.since as string | undefined;
      runUsageQuery(deps.getHarnessRoot, opts, {
        query: (db) =>
          subagentUsageSummary(db, {
            roles: INTERNAL_CLAUDE_ROLES,
            ...(since !== undefined ? { since } : {}),
          }),
        zero: buildZeroSubagentSummary,
        format: formatSubagentUsageText,
      });
    });

  usageGroup
    .command("codex")
    .description(
      "aggregate external codex token usage (tool=codex, role=external) by course/hitch/external_label (#403)",
    )
    .option("--since <iso>", "only invocations created at or after this ISO timestamp")
    .option("--course <id>", "filter to a single course_id")
    .option("--hitch <id>", "filter to a single hitch_id")
    .option("--label <label>", "filter to a single external_label")
    .option("--json", "emit JSON instead of text")
    .action((opts: Record<string, unknown>) => {
      runUsageQuery(deps.getHarnessRoot, opts, {
        query: (db) => codexUsageSummary(db, buildCodexFilter(opts)),
        zero: buildZeroCodexSummary,
        format: formatCodexUsageText,
      });
    });
}

/**
 * A read-only usage view: how to query it, its zero-shaped fallback, and how to
 * render it as text. Lets `runUsageQuery` carry the shared fail-open scaffolding
 * once while each subcommand supplies its own summary type/SQL/formatter.
 */
interface UsageReader<T> {
  query: (db: Database.Database) => T;
  zero: () => T;
  format: (summary: T) => string;
}

/**
 * Shared fail-open execution for the read-only usage subcommands. Every
 * absent/corrupt/locked-DB path yields the reader's zero-shaped summary, never a
 * hard exit (#351). readonly: true — MUST NOT runMigrations on an observational
 * command.
 */
function runUsageQuery<T>(
  getHarnessRoot: () => string,
  opts: Record<string, unknown>,
  reader: UsageReader<T>,
): void {
  const paths = harnessPaths(getHarnessRoot());
  const emitZero = (): void => {
    const empty = reader.zero();
    writeOutput(opts, empty, reader.format(empty));
  };

  // Fail-open: missing DB → zero-shaped summary with a diagnostic note.
  if (!existsSync(paths.dbPath)) {
    process.stderr.write(
      "usage: DB not initialised — run 'harness db init'. Emitting zero summary.\n",
    );
    emitZero();
    return;
  }

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
    emitZero();
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
      emitZero();
      return;
    }

    const summary = reader.query(managed.db);
    writeOutput(opts, summary, reader.format(summary));
  } catch (e) {
    // Any read-side failure (corrupt page, etc.) is fail-open too.
    process.stderr.write(
      `usage: query failed (${e instanceof Error ? e.message : String(e)}). ` +
        "Emitting zero summary.\n",
    );
    emitZero();
  } finally {
    managed.close();
  }
}

function buildCodexFilter(opts: Record<string, unknown>): CodexUsageFilter {
  const course = opts.course as string | undefined;
  const hitch = opts.hitch as string | undefined;
  const label = opts.label as string | undefined;
  const since = opts.since as string | undefined;
  return {
    ...(course !== undefined ? { course } : {}),
    ...(hitch !== undefined ? { hitch } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

function buildZeroSubagentSummary(): SubagentUsageSummary {
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

function buildZeroCodexSummary(): CodexUsageSummary {
  return {
    rows: [],
    totals: {
      invocations: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
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

function formatCodexUsageText(s: CodexUsageSummary): string {
  if (s.rows.length === 0) return "No external codex usage recorded.\n";
  const lines = s.rows.map(
    (r) =>
      `course=${r.courseId ?? "-"}\t` +
      `hitch=${r.hitchId ?? "-"}\t` +
      `label=${r.externalLabel ?? "-"}\t` +
      `invocations=${r.invocations}\t` +
      `in=${r.inputTokens}\t` +
      `cached_in=${r.cachedInputTokens}\t` +
      `out=${r.outputTokens}\t` +
      `reasoning_out=${r.reasoningOutputTokens}\t` +
      `total=${r.totalTokens}`,
  );
  lines.push(
    `TOTAL\t-\t-\t` +
      `invocations=${s.totals.invocations}\t` +
      `in=${s.totals.inputTokens}\t` +
      `cached_in=${s.totals.cachedInputTokens}\t` +
      `out=${s.totals.outputTokens}\t` +
      `reasoning_out=${s.totals.reasoningOutputTokens}\t` +
      `total=${s.totals.totalTokens}`,
  );
  return `${lines.join("\n")}\n`;
}
