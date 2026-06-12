import { describe, expect, it } from "vitest";
import { parseCodexUsage } from "../../../src/codex/usage-parser.js";

describe("parseCodexUsage", () => {
  it("parses one turn.completed usage event", () => {
    const content = `${JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 7,
      },
    })}\n`;

    expect(parseCodexUsage(content)).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 7,
      totalTokens: 130,
      usageSource: "exact",
    });
  });

  it("sums usage across multiple turn.completed events", () => {
    const content = [
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 3,
        },
      },
      { type: "item.completed", usage: { input_tokens: 999 } },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          cached_input_tokens: 2,
          output_tokens: 9,
          reasoning_output_tokens: 4,
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n");

    expect(parseCodexUsage(`${content}\n`)).toEqual({
      inputTokens: 105,
      cachedInputTokens: 12,
      outputTokens: 29,
      reasoningOutputTokens: 7,
      totalTokens: 134,
      usageSource: "exact",
    });
  });

  it("returns unavailable for empty content", () => {
    expect(parseCodexUsage("")).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      usageSource: "unavailable",
    });
  });

  it("returns unavailable for broken JSON without throwing", () => {
    expect(() => parseCodexUsage("{broken-json\n")).not.toThrow();
    expect(parseCodexUsage("{broken-json\n")).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      usageSource: "unavailable",
    });
  });

  it("returns unavailable when no turn.completed usage is present", () => {
    const content = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");

    expect(parseCodexUsage(content)).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      usageSource: "unavailable",
    });
  });
});
