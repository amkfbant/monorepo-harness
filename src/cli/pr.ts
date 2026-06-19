import process from "node:process";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { runCopilotReview } from "../core/copilot-review-run.js";
import { createGhCopilotReviewer } from "../core/copilot-reviewer-gh.js";
import { createGhPrPublisher } from "../core/gh-pr-publisher.js";
import { createPullRequest, PrGateError } from "../core/pr-creator.js";
import { StateConflictError, SourceModeError } from "../db/errors.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { startOperation, succeedOperation, failOperation } from "../db/repositories/operations.js";
import { registerInboxCommands } from "./inbox.js";
import { parseNonNegativeIntSeconds, parsePositiveIntSeconds, parsePositiveInt } from "./run-core.js";

/**
 * `harness pr`（GitHub pull request 連携）と `pr request-review` を run.ts から
 * behavior-zero で抽出。run 駆動の parse helper(parsePositiveInt 等)は run-core.ts から
 * import。getHarnessRoot は opts 経由で遅延解決。
 */
export function registerPrCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const getHarnessRoot = opts.getHarnessRoot;
  const prCmd = program
    .command("pr")
    .description("GitHub pull request integration");
  prCmd
    .command("create")
    .description("turn an approved run into a draft GitHub PR")
    .requiredOption("--run-id <id>", "target run identifier (must be approved)")
    .option("--base <branch>", "PR base branch", "main")
    .option("--title <text>", "PR title (default derives from runId + domain)")
    .option(
      "--no-draft",
      "create a ready PR instead of a draft (default: draft)",
    )
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(getHarnessRoot());
      const ghBin = process.env.HARNESS_GH_BIN ?? "gh";
      try {
        const r = await createPullRequest({
          runsDir: paths.runsDir,
          workspacesDir: paths.workspacesDir,
          locksDir: paths.locksDir,
          dbPath: paths.dbPath,
          runId: String(raw.runId),
          base: String(raw.base),
          // commander maps --no-draft to raw.draft === false
          draft: raw.draft !== false,
          publisher: createGhPrPublisher(ghBin),
          ...(raw.title !== undefined ? { title: String(raw.title) } : {}),
        });
        process.stdout.write(
          `run=${r.runId} pr=#${r.prNumber} head=${r.head}\n${r.prUrl}\n`,
        );
      } catch (e) {
        if (
          e instanceof PrGateError ||
          e instanceof StateConflictError ||
          e instanceof SourceModeError
        ) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });

  /**
   * Parse a non-negative *integer* seconds CLI arg; exit 2 on anything invalid.
   * Non-finite / negative / non-integer (decimal) all fail — seconds are whole.
   * 0 is allowed (= observe once, no wait budget).
   */
  /**
   * Parse a positive (> 0) *integer* seconds CLI arg; exit 2 on anything invalid.
   * Used for `--poll-interval` so we never poll GitHub at 0 / sub-second / NaN.
   */
  /** Parse a positive integer CLI arg; exit 2 on anything invalid (incl. decimals). */
  prCmd
    .command("request-review")
    .description(
      "best-effort: request a Copilot review on a PR (retry-then-skip, non-gating)",
    )
    .argument("<pr-number>", "GitHub PR number")
    .requiredOption("--repo <path>", "path to the target git repo")
    .option("--timeout <seconds>", "total poll timeout in seconds", "300")
    .option("--poll-interval <seconds>", "seconds between polls", "15")
    .option("--request-attempts <n>", "request retry attempts", "3")
    .option("--json", "emit JSON", false)
    .action(async (prArg: string, raw: Record<string, unknown>) => {
      const prNumber = Number(prArg);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        process.stderr.write(`harness error: invalid PR number: ${prArg}\n`);
        process.exit(2);
      }
      const ghBin = process.env.HARNESS_GH_BIN ?? "gh";
      const repoDir = String(raw.repo);
      // Validate numeric args BEFORE the seconds→ms conversion. Seconds must be
      // whole integers; a NaN/decimal deadline (e.g. `--timeout foo` / `1.5`)
      // would otherwise never trip the skip check or be silently floored.
      //   --timeout         : non-negative integer (0 = observe once, no budget)
      //   --poll-interval   : positive integer (never poll GitHub at 0 / sub-second)
      //   --request-attempts: positive integer (no silent floor of decimals)
      const timeoutSec = parseNonNegativeIntSeconds(raw.timeout, "--timeout");
      const pollIntervalSec = parsePositiveIntSeconds(
        raw.pollInterval,
        "--poll-interval",
      );
      const requestAttempts = parsePositiveInt(
        raw.requestAttempts,
        "--request-attempts",
      );
      const pollTimeoutMs = timeoutSec * 1000;
      const pollIntervalMs = pollIntervalSec * 1000;
      // Node's setTimeout truncates a delay > the signed 32-bit max to 1ms (a
      // busy-loop). Reject such a (seconds→ms) value explicitly instead of letting
      // it silently round down — fail-closed with a clear message.
      const MAX_TIMER_MS = 2_147_483_647;
      if (pollTimeoutMs > MAX_TIMER_MS) {
        process.stderr.write(
          `harness error: --timeout too large: ${String(raw.timeout)}s exceeds the ` +
            `${MAX_TIMER_MS}ms timer limit\n`,
        );
        process.exit(2);
      }
      if (pollIntervalMs > MAX_TIMER_MS) {
        process.stderr.write(
          `harness error: --poll-interval too large: ${String(raw.pollInterval)}s ` +
            `exceeds the ${MAX_TIMER_MS}ms timer limit\n`,
        );
        process.exit(2);
      }
      const config = {
        pollTimeoutMs,
        pollIntervalMs,
        requestAttempts,
      };
      // Capture the start before the review runs so the audit `started_at`
      // reflects when the work began (the DB write happens after it completes).
      const startedAt = new Date();
      const outcome = await runCopilotReview({
        reviewer: createGhCopilotReviewer(repoDir, ghBin),
        prNumber,
        config,
      });

      // audit (best-effort: a recording failure must not change the exit code).
      try {
        const paths = harnessPaths(getHarnessRoot());
        const dbHandle = openManagedDb({ dbPath: paths.dbPath });
        try {
          runMigrations(dbHandle.db);
          const operationId = `op-${randomUUID()}`;
          startOperation(dbHandle.db, {
            operationId,
            operationType: "copilot-review",
            targetType: "pr",
            targetId: String(prNumber),
            actor: "cli",
            dryRun: false,
            input: { prNumber, config },
            now: startedAt,
          });
          if (outcome.status === "failed") {
            failOperation(
              dbHandle.db,
              operationId,
              "copilot_review_failed",
              outcome.detail,
            );
          } else {
            // reviewed | skipped are terminal best-effort outcomes (the operation
            // itself completed; the result JSON's `status` distinguishes them).
            // `pending` would be wrong — it means "deferred to an external worker"
            // and the doctor would flag a timed-out skip as a stale pending op.
            succeedOperation(dbHandle.db, operationId, outcome);
          }
        } finally {
          dbHandle.close();
        }
      } catch (e) {
        process.stderr.write(
          `warning: could not record copilot-review audit: ${(e as Error).message}\n`,
        );
      }

      if (raw.json === true) {
        process.stdout.write(`${JSON.stringify({ prNumber, ...outcome })}\n`);
      } else {
        process.stdout.write(
          `pr=#${prNumber} copilot-review=${outcome.status} (${outcome.detail})\n`,
        );
      }
      // reviewed / skipped (a timeout is a normal best-effort result) → 0;
      // failed (the request itself could not be established) → non-0 so an
      // operator notices. orchestrate ignores this exit (non-gating).
      process.exit(outcome.status === "failed" ? 1 : 0);
    });

  registerInboxCommands(program, { getHarnessRoot });
}
