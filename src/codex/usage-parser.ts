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
 * Parse Codex CLI `--json` JSONL events and aggregate `turn.completed.usage`.
 *
 * This function is fail-open: malformed input, missing usage, or unexpected
 * shapes return `usageSource: "unavailable"` with null token fields.
 */
export function parseCodexUsage(content: string): ParsedCodexUsage {
  try {
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) return UNAVAILABLE_USAGE;

    let turns = 0;
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let reasoningOutputTokens = 0;
    for (const line of lines) {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event) || event.type !== "turn.completed") continue;
      if (!isRecord(event.usage)) return UNAVAILABLE_USAGE;
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
        return UNAVAILABLE_USAGE;
      }
      turns += 1;
      inputTokens += input;
      cachedInputTokens += cachedInput;
      outputTokens += output;
      reasoningOutputTokens += reasoningOutput;
    }
    if (turns === 0) return UNAVAILABLE_USAGE;
    return {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens: inputTokens + outputTokens,
      usageSource: "exact",
    };
  } catch {
    return UNAVAILABLE_USAGE;
  }
}
