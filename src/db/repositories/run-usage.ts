import type Database from "better-sqlite3";
import { parseCodexUsage } from "../../codex/usage-parser.js";

export type RunUsageKind = "coder" | "reviewer" | "evaluator";

export interface RecordCodexUsageInput {
  db: Database.Database;
  runId: string;
  kind: RunUsageKind;
  eventsContent: string | null;
  now?: string | Date;
  /**
   * Optional fencing/lease guard. It runs in the same BEGIN IMMEDIATE
   * transaction as sequence allocation and insert.
   */
  beforeWrite?: () => void;
  /** Receives the write error; recordCodexUsage itself remains fail-open. */
  onError?: (error: unknown) => void;
}

function isoNow(now: string | Date | undefined): string {
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid run usage timestamp: ${String(now)}`);
  }
  return date.toISOString();
}

/**
 * Record one Codex invocation's structured usage from redacted
 * `codex-events.jsonl` content.
 *
 * The writer is fail-open: unavailable usage is recorded when the event content
 * has no usable `turn.completed.usage`, and database/guard failures are
 * reported through `onError` without throwing to the run workflow.
 */
export function recordCodexUsage(input: RecordCodexUsageInput): void {
  const usage = parseCodexUsage(input.eventsContent ?? "");
  try {
    const tx = input.db.transaction(() => {
      input.beforeWrite?.();
      const next = input.db
        .prepare(
          `SELECT COALESCE(MAX(seq) + 1, 0) AS seq
             FROM run_usage
            WHERE run_id = ? AND kind = ?`,
        )
        .get(input.runId, input.kind) as { seq: number };
      input.db
        .prepare(
          `INSERT INTO run_usage
             (run_id, kind, seq, model, input_tokens, cached_input_tokens,
              output_tokens, reasoning_output_tokens, total_tokens,
              usage_source, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.kind,
          next.seq,
          usage.inputTokens,
          usage.cachedInputTokens,
          usage.outputTokens,
          usage.reasoningOutputTokens,
          usage.totalTokens,
          usage.usageSource,
          isoNow(input.now),
        );
    });
    tx.immediate();
  } catch (error) {
    input.onError?.(error);
  }
}
