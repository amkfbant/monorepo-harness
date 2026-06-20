export type UsageSource =
  | "exact"
  | "parsed_log"
  | "estimated"
  | "unavailable";

export interface ParsedCodexUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  /**
   * Total token definition for Codex CLI structured usage:
   * `total_tokens = input_tokens + output_tokens`.
   *
   * `reasoning_output_tokens` is reported separately and is not added again.
   */
  totalTokens: number | null;
  usageSource: UsageSource;
}

/**
 * One Codex `turn.completed.usage` event, captured as its own row (#206
 * agent-usage telemetry). The legacy `run_usage` shape collapses every turn
 * into a single summed row; `agent_usage_turn` keeps the per-turn breakdown.
 * In practice Codex emits a single turn per invocation, but the parser models
 * the general case so a multi-turn run is recorded faithfully rather than lost.
 */
export interface CodexTurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  /** total_tokens = input_tokens + output_tokens (reasoning is NOT re-added). */
  totalTokens: number;
  usageSource: UsageSource;
}

const UNAVAILABLE_USAGE: ParsedCodexUsage = {
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  totalTokens: null,
  usageSource: "unavailable",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Parse Codex CLI `--json` JSONL events into one row per `turn.completed.usage`.
 *
 * Total function (never throws) — this matters because the writer's fail-open
 * guard (`recordAgentUsage`) relies on parsing being side-effect free and
 * crash free. Malformed input, missing usage, or unexpected shapes yield `[]`.
 *
 * All-or-nothing rule (legacy parity): if ANY `turn.completed` carries a
 * malformed/partial usage object the whole run's turns are discarded. The
 * summed `run_usage` row would otherwise be partial and untrustworthy, and the
 * pre-#206 `parseCodexUsage` made the same choice.
 */
export function parseCodexTurns(content: string): CodexTurnUsage[] {
  try {
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) return [];

    const turns: CodexTurnUsage[] = [];
    for (const line of lines) {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event) || event.type !== "turn.completed") continue;
      if (!isRecord(event.usage)) return [];
      const input = integerField(event.usage, "input_tokens");
      const cachedInput = integerField(event.usage, "cached_input_tokens");
      const output = integerField(event.usage, "output_tokens");
      const reasoningOutput = integerField(
        event.usage,
        "reasoning_output_tokens",
      );
      if (
        input === null ||
        cachedInput === null ||
        output === null ||
        reasoningOutput === null
      ) {
        return [];
      }
      turns.push({
        inputTokens: input,
        cachedInputTokens: cachedInput,
        outputTokens: output,
        reasoningOutputTokens: reasoningOutput,
        totalTokens: input + output,
        usageSource: "exact",
      });
    }
    return turns;
  } catch {
    return [];
  }
}

/**
 * Sum per-turn rows into the legacy `run_usage` summary shape. Total function;
 * `[]` → unavailable. Kept byte-identical to the pre-#206 `parseCodexUsage`
 * accumulation so the dual-write keeps existing `run_usage` rows stable.
 */
export function sumCodexTurns(
  turns: readonly CodexTurnUsage[],
): ParsedCodexUsage {
  if (turns.length === 0) return UNAVAILABLE_USAGE;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  for (const turn of turns) {
    inputTokens += turn.inputTokens;
    cachedInputTokens += turn.cachedInputTokens;
    outputTokens += turn.outputTokens;
    reasoningOutputTokens += turn.reasoningOutputTokens;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
    usageSource: "exact",
  };
}

/**
 * Parse Codex CLI `--json` JSONL events and aggregate `turn.completed.usage`.
 *
 * Legacy summary API (pre-#206), kept byte-stable. Defined in terms of the
 * per-turn parse + sum so both surfaces agree by construction — the dual-write
 * equivalence guarantee (`run_usage` unchanged) holds without a parallel
 * accumulation path to drift from.
 */
export function parseCodexUsage(content: string): ParsedCodexUsage {
  return sumCodexTurns(parseCodexTurns(content));
}
