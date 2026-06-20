import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { recordCodexUsage } from "../../../src/db/repositories/run-usage.js";
import { recordAgentUsage } from "../../../src/db/repositories/agent-usage.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-agent-usage-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function insertRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, updated_at)
     VALUES (?, 'demo', 'apps/web', 'domain-coding', 'main',
       'needs_review', '2026-06-13T00:00:00.000Z')`,
  ).run(runId);
}

function usageEvent(inputTokens: number, outputTokens: number): string {
  return `${JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: 0,
    },
  })}\n`;
}

/** Mirror of the writer's live invocation_id derivation (pins the formula). */
function codexInvocationId(runId: string, role: string, seq: number): string {
  return createHash("sha256")
    .update([runId, role, String(seq)].join("\0"))
    .digest("hex");
}

function countRows(db: Database.Database): {
  runUsage: number;
  invocation: number;
  turn: number;
} {
  const n = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n;
  return {
    runUsage: n("SELECT count(*) AS n FROM run_usage"),
    invocation: n("SELECT count(*) AS n FROM agent_invocation"),
    turn: n("SELECT count(*) AS n FROM agent_usage_turn"),
  };
}

describe("recordCodexUsage forwarder → dual-write (#206)", () => {
  it("writes run_usage byte-identically and mirrors it into agent_invocation + agent_usage_turn", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-1");
      recordCodexUsage({
        db,
        runId: "run-1",
        kind: "coder",
        eventsContent: usageEvent(10, 5),
        now: "2026-06-13T00:00:00.000Z",
      });

      // Legacy run_usage row unchanged (model NULL → no-config byte-stability).
      expect(
        db
          .prepare(
            `SELECT kind, seq, model, input_tokens, cached_input_tokens,
                    output_tokens, reasoning_output_tokens, total_tokens,
                    usage_source, created_at
               FROM run_usage WHERE run_id = ?`,
          )
          .get("run-1"),
      ).toEqual({
        kind: "coder",
        seq: 0,
        model: null,
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
        total_tokens: 15,
        usage_source: "exact",
        created_at: "2026-06-13T00:00:00.000Z",
      });

      const inv = db
        .prepare(
          `SELECT invocation_id, tool, role, model, run_id, invocation_seq,
                  usage_source, created_at, description
             FROM agent_invocation WHERE run_id = ?`,
        )
        .get("run-1") as Record<string, unknown>;
      expect(inv).toEqual({
        invocation_id: codexInvocationId("run-1", "coder", 0),
        tool: "codex",
        role: "coder",
        model: null,
        run_id: "run-1",
        invocation_seq: 0,
        usage_source: "exact",
        created_at: "2026-06-13T00:00:00.000Z",
        description: null,
      });
      expect(String(inv.invocation_id)).toMatch(/^[0-9a-f]{64}$/);

      expect(
        db
          .prepare(
            `SELECT invocation_id, turn_seq, model, input_tokens, output_tokens,
                    total_tokens, cached_input_tokens, reasoning_output_tokens,
                    cache_read_input_tokens, cache_creation_input_tokens,
                    cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
                    usage_source
               FROM agent_usage_turn`,
          )
          .all(),
      ).toEqual([
        {
          invocation_id: codexInvocationId("run-1", "coder", 0),
          turn_seq: 0,
          model: null,
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          cache_creation_5m_input_tokens: null,
          cache_creation_1h_input_tokens: null,
          usage_source: "exact",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps invocation_seq lock-step with run_usage seq per (run, role)", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-1");
      recordCodexUsage({ db, runId: "run-1", kind: "coder", eventsContent: usageEvent(1, 1) });
      recordCodexUsage({ db, runId: "run-1", kind: "coder", eventsContent: usageEvent(2, 2) });
      recordCodexUsage({ db, runId: "run-1", kind: "reviewer", eventsContent: usageEvent(3, 3) });

      const rows = db
        .prepare(
          `SELECT role, invocation_seq, invocation_id
             FROM agent_invocation WHERE run_id = ?
            ORDER BY role, invocation_seq`,
        )
        .all("run-1");
      expect(rows).toEqual([
        { role: "coder", invocation_seq: 0, invocation_id: codexInvocationId("run-1", "coder", 0) },
        { role: "coder", invocation_seq: 1, invocation_id: codexInvocationId("run-1", "coder", 1) },
        { role: "reviewer", invocation_seq: 0, invocation_id: codexInvocationId("run-1", "reviewer", 0) },
      ]);
      // ids distinct (no collision across seq/role)
      expect(new Set(rows.map((r) => (r as { invocation_id: string }).invocation_id)).size).toBe(3);
    } finally {
      db.close();
    }
  });

  it("populates the model column on all three tables only when a model is given", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-1");
      recordCodexUsage({
        db,
        runId: "run-1",
        kind: "coder",
        eventsContent: usageEvent(10, 5),
        model: "gpt-5.5",
      });
      const models = {
        runUsage: (db.prepare("SELECT model FROM run_usage").get() as { model: string }).model,
        invocation: (db.prepare("SELECT model FROM agent_invocation").get() as { model: string }).model,
        turn: (db.prepare("SELECT model FROM agent_usage_turn").get() as { model: string }).model,
      };
      expect(models).toEqual({ runUsage: "gpt-5.5", invocation: "gpt-5.5", turn: "gpt-5.5" });
    } finally {
      db.close();
    }
  });

  it("records an unavailable invocation with a single null turn (backfill 1:1 parity)", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-1");
      recordCodexUsage({ db, runId: "run-1", kind: "coder", eventsContent: null });

      expect(countRows(db)).toEqual({ runUsage: 1, invocation: 1, turn: 1 });
      expect(
        db.prepare("SELECT usage_source, total_tokens FROM run_usage").get(),
      ).toEqual({ usage_source: "unavailable", total_tokens: null });
      expect(
        db
          .prepare(
            "SELECT turn_seq, usage_source, input_tokens FROM agent_usage_turn",
          )
          .get(),
      ).toEqual({ turn_seq: 0, usage_source: "unavailable", input_tokens: null });
    } finally {
      db.close();
    }
  });

  it("keeps per-turn rows for a multi-turn run while summing the legacy row", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-1");
      recordCodexUsage({
        db,
        runId: "run-1",
        kind: "coder",
        eventsContent: `${usageEvent(100, 20).trim()}\n${usageEvent(5, 9).trim()}\n`,
      });
      // legacy run_usage row is the SUM
      expect(
        db.prepare("SELECT input_tokens, output_tokens, total_tokens FROM run_usage").get(),
      ).toEqual({ input_tokens: 105, output_tokens: 29, total_tokens: 134 });
      // two per-turn rows preserve the breakdown
      expect(
        db
          .prepare(
            "SELECT turn_seq, input_tokens, output_tokens FROM agent_usage_turn ORDER BY turn_seq",
          )
          .all(),
      ).toEqual([
        { turn_seq: 0, input_tokens: 100, output_tokens: 20 },
        { turn_seq: 1, input_tokens: 5, output_tokens: 9 },
      ]);
    } finally {
      db.close();
    }
  });

  it("fails open when the guarded write throws — no rows in any of the three tables", () => {
    const db = freshDb();
    const warn = vi.fn();
    try {
      insertRun(db, "run-1");
      expect(() =>
        recordCodexUsage({
          db,
          runId: "run-1",
          kind: "coder",
          eventsContent: usageEvent(10, 5),
          beforeWrite: () => {
            throw new Error("lease lost");
          },
          onError: warn,
        }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(countRows(db)).toEqual({ runUsage: 0, invocation: 0, turn: 0 });
    } finally {
      db.close();
    }
  });

  it("rolls back the legacy run_usage row when a later INSERT in the tx fails (torn-write)", () => {
    const db = freshDb();
    const warn = vi.fn();
    try {
      insertRun(db, "run-1");
      // Pre-seed the agent_invocation row the writer will deterministically
      // target (seq 0) so its INSERT collides on the PK *after* run_usage was
      // already inserted in the same tx — proving both-or-neither atomicity.
      db.prepare(
        `INSERT INTO agent_invocation
           (invocation_id, tool, role, invocation_seq, usage_source, created_at, run_id)
         VALUES (?, 'codex', 'coder', 0, 'exact', '2026-06-13T00:00:00.000Z', 'run-1')`,
      ).run(codexInvocationId("run-1", "coder", 0));

      expect(() =>
        recordCodexUsage({
          db,
          runId: "run-1",
          kind: "coder",
          eventsContent: usageEvent(10, 5),
          onError: warn,
        }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      // run_usage must NOT have been committed despite being inserted first.
      expect(
        (db.prepare("SELECT count(*) AS n FROM run_usage").get() as { n: number }).n,
      ).toBe(0);
      // only the pre-seeded invocation remains
      expect(
        (db.prepare("SELECT count(*) AS n FROM agent_invocation").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("fails open when now is not a valid timestamp", () => {
    const db = freshDb();
    const warn = vi.fn();
    try {
      insertRun(db, "run-1");
      expect(() =>
        recordCodexUsage({
          db,
          runId: "run-1",
          kind: "coder",
          eventsContent: usageEvent(10, 5),
          now: "not-a-date",
          onError: warn,
        }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(countRows(db)).toEqual({ runUsage: 0, invocation: 0, turn: 0 });
    } finally {
      db.close();
    }
  });
});

describe("recordAgentUsage general path (claude/external foundation, #235)", () => {
  it("writes a claude external invocation + turn without touching run_usage", () => {
    const db = freshDb();
    try {
      recordAgentUsage({
        db,
        tool: "claude",
        role: "external",
        runId: null,
        externalLabel: "sub-review",
        sessionId: "sess-1",
        agentId: "agent-1",
        agentType: "reviewer",
        description: "an additional review pass",
        usageSource: "exact",
        now: "2026-06-13T00:00:00.000Z",
        turns: [
          {
            turnSeq: 0,
            model: "claude-opus-4-8",
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 7,
            cacheCreation5mInputTokens: 4,
            cacheCreation1hInputTokens: 3,
            usageSource: "exact",
          },
        ],
      });

      expect(
        (db.prepare("SELECT count(*) AS n FROM run_usage").get() as { n: number }).n,
      ).toBe(0);
      expect(
        db
          .prepare(
            `SELECT invocation_id, tool, role, run_id, session_id, agent_id,
                    agent_type, external_label, description, usage_source
               FROM agent_invocation`,
          )
          .get(),
      ).toEqual({
        invocation_id: "ext:sub-review:external:0",
        tool: "claude",
        role: "external",
        run_id: null,
        session_id: "sess-1",
        agent_id: "agent-1",
        agent_type: "reviewer",
        external_label: "sub-review",
        description: "an additional review pass",
        usage_source: "exact",
      });
      expect(
        db
          .prepare(
            `SELECT cache_read_input_tokens, cache_creation_5m_input_tokens,
                    cached_input_tokens, reasoning_output_tokens
               FROM agent_usage_turn`,
          )
          .get(),
      ).toEqual({
        cache_read_input_tokens: 5,
        cache_creation_5m_input_tokens: 4,
        cached_input_tokens: null,
        reasoning_output_tokens: null,
      });
    } finally {
      db.close();
    }
  });

  it("HARD-TRUNCATEs an over-long description and still writes the row", () => {
    const db = freshDb();
    try {
      recordAgentUsage({
        db,
        tool: "claude",
        role: "external",
        externalLabel: "lbl",
        usageSource: "unavailable",
        description: "x".repeat(10_000),
        turns: [{ turnSeq: 0, usageSource: "unavailable" }],
      });
      const stored = (
        db.prepare("SELECT description FROM agent_invocation").get() as {
          description: string;
        }
      ).description;
      expect(stored.length).toBeLessThanOrEqual(2000);
      expect(stored.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("supports #191-style cross-tool token attribution from the unified tables", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-1");
      // a codex coder turn (run-scoped) + a claude external review turn
      recordCodexUsage({
        db,
        runId: "run-1",
        kind: "coder",
        eventsContent: usageEvent(100, 40),
        model: "gpt-5.5",
      });
      recordAgentUsage({
        db,
        tool: "claude",
        role: "external",
        externalLabel: "sub-review",
        model: "claude-opus-4-8",
        usageSource: "exact",
        turns: [
          {
            turnSeq: 0,
            model: "claude-opus-4-8",
            inputTokens: 20,
            outputTokens: 8,
            totalTokens: 28,
            cacheReadInputTokens: 3,
            usageSource: "exact",
          },
        ],
      });

      // #191 reads usage per (tool, model) across BOTH taxonomies from the
      // single agent_usage_turn surface — the capability Phase-1 unblocks.
      const rows = db
        .prepare(
          `SELECT i.tool AS tool, i.model AS model,
                  SUM(t.input_tokens) AS input, SUM(t.output_tokens) AS output
             FROM agent_usage_turn t
             JOIN agent_invocation i ON i.invocation_id = t.invocation_id
            GROUP BY i.tool, i.model
            ORDER BY i.tool`,
        )
        .all();
      expect(rows).toEqual([
        { tool: "claude", model: "claude-opus-4-8", input: 20, output: 8 },
        { tool: "codex", model: "gpt-5.5", input: 100, output: 40 },
      ]);
    } finally {
      db.close();
    }
  });

  it("fails open on a non-string description rather than throwing to the caller", () => {
    const db = freshDb();
    const warn = vi.fn();
    try {
      expect(() =>
        recordAgentUsage({
          db,
          tool: "claude",
          role: "external",
          externalLabel: "lbl",
          usageSource: "unavailable",
          // defensive: an untyped consumer hands us a non-string
          description: 12345 as unknown as string,
          turns: [{ turnSeq: 0, usageSource: "unavailable" }],
          onError: warn,
        }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(
        (db.prepare("SELECT count(*) AS n FROM agent_invocation").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
