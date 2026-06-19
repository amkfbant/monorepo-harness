import process from "node:process";
import { join } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { cleanupRun, CleanupGateError } from "../core/cleanup.js";
import { checkMaintenance, runMaintenanceCleanup, formatFindings, formatCleanupResult, parseDuration, MaintenanceError } from "../core/maintenance.js";
import { buildMetrics, formatMetricsSummary, formatFailures } from "../core/metrics.js";
import { buildSessionPlan, formatSessionPlan, formatSessionSummary } from "../core/session.js";
import { StateConflictError, SourceModeError } from "../db/errors.js";
import { DomainLockBusyError } from "../workspace/db-domain-lock.js";
import { hasScopeFilter, runMetricsDelta, runScopedMetrics, runMetricsSnapshot } from "./db-scope.js";

/**
 * `harness session` / `metrics` / `maintenance` / `cleanup` — 観測・診断系の
 * top-level command 群を run.ts から behavior-zero で抽出（内部 .command() 順は
 * session<metrics<maintenance<cleanup を保持）。sessionOpts/metricsSince は group
 * 内 helper として同梱。getHarnessRoot は opts 経由で遅延解決。
 */
export function registerDiagnosticsCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const sessionCmd = program
    .command("session")
    .description("rule-ordered work-session planning (suggestion only)");
  function sessionOpts(): {
    runsDir: string;
    workspacesDir: string;
    backlogDir: string;
    knowledgeDir: string;
  } {
    const harnessRoot = opts.getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    return {
      runsDir: paths.runsDir,
      workspacesDir: paths.workspacesDir,
      backlogDir: paths.backlogDir,
      knowledgeDir: join(harnessRoot, "docs", "knowledge"),
    };
  }
  sessionCmd
    .command("plan")
    .description("ordered to-do list from the current state (does not run)")
    .action(async () => {
      process.stdout.write(
        formatSessionPlan(await buildSessionPlan(sessionOpts())),
      );
    });
  sessionCmd
    .command("start")
    .description("the first N items of the session plan")
    .option("--limit <n>", "how many items to show", "3")
    .action(async (raw: Record<string, unknown>) => {
      const n = Number(raw.limit);
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write(
          `harness error: --limit must be a positive integer (got ${JSON.stringify(String(raw.limit))})\n`,
        );
        process.exit(1);
      }
      process.stdout.write(
        formatSessionPlan(await buildSessionPlan(sessionOpts()), n),
      );
    });
  sessionCmd
    .command("summary")
    .description("compact snapshot of what is pending now")
    .action(async () => {
      process.stdout.write(
        formatSessionSummary(await buildSessionPlan(sessionOpts())),
      );
    });

  const metricsCmd = program
    .command("metrics")
    .description("personal operating metrics over runs / review / retry");
  function metricsSince(raw: Record<string, unknown>): Date | undefined {
    if (raw.since === undefined) return undefined;
    try {
      return new Date(Date.now() - parseDuration(String(raw.since)));
    } catch (e) {
      process.stderr.write(`harness error: ${(e as Error).message}\n`);
      process.exit(1);
    }
  }
  metricsCmd
    .command("summary")
    .description("run / review / retry / safety summary")
    .option("--since <dur>", "window, e.g. 30d / 12h")
    .option("--project <id>", "scope to a project (DB-backed, Phase 6)")
    .option("--repo-id <id>", "scope to a repo (DB-backed, Phase 6)")
    .option("--domain <d>", "scope to a domain (with --project / --repo-id)")
    .option("--json", "emit JSON instead of text")
    .action(async (raw: Record<string, unknown>) => {
      if (hasScopeFilter(raw)) {
        runScopedMetrics(opts.getHarnessRoot(), raw);
        return;
      }
      const paths = harnessPaths(opts.getHarnessRoot());
      const since = metricsSince(raw);
      const m = await buildMetrics({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        ...(since ? { since } : {}),
      });
      process.stdout.write(formatMetricsSummary(m));
    });
  metricsCmd
    .command("snapshot")
    .description("record a metrics aggregate snapshot and prune retention")
    .option("--project <id>", "scope to a project")
    .option("--repo-id <id>", "scope to a repo")
    .option("--domain <d>", "scope to a domain")
    .option("--retention-days <n>", "snapshot retention in days", "90")
    .option("--json", "emit JSON instead of text")
    .action((raw: Record<string, unknown>) => {
      runMetricsSnapshot(opts.getHarnessRoot(), raw);
    });
  metricsCmd
    .command("delta")
    .description("compare live metrics to an older aggregate snapshot")
    .option("--since <dur>", "baseline age, e.g. 7d / 12h", "7d")
    .option("--project <id>", "scope to a project")
    .option("--repo-id <id>", "scope to a repo")
    .option("--domain <d>", "scope to a domain")
    .option("--json", "emit JSON instead of text")
    .action((raw: Record<string, unknown>) => {
      runMetricsDelta(opts.getHarnessRoot(), raw);
    });
  metricsCmd
    .command("domain")
    .description("metrics for a single domain")
    .argument("<domain>", "target domain")
    .option("--since <dur>", "window, e.g. 30d / 12h")
    .action(async (domain: string, raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const since = metricsSince(raw);
      const m = await buildMetrics({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        domain,
        ...(since ? { since } : {}),
      });
      process.stdout.write(formatMetricsSummary(m));
    });
  metricsCmd
    .command("failures")
    .description("breakdown of failed-* runs by status")
    .option("--since <dur>", "window, e.g. 30d / 12h")
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const since = metricsSince(raw);
      const m = await buildMetrics({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        ...(since ? { since } : {}),
      });
      process.stdout.write(formatFailures(m));
    });

  const maintenanceCmd = program
    .command("maintenance")
    .description("detect and clean up operational debris");
  maintenanceCmd
    .command("check")
    .description("report stale locks / orphan worktrees / oversized run dirs")
    .action(async () => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const findings = await checkMaintenance({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
      });
      process.stdout.write(formatFindings(findings));
    });
  maintenanceCmd
    .command("cleanup")
    .description("remove cleanable debris (stale locks / orphan worktrees)")
    .option("--dry-run", "list what would be removed, delete nothing", false)
    .option("--older-than <dur>", "only debris older than e.g. 30d / 12h")
    .option("--force", "actually delete (required for a non-dry-run)", false)
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      try {
        const result = await runMaintenanceCleanup({
          runsDir: paths.runsDir,
          workspacesDir: paths.workspacesDir,
          locksDir: paths.locksDir,
          dryRun: Boolean(raw.dryRun),
          force: Boolean(raw.force),
          ...(raw.olderThan !== undefined
            ? { olderThanMs: parseDuration(String(raw.olderThan)) }
            : {}),
        });
        process.stdout.write(formatCleanupResult(result));
      } catch (e) {
        if (e instanceof MaintenanceError) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });

  program
    .command("cleanup")
    .description(
      "remove worktree + branch for an approved/rejected run (run dir kept by default)",
    )
    .requiredOption("--run-id <id>", "target run identifier")
    .option(
      "--force",
      "allow cleanup of needs_review / failed-* / verified / generated (NOT changes_requested or running)",
      false,
    )
    .option(
      "--scope <scope>",
      "workspace (worktree+branch, keep run dir) | run (also delete run dir) | all (also git worktree prune)",
      "workspace",
    )
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const scope = String(raw.scope);
      if (scope !== "workspace" && scope !== "run" && scope !== "all") {
        process.stderr.write(
          `harness error: --scope must be workspace | run | all (got ${JSON.stringify(scope)})\n`,
        );
        process.exit(1);
      }
      try {
        const result = await cleanupRun({
          runsDir: paths.runsDir,
          workspacesDir: paths.workspacesDir,
          locksDir: paths.locksDir,
          dbPath: paths.dbPath,
          runId: String(raw.runId),
          force: Boolean(raw.force),
          scope,
        });
        process.stdout.write(
          `run=${result.runId} scope=${result.scope} previousStatus=${result.previousStatus} worktreeRemoved=${result.worktreeRemoved} branchRemoved=${result.branchRemoved} runDirRemoved=${result.runDirRemoved}\n`,
        );
      } catch (e) {
        if (
          e instanceof CleanupGateError ||
          e instanceof DomainLockBusyError ||
          e instanceof StateConflictError ||
          e instanceof SourceModeError
        ) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
}
