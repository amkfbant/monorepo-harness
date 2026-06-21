import { describe, it, expect } from "vitest";
import { freshDb } from "./_agent-usage-helpers.js";
import { recordClaudeUsage } from "../../../src/db/repositories/claude-usage.js";

const STREAM = (turns: Array<Record<string, number>>): string =>
  turns
    .map((u, i) =>
      JSON.stringify({
        type: "assistant",
        message: { id: `m${i}`, model: "claude-opus-4-8", usage: u },
      }),
    )
    .concat(JSON.stringify({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 999 } }))
    .join("\n");

function invocationRow(db: import("better-sqlite3").Database) {
  return db
    .prepare(
      "SELECT tool, role, run_id, model, usage_source FROM agent_invocation",
    )
    .get() as {
    tool: string;
    role: string;
    run_id: string | null;
    model: string | null;
    usage_source: string;
  };
}

describe("recordClaudeUsage", () => {
  it("records a claude internal coder invocation with per-turn claude usage from stream-json", () => {
    const db = freshDb();
    recordClaudeUsage({
      db,
      runId: "run-1",
      kind: "coder",
      model: "claude-opus-4-8",
      eventsContent: STREAM([
        { input_tokens: 4, output_tokens: 101, cache_read_input_tokens: 700, cache_creation_input_tokens: 20 },
      ]),
      onError: (e) => {
        throw e;
      },
    });
    const inv = invocationRow(db);
    expect(inv.tool).toBe("claude");
    expect(inv.role).toBe("coder");
    expect(inv.run_id).toBe("run-1");
    expect(inv.usage_source).toBe("exact");
    const turns = db
      .prepare(
        "SELECT input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cached_input_tokens, reasoning_output_tokens, usage_source FROM agent_usage_turn",
      )
      .all() as Array<Record<string, number | null | string>>;
    expect(turns).toHaveLength(1);
    expect(turns[0].input_tokens).toBe(4);
    expect(turns[0].output_tokens).toBe(101);
    expect(turns[0].cache_read_input_tokens).toBe(700);
    expect(turns[0].cache_creation_input_tokens).toBe(20);
    // XOR CHECK: codex-only columns stay NULL on a claude row.
    expect(turns[0].cached_input_tokens).toBeNull();
    expect(turns[0].reasoning_output_tokens).toBeNull();
    expect(turns[0].usage_source).toBe("exact");
  });

  it("does NOT write a legacy run_usage row (run_usage stays codex-only / byte-stable)", () => {
    const db = freshDb();
    recordClaudeUsage({
      db,
      runId: "run-2",
      kind: "reviewer",
      eventsContent: STREAM([{ input_tokens: 1, output_tokens: 1 }]),
      onError: (e) => {
        throw e;
      },
    });
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM run_usage WHERE run_id = ?").get("run-2") as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
  });

  it("records an unavailable invocation (one synthetic null turn) when the stream carries no usage", () => {
    const db = freshDb();
    recordClaudeUsage({
      db,
      runId: "run-3",
      kind: "evaluator",
      eventsContent: '{"type":"result","subtype":"success","result":"x"}\n',
      onError: (e) => {
        throw e;
      },
    });
    expect(invocationRow(db).usage_source).toBe("unavailable");
    const turns = db
      .prepare("SELECT input_tokens, usage_source FROM agent_usage_turn")
      .all() as Array<{ input_tokens: number | null; usage_source: string }>;
    expect(turns).toHaveLength(1);
    expect(turns[0].input_tokens).toBeNull();
    expect(turns[0].usage_source).toBe("unavailable");
  });

  it("is fail-open: a write error reaches onError without throwing", () => {
    const db = freshDb();
    db.close(); // force the write to fail
    let captured: unknown;
    expect(() =>
      recordClaudeUsage({
        db,
        runId: "run-4",
        kind: "coder",
        eventsContent: STREAM([{ input_tokens: 1, output_tokens: 1 }]),
        onError: (e) => {
          captured = e;
        },
      }),
    ).not.toThrow();
    expect(captured).toBeDefined();
  });
});
