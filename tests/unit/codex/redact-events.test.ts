import { describe, expect, it } from "vitest";
import { redactCodexEvents } from "../../../src/codex/redact-events.js";

function jsonl(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n").concat("\n");
}

describe("redactCodexEvents", () => {
  it("redacts secret-shaped command aggregated output", () => {
    const content = jsonl([
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: "AWS key AKIAABCDEFGHIJKLMNOP appeared\n",
        },
      },
    ]);

    const result = redactCodexEvents(content);
    const redacted = JSON.parse(result.content.trim()) as {
      item: { aggregated_output: string };
    };

    expect(result.redactedCount).toBe(1);
    expect(result.droppedCount).toBe(0);
    expect(redacted.item.aggregated_output).toBe(
      "[redacted: secret-suspect (content:aws-access-key-id)]",
    );
    expect(result.content).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  it("redacts secret-shaped output beyond the first scan sample", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const content = jsonl([
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: `${"x".repeat(40 * 1024)}\n${secret}\n`,
        },
      },
    ]);

    const result = redactCodexEvents(content);

    expect(result.redactedCount).toBe(1);
    expect(result.content).toContain(
      "[redacted: secret-suspect (content:aws-access-key-id)]",
    );
    expect(result.content).not.toContain(secret);
  });

  it("redacts secret-shaped agent message text", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const content = jsonl([
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: `the key is ${secret}`,
        },
      },
    ]);

    const result = redactCodexEvents(content);
    const redacted = JSON.parse(result.content.trim()) as {
      item: { text: string };
    };

    expect(result.redactedCount).toBe(1);
    expect(result.droppedCount).toBe(0);
    expect(redacted.item.text).toBe(
      "[redacted: secret-suspect (content:aws-access-key-id)]",
    );
    expect(result.content).not.toContain(secret);
  });

  it("redacts secret-shaped command summary string fields", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const content = jsonl([
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: `npm test ${secret}`,
          command_name: `lint ${secret}`,
          name: `build ${secret}`,
        },
      },
    ]);

    const result = redactCodexEvents(content);
    const redacted = JSON.parse(result.content.trim()) as {
      item: { command: string; command_name: string; name: string };
    };

    expect(result.redactedCount).toBe(1);
    expect(redacted.item.command).toBe(
      "[redacted: secret-suspect (content:aws-access-key-id)]",
    );
    expect(redacted.item.command_name).toBe(
      "[redacted: secret-suspect (content:aws-access-key-id)]",
    );
    expect(redacted.item.name).toBe(
      "[redacted: secret-suspect (content:aws-access-key-id)]",
    );
    expect(result.content).not.toContain(secret);
  });

  it("leaves clean agent message text unchanged", () => {
    const content = jsonl([
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "The implementation looks correct.",
        },
      },
    ]);

    expect(redactCodexEvents(content)).toEqual({
      content,
      redactedCount: 0,
      droppedCount: 0,
    });
  });

  it("drops unparsable JSONL lines fail-closed", () => {
    const result = redactCodexEvents(
      [
        JSON.stringify({ type: "thread.started" }),
        "{not-json",
        JSON.stringify({ type: "turn.started" }),
        "",
      ].join("\n"),
    );

    const lines = result.content.trim().split("\n");

    expect(result.redactedCount).toBe(0);
    expect(result.droppedCount).toBe(1);
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      type: "redaction.dropped_line",
    });
  });

  it("leaves turn usage events unchanged", () => {
    const content = jsonl([
      {
        type: "turn.completed",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 2,
          output_tokens: 7,
          reasoning_output_tokens: 3,
        },
      },
    ]);

    expect(redactCodexEvents(content)).toEqual({
      content,
      redactedCount: 0,
      droppedCount: 0,
    });
  });

  it("leaves clean events unchanged", () => {
    const content = jsonl([
      { type: "thread.started", thread_id: "thread-test" },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: "npm test passed\n",
        },
      },
    ]);

    expect(redactCodexEvents(content)).toEqual({
      content,
      redactedCount: 0,
      droppedCount: 0,
    });
  });
});
