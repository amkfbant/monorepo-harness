import { describe, it, expect } from "vitest";
import { subagentUsageSummary } from "../../../src/db/repositories/subagent-usage.js";
import {
  freshDb,
  writeClaudeExternal,
  writeClaudeInternal,
} from "./_agent-usage-helpers.js";

const TURN = {
  turnSeq: 0,
  model: "claude-opus-4-8",
  usageSource: "parsed_log" as const,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadInputTokens: 5,
  cacheCreationInputTokens: 3,
  totalTokens: 30,
  cacheCreation5mInputTokens: 2,
  cacheCreation1hInputTokens: 1,
};

describe("subagentUsageSummary", () => {
  it("returns zero-shaped summary when empty", () => {
    const s = subagentUsageSummary(freshDb());
    expect(s.rows).toEqual([]);
    expect(s.totals.totalTokens).toBe(0);
  });
  it("sums parsed_log rows to NON-ZERO (no exact-only filter)", () => {
    const db = freshDb();
    writeClaudeExternal(db, {
      sessionId: "s1",
      agentId: "a1",
      agentType: "code-reviewer",
      model: "claude-opus-4-8",
      turns: [TURN],
    });
    const s = subagentUsageSummary(db);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].agentType).toBe("code-reviewer");
    // would be 0 under an exact-only filter — regression guard
    expect(s.rows[0].inputTokens).toBe(10);
    expect(s.rows[0].invocations).toBe(1);
    expect(s.totals.outputTokens).toBe(20);
    // [P2] cache columns must be read back non-zero (fixture sets 5/3)
    expect(s.rows[0].cacheReadInputTokens).toBeGreaterThan(0);
    expect(s.rows[0].cacheCreationInputTokens).toBeGreaterThan(0);
    // [P1] totalTokens must be non-zero (writer stores 30, reader SUMs it)
    expect(s.rows[0].totalTokens).toBeGreaterThan(0);
    expect(s.totals.totalTokens).toBeGreaterThan(0);
  });
  it("default role=external excludes internal rows; roles param includes them (Phase-4 ready)", () => {
    const db = freshDb();
    writeClaudeInternal(db, {
      runId: "r1",
      role: "reviewer",
      model: "claude-opus-4-8",
      turns: [{ ...TURN, usageSource: "exact" }],
    });
    expect(subagentUsageSummary(db).rows).toHaveLength(0);
    expect(subagentUsageSummary(db, { roles: ["reviewer"] }).rows).toHaveLength(
      1,
    );
  });
});
