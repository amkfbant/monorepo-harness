import { describe, it, expect } from "vitest";
import { parseClaudeStreamJson } from "../../../src/claude/usage-parser.js";

// Real `claude -p --output-format stream-json` envelope (Phase A实機, 2.1.185):
// assistant events carry per-message `message.usage`; the trailing `result`
// event carries a CUMULATIVE usage (with an `iterations[]` array) and must NOT
// be summed as a turn — only assistant events become turns.
const ASSISTANT = (id: string, u: Record<string, number>): string =>
  JSON.stringify({
    type: "assistant",
    message: { id, model: "claude-opus-4-8[1m]", usage: u },
  });

const RESULT_CUMULATIVE = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "final text",
  // cumulative totals — if this were summed as a turn it would double-count.
  usage: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 999 },
});

describe("parseClaudeStreamJson", () => {
  it("maps assistant usage to claude-shaped AgentUsageTurnInput with usageSource='exact'", () => {
    const stdout =
      [
        JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" }),
        ASSISTANT("m1", {
          input_tokens: 4,
          output_tokens: 101,
          cache_read_input_tokens: 7778,
          cache_creation_input_tokens: 2178,
        }),
        RESULT_CUMULATIVE,
      ].join("\n") + "\n";
    const turns = parseClaudeStreamJson(stdout);
    expect(turns).toHaveLength(1); // result event is NOT a turn
    const t = turns[0];
    expect(t.usageSource).toBe("exact");
    expect(t.inputTokens).toBe(4);
    expect(t.outputTokens).toBe(101);
    expect(t.cacheReadInputTokens).toBe(7778);
    expect(t.cacheCreationInputTokens).toBe(2178);
    expect(t.totalTokens).toBe(105); // input + output (reasoning never re-added)
    expect(t.model).toBe("claude-opus-4-8[1m]");
    // XOR CHECK: codex-only columns must be absent (not 0) for a claude row.
    expect(t.cachedInputTokens).toBeUndefined();
    expect(t.reasoningOutputTokens).toBeUndefined();
  });

  it("does NOT over-count streaming snapshots that share a message.id (last-snapshot-wins)", () => {
    const stdout =
      [
        ASSISTANT("m1", { input_tokens: 3, output_tokens: 1 }), // stub
        ASSISTANT("m1", { input_tokens: 3, output_tokens: 1 }), // stub
        ASSISTANT("m1", { input_tokens: 3, output_tokens: 692 }), // FINAL authoritative
        ASSISTANT("m2", { input_tokens: 10, output_tokens: 50 }),
        RESULT_CUMULATIVE,
      ].join("\n") + "\n";
    const turns = parseClaudeStreamJson(stdout);
    expect(turns).toHaveLength(2); // one per distinct message.id
    expect(turns[0].outputTokens).toBe(692); // final, not 1+1+692
    expect(turns[0].turnSeq).toBe(0);
    expect(turns[1].outputTokens).toBe(50);
    expect(turns[1].turnSeq).toBe(1);
  });

  it("derives cache_creation from the 5m/1h split when the flat total is absent", () => {
    const stdout =
      ASSISTANT("m1", { input_tokens: 1, output_tokens: 1 }).replace(
        '"output_tokens":1',
        '"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":6}',
      ) + "\n";
    const turns = parseClaudeStreamJson(stdout);
    expect(turns[0].cacheCreationInputTokens).toBe(10);
    expect(turns[0].cacheCreation5mInputTokens).toBe(4);
    expect(turns[0].cacheCreation1hInputTokens).toBe(6);
  });

  it("is a total function: empty / malformed input yields []", () => {
    expect(parseClaudeStreamJson("")).toEqual([]);
    expect(parseClaudeStreamJson("not json\n{bad\nnull\n[]")).toEqual([]);
    // a stream with only non-assistant events → no turns
    expect(
      parseClaudeStreamJson(RESULT_CUMULATIVE + "\n"),
    ).toEqual([]);
  });
});
