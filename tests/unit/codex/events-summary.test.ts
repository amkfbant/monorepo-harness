import { describe, expect, it } from "vitest";
import { summarizeCodexEvents } from "../../../src/codex/events-summary.js";

function jsonl(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n").concat("\n");
}

describe("summarizeCodexEvents", () => {
  it("summarizes successful command, agent message, and usage events", () => {
    const summary = summarizeCodexEvents(
      jsonl([
        { type: "thread.started" },
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "npm test",
            exit_code: 0,
          },
        },
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "Implemented the requested change.",
          },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 12,
            cached_input_tokens: 3,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        },
      ]),
    );

    expect(summary).toBe(
      [
        "- item.completed command_execution command=`npm test` exit_code=0",
        "- item.completed agent_message: Implemented the requested change.",
        "- turn.completed usage input=12 cached_input=3 output=5 reasoning_output=2 total=17",
      ].join("\n"),
    );
  });

  it("summarizes failed command events and keeps the tail when maxItems is set", () => {
    const summary = summarizeCodexEvents(
      jsonl([
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "npm run lint",
            exit_code: 1,
          },
        },
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "A".repeat(150),
          },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 2,
            reasoning_output_tokens: 0,
          },
        },
      ]),
      { maxItems: 2 },
    );

    expect(summary).toBe(
      [
        `- item.completed agent_message: ${"A".repeat(120)}`,
        "- turn.completed usage input=1 cached_input=0 output=2 reasoning_output=0 total=3",
      ].join("\n"),
    );
  });

  it("renders command text as safe markdown with normalized whitespace", () => {
    const summary = summarizeCodexEvents(
      jsonl([
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "-   rm\t\nrf `tmp`",
            exit_code: 1,
          },
        },
      ]),
    );

    expect(summary).toBe(
      "- item.completed command_execution command=`` - rm rf `tmp` `` exit_code=1",
    );
  });

  it("summarizes redaction sentinels with fixed safe text", () => {
    const summary = summarizeCodexEvents(
      jsonl([
        { type: "redaction.failed", reason: "write_failed" },
        { type: "redaction.dropped_line" },
        { type: "redaction.dropped_line" },
      ]),
    );

    expect(summary).toBe(
      [
        "- (events redaction failed - raw events quarantined)",
        "- (2 lines dropped by redaction)",
      ].join("\n"),
    );
  });

  it("counts unparseable lines as summary items", () => {
    const summary = summarizeCodexEvents(
      [
        "{broken-json",
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "after parse failure",
          },
        }),
        "",
      ].join("\n"),
    );

    expect(summary).toBe(
      [
        "- (unparseable line)",
        "- item.completed agent_message: after parse failure",
      ].join("\n"),
    );
  });

  it("returns an empty string for empty or irrelevant content", () => {
    expect(summarizeCodexEvents("")).toBe("");
    expect(
      summarizeCodexEvents(jsonl([{ type: "thread.started" }])),
    ).toBe("");
  });
});
