import type Database from "better-sqlite3";
import {
  parseCodexTurns,
  sumCodexTurns,
  type CodexTurnUsage,
  type UsageSource,
} from "../../codex/usage-parser.js";
import {
  recordAgentUsage,
  type AgentUsageTurnInput,
} from "./agent-usage.js";

export type RunUsageKind = "coder" | "reviewer" | "evaluator";

/**
 * Resolve the advisory codex model for telemetry (#206). The harness does NOT
 * inject `-m`, so this is best-effort metadata, not a verified model: the
 * operator's policy-declared model if present, else the `HARNESS_CODEX_MODEL`
 * env override (the uniform source for roles without a policy in scope —
 * reviewer/evaluator), else null so no-config telemetry stays byte-stable.
 *
 * The writer itself stays pure: callers resolve the model and pass it in, which
 * keeps `recordAgentUsage`/`recordCodexUsage` and their tests env-independent.
 */
export function resolveCodexModel(
  policyModel?: string | null,
): string | null {
  if (policyModel !== undefined && policyModel !== null && policyModel !== "") {
    return policyModel;
  }
  const env = process.env.HARNESS_CODEX_MODEL;
  return env !== undefined && env !== "" ? env : null;
}

export interface RecordCodexUsageInput {
  db: Database.Database;
  runId: string;
  kind: RunUsageKind;
  eventsContent: string | null;
  /**
   * Advisory model recorded into telemetry (#206). Absent → NULL → the legacy
   * `run_usage` row stays byte-stable for no-config runs.
   */
  model?: string | null;
  now?: string | Date;
  /**
   * Optional fencing/lease guard. It runs in the same BEGIN IMMEDIATE
   * transaction as sequence allocation and insert.
   */
  beforeWrite?: () => void;
  /** Receives the write error; recordCodexUsage itself remains fail-open. */
  onError?: (error: unknown) => void;
}

/**
 * Map parsed codex turns to `agent_usage_turn` rows. An unavailable parse
 * (no turns) yields ONE synthetic null turn so the new tables keep the
 * backfill's 1:1 invariant (one `run_usage` row ↔ one `agent_usage_turn` row).
 */
export function codexTurnInputs(
  turns: readonly CodexTurnUsage[],
  model: string | null,
  summarySource: UsageSource,
): AgentUsageTurnInput[] {
  if (turns.length === 0) {
    return [{ turnSeq: 0, model, usageSource: summarySource }];
  }
  return turns.map((turn, index) => ({
    turnSeq: index,
    model,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    totalTokens: turn.totalTokens,
    cachedInputTokens: turn.cachedInputTokens,
    reasoningOutputTokens: turn.reasoningOutputTokens,
    usageSource: turn.usageSource,
  }));
}

/**
 * Record one Codex invocation's structured usage from redacted
 * `codex-events.jsonl` content.
 *
 * Thin forwarder over `recordAgentUsage` (#206): it parses the codex events
 * into per-turn rows + a summed legacy summary, then dual-writes `run_usage`
 * (byte-stable) alongside `agent_invocation` + `agent_usage_turn` in one
 * transaction. Parsing is a total function, so building the turns before the
 * fail-open writer cannot throw into the run workflow.
 *
 * The writer is fail-open: unavailable usage is recorded when the event content
 * has no usable `turn.completed.usage`, and database/guard failures are
 * reported through `onError` without throwing to the run workflow.
 */
export function recordCodexUsage(input: RecordCodexUsageInput): void {
  const turns = parseCodexTurns(input.eventsContent ?? "");
  const summary = sumCodexTurns(turns);
  const model = input.model ?? null;
  recordAgentUsage({
    db: input.db,
    tool: "codex",
    role: input.kind,
    model,
    runId: input.runId,
    usageSource: summary.usageSource,
    turns: codexTurnInputs(turns, model, summary.usageSource),
    legacyRunUsage: { kind: input.kind, summary },
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.beforeWrite !== undefined
      ? { beforeWrite: input.beforeWrite }
      : {}),
    ...(input.onError !== undefined ? { onError: input.onError } : {}),
  });
}
