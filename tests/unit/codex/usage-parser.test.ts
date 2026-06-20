import { describe, expect, it } from "vitest";
import {
  parseCodexTurns,
  parseCodexUsage,
  sumCodexTurns,
} from "../../../src/codex/usage-parser.js";

function turnEvent(
  input: number,
  cached: number,
  output: number,
  reasoning: number,
): string {
  return JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
    },
  });
}

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

describe("parseCodexTurns (per-turn rows, #206)", () => {
  it("returns one row per turn.completed usage event", () => {
    const content = `${turnEvent(100, 20, 30, 7)}\n`;
    expect(parseCodexTurns(content)).toEqual([
      {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 7,
        totalTokens: 130,
        usageSource: "exact",
      },
    ]);
  });

  it("preserves per-turn breakdown across multiple turns (does not pre-sum)", () => {
    const content = [
      turnEvent(100, 10, 20, 3),
      JSON.stringify({ type: "item.completed", usage: { input_tokens: 999 } }),
      turnEvent(5, 2, 9, 4),
    ].join("\n");
    expect(parseCodexTurns(`${content}\n`)).toEqual([
      {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 3,
        totalTokens: 120,
        usageSource: "exact",
      },
      {
        inputTokens: 5,
        cachedInputTokens: 2,
        outputTokens: 9,
        reasoningOutputTokens: 4,
        totalTokens: 14,
        usageSource: "exact",
      },
    ]);
  });

  it("is a total function: malformed input yields [] without throwing", () => {
    expect(() => parseCodexTurns("{broken-json\n")).not.toThrow();
    expect(parseCodexTurns("{broken-json\n")).toEqual([]);
    expect(parseCodexTurns("")).toEqual([]);
  });

  it("discards all turns when any turn.completed has malformed usage (legacy parity)", () => {
    const content = [
      turnEvent(100, 10, 20, 3),
      JSON.stringify({ type: "turn.completed" }), // missing usage → discard all
    ].join("\n");
    expect(parseCodexTurns(content)).toEqual([]);
  });
});

describe("sumCodexTurns", () => {
  it("sums per-turn rows into the legacy run_usage summary shape", () => {
    const turns = parseCodexTurns(
      [turnEvent(100, 10, 20, 3), turnEvent(5, 2, 9, 4)].join("\n"),
    );
    expect(sumCodexTurns(turns)).toEqual({
      inputTokens: 105,
      cachedInputTokens: 12,
      outputTokens: 29,
      reasoningOutputTokens: 7,
      totalTokens: 134,
      usageSource: "exact",
    });
  });

  it("returns unavailable for an empty turn list", () => {
    expect(sumCodexTurns([])).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      usageSource: "unavailable",
    });
  });
});

describe("parseCodexUsage === sumCodexTurns ∘ parseCodexTurns (equivalence)", () => {
  const cases: [string, string][] = [
    ["single turn", `${turnEvent(100, 20, 30, 7)}\n`],
    [
      "two turns",
      `${[turnEvent(100, 10, 20, 3), turnEvent(5, 2, 9, 4)].join("\n")}\n`,
    ],
    ["empty", ""],
    ["broken json", "{broken-json\n"],
    [
      "no usage",
      [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n"),
    ],
  ];
  for (const [name, content] of cases) {
    it(`agrees for ${name}`, () => {
      expect(parseCodexUsage(content)).toEqual(
        sumCodexTurns(parseCodexTurns(content)),
      );
    });
  }
});
