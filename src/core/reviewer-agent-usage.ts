// reviewer codex の token 使用量テレメトリ（token-usage G2）。
// fail-open: テレメトリ書き込みの失敗は review 結果を絶対に変えない（warn して握る）。
import { existsSync } from "node:fs";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import {
  recordCodexUsage,
  resolveCodexModel,
} from "../db/repositories/run-usage.js";
import { recordClaudeUsage } from "../db/repositories/claude-usage.js";
import { resolveClaudeModel } from "./agent-runner.js";

/**
 * Telemetry-only warning (token-usage G2). Recording reviewer codex usage is
 * fail-open: a telemetry write must never change the review outcome.
 */
function warnReviewerUsageRecordFailed(runId: string, e: unknown): void {
  process.stderr.write(
    `warning: run ${runId}: reviewer codex usage telemetry was not recorded: ` +
      `${(e as Error).message}\n`,
  );
}

/**
 * Record the reviewer codex invocation's token usage (kind='reviewer') from
 * the already-read redacted events content (null when the events were not
 * published / unreadable → an `unavailable` row). Fail-open and best-effort:
 * any error (missing DB, write failure, lock) is warned and swallowed so the
 * review path is never affected. Called on ALL reviewer outcomes (success,
 * timeout, non-zero exit, invalid YAML) because codex consumed tokens
 * regardless of whether the verdict later passes its gate.
 */
export async function recordReviewerUsage(
  dbPath: string | undefined,
  runId: string,
  eventsContent: string | null,
  backend: "codex" | "claude" = "codex",
): Promise<void> {
  if (dbPath === undefined || !existsSync(dbPath)) return;
  try {
    const usageDb = openManagedDb({ dbPath });
    try {
      // Ensure the run_usage schema is current (per-invocation kind/seq).
      // On a not-yet-migrated (e.g. v29) DB the INSERT would otherwise fail
      // and the reviewer usage would be silently lost. runMigrations is
      // idempotent; the surrounding fail-open guard still covers any error.
      runMigrations(usageDb.db);
      if (backend === "claude") {
        // #191: a claude `-p` reviewer — record its claude stream-json usage
        // (tool='claude'; no legacy run_usage row, mirroring the coder).
        recordClaudeUsage({
          db: usageDb.db,
          runId,
          kind: "reviewer",
          eventsContent,
          model: resolveClaudeModel(),
          onError: (err) => warnReviewerUsageRecordFailed(runId, err),
        });
      } else {
        recordCodexUsage({
          db: usageDb.db,
          runId,
          kind: "reviewer",
          eventsContent,
          // reviewer has no policy in scope; the HARNESS_CODEX_MODEL env is the
          // uniform advisory source (#206). Absent → null → byte-stable.
          model: resolveCodexModel(),
          onError: (err) => warnReviewerUsageRecordFailed(runId, err),
        });
      }
    } finally {
      usageDb.close();
    }
  } catch (err) {
    warnReviewerUsageRecordFailed(runId, err);
  }
}
