import { describe, it, expect } from "vitest";
import { codexUsageSummary } from "../../../src/db/repositories/codex-usage.js";
import { freshDb } from "./_agent-usage-helpers.js";
import {
  recordAgentUsage,
  type AgentUsageTurnInput,
} from "../../../src/db/repositories/agent-usage.js";

function codexTurn(over: Partial<AgentUsageTurnInput> = {}): AgentUsageTurnInput {
  return {
    turnSeq: 0,
    model: "gpt-5.5",
    usageSource: "exact",
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 60,
    reasoningOutputTokens: 25,
    totalTokens: 160,
    ...over,
  };
}

/**
 * Seed one external codex invocation (tool='codex', role='external'). codex rows
 * MUST leave session_id/agent_id NULL (DB CHECK) and may leave run_id NULL (the
 * role='external' CHECK exemption). onError throws so fixture failures are loud.
 */
function writeCodexExternal(
  db: ReturnType<typeof freshDb>,
  a: {
    courseId?: string | null;
    hitchId?: string | null;
    externalLabel?: string | null;
    runId?: string | null;
    now?: string;
    turns?: AgentUsageTurnInput[];
  },
): void {
  const turns = a.turns ?? [codexTurn()];
  recordAgentUsage({
    db,
    tool: "codex",
    role: "external",
    usageSource: turns[0]?.usageSource ?? "exact",
    courseId: a.courseId,
    hitchId: a.hitchId,
    externalLabel: a.externalLabel,
    runId: a.runId,
    ...(a.now !== undefined ? { now: a.now } : {}),
    turns,
    onError: (e) => {
      throw e;
    },
  });
}

describe("codexUsageSummary", () => {
  it("returns zero-shaped summary when empty", () => {
    const s = codexUsageSummary(freshDb());
    expect(s.rows).toEqual([]);
    expect(s.totals.invocations).toBe(0);
    expect(s.totals.totalTokens).toBe(0);
  });

  it("aggregates external codex with the codex token taxonomy", () => {
    const db = freshDb();
    writeCodexExternal(db, {
      courseId: "c1",
      hitchId: "h1",
      externalLabel: "L1",
    });
    const s = codexUsageSummary(db);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toEqual({
      courseId: "c1",
      hitchId: "h1",
      externalLabel: "L1",
      invocations: 1,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 60,
      reasoningOutputTokens: 25,
      totalTokens: 160,
    });
  });

  it("sums multiple invocations in the same course/hitch/label group", () => {
    const db = freshDb();
    writeCodexExternal(db, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    writeCodexExternal(db, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    const s = codexUsageSummary(db);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].invocations).toBe(2);
    expect(s.rows[0].inputTokens).toBe(200);
    expect(s.rows[0].totalTokens).toBe(320);
    expect(s.totals.invocations).toBe(2);
    expect(s.totals.reasoningOutputTokens).toBe(50);
  });

  it("groups distinct course/hitch/label combinations into separate rows incl. NULL, ordered by totalTokens DESC", () => {
    const db = freshDb();
    writeCodexExternal(db, {
      courseId: "c1",
      hitchId: "h1",
      externalLabel: "L1",
      turns: [codexTurn({ totalTokens: 300 })],
    });
    writeCodexExternal(db, {
      courseId: "c1",
      hitchId: "h2",
      externalLabel: "L1",
      turns: [codexTurn({ totalTokens: 200 })],
    });
    writeCodexExternal(db, {
      courseId: null,
      hitchId: null,
      externalLabel: "L2",
      turns: [codexTurn({ totalTokens: 100 })],
    });
    const s = codexUsageSummary(db);
    expect(s.rows).toHaveLength(3);
    expect(s.rows.map((r) => r.totalTokens)).toEqual([300, 200, 100]);
    const nullRow = s.rows.find(
      (r) => r.courseId === null && r.hitchId === null,
    );
    expect(nullRow?.externalLabel).toBe("L2");
  });

  it("narrows by course / hitch / label", () => {
    const db = freshDb();
    writeCodexExternal(db, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    writeCodexExternal(db, { courseId: "c1", hitchId: "h2", externalLabel: "L1" });
    writeCodexExternal(db, { courseId: "c2", hitchId: "h3", externalLabel: "L2" });
    expect(codexUsageSummary(db, { hitch: "h1" }).rows).toHaveLength(1);
    expect(codexUsageSummary(db, { course: "c1" }).rows).toHaveLength(2);
    expect(codexUsageSummary(db, { label: "L2" }).rows).toHaveLength(1);
    expect(
      codexUsageSummary(db, { course: "c1", hitch: "h2" }).rows,
    ).toHaveLength(1);
  });

  it("filters by since (created_at >= iso)", () => {
    const db = freshDb();
    writeCodexExternal(db, {
      courseId: "old",
      externalLabel: "L1",
      now: "2026-01-01T00:00:00.000Z",
    });
    writeCodexExternal(db, {
      courseId: "new",
      externalLabel: "L1",
      now: "2026-06-01T00:00:00.000Z",
    });
    const s = codexUsageSummary(db, { since: "2026-03-01T00:00:00.000Z" });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].courseId).toBe("new");
  });

  it("does NOT apply an exact-only usage_source filter (parsed_log rows count)", () => {
    const db = freshDb();
    writeCodexExternal(db, {
      courseId: "c1",
      externalLabel: "L1",
      turns: [codexTurn({ usageSource: "parsed_log" })],
    });
    const s = codexUsageSummary(db);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].totalTokens).toBe(160);
  });

  it("excludes internal codex (role!=external) and claude rows", () => {
    const db = freshDb();
    writeCodexExternal(db, { courseId: "c1", hitchId: "h1", externalLabel: "L1" });
    // internal codex coder (run-scoped) — excluded by role='external'
    recordAgentUsage({
      db,
      tool: "codex",
      role: "coder",
      runId: "run-1",
      usageSource: "exact",
      turns: [codexTurn()],
      onError: (e) => {
        throw e;
      },
    });
    // claude external subagent — excluded by tool='codex'
    recordAgentUsage({
      db,
      tool: "claude",
      role: "external",
      externalLabel: "ops-subagent",
      sessionId: "s1",
      agentId: "a1",
      usageSource: "parsed_log",
      turns: [
        {
          turnSeq: 0,
          model: "claude-opus-4-8",
          inputTokens: 5,
          outputTokens: 5,
          totalTokens: 10,
          usageSource: "parsed_log",
        },
      ],
      onError: (e) => {
        throw e;
      },
    });
    const s = codexUsageSummary(db);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].courseId).toBe("c1");
    expect(s.totals.invocations).toBe(1);
  });
});
