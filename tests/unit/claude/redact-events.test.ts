import { describe, it, expect } from "vitest";
import { redactClaudeEvents } from "../../../src/claude/redact-events.js";

// A high-entropy token that secret-scan flags. (AWS-style access key id is a
// stable, well-known secret-scan trigger.)
const SECRET = "AKIAIOSFODNN7EXAMPLE";

describe("redactClaudeEvents", () => {
  it("redacts a secret echoed in a tool_result (the S4 command-output leak surface)", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            is_error: false,
            content: `printed the key: ${SECRET}`,
          },
        ],
      },
    });
    const out = redactClaudeEvents(line + "\n");
    expect(out.content).not.toContain(SECRET);
    expect(out.content).toContain("[redacted:");
    expect(out.redactedCount).toBe(1);
  });

  it("redacts a secret inside a tool_use Bash command (input.command)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: `echo ${SECRET}`, description: "leak" },
          },
        ],
      },
    });
    const out = redactClaudeEvents(line + "\n");
    expect(out.content).not.toContain(SECRET);
    expect(out.redactedCount).toBe(1);
  });

  it("redacts a secret NESTED in a tool_use input (recursive, fail-closed vs shape drift) (P2)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "SomeTool",
            input: { edits: [{ payload: { token: SECRET } }] },
          },
        ],
      },
    });
    const out = redactClaudeEvents(line + "\n");
    expect(out.content).not.toContain(SECRET);
    expect(out.redactedCount).toBe(1);
  });

  it("redacts a secret in the final result message", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: `here is the key ${SECRET}`,
    });
    const out = redactClaudeEvents(line + "\n");
    expect(out.content).not.toContain(SECRET);
    expect(out.redactedCount).toBe(1);
  });

  it("redacts a secret in an array-shaped tool_result content", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: `key=${SECRET}` }],
          },
        ],
      },
    });
    const out = redactClaudeEvents(line + "\n");
    expect(out.content).not.toContain(SECRET);
    expect(out.redactedCount).toBe(1);
  });

  it("passes clean events through verbatim and preserves the trailing newline", () => {
    const a = JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" });
    const b = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "no secrets here" }] },
    });
    const input = a + "\n" + b + "\n";
    const out = redactClaudeEvents(input);
    expect(out.content).toBe(input);
    expect(out.redactedCount).toBe(0);
    expect(out.droppedCount).toBe(0);
  });

  it("drops an unparseable line fail-closed (never emits the raw line)", () => {
    const out = redactClaudeEvents("{not json\n");
    expect(out.content).toContain("redaction.dropped_line");
    expect(out.content).not.toContain("{not json");
    expect(out.droppedCount).toBe(1);
  });

  it("is a total function on empty input", () => {
    expect(redactClaudeEvents("")).toEqual({
      content: "",
      redactedCount: 0,
      droppedCount: 0,
    });
  });
});
