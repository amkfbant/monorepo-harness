import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { recordCodexUsage } from "../../../src/db/repositories/run-usage.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-run-usage-"));
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

describe("recordCodexUsage", () => {
  it("allocates seq per run and kind while recording codex turn usage", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-usage");

      recordCodexUsage({
        db,
        runId: "run-usage",
        kind: "coder",
        eventsContent: usageEvent(10, 5),
        now: "2026-06-13T00:00:00.000Z",
      });
      recordCodexUsage({
        db,
        runId: "run-usage",
        kind: "coder",
        eventsContent: usageEvent(2, 3),
        now: "2026-06-13T00:00:01.000Z",
      });
      recordCodexUsage({
        db,
        runId: "run-usage",
        kind: "reviewer",
        eventsContent: usageEvent(7, 1),
        now: "2026-06-13T00:00:02.000Z",
      });

      const rows = db
        .prepare(
          `SELECT kind, seq, input_tokens, output_tokens, total_tokens,
                  usage_source, created_at
             FROM run_usage
            WHERE run_id = ?
            ORDER BY kind, seq`,
        )
        .all("run-usage");
      expect(rows).toEqual([
        {
          kind: "coder",
          seq: 0,
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          usage_source: "exact",
          created_at: "2026-06-13T00:00:00.000Z",
        },
        {
          kind: "coder",
          seq: 1,
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
          usage_source: "exact",
          created_at: "2026-06-13T00:00:01.000Z",
        },
        {
          kind: "reviewer",
          seq: 0,
          input_tokens: 7,
          output_tokens: 1,
          total_tokens: 8,
          usage_source: "exact",
          created_at: "2026-06-13T00:00:02.000Z",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("fails open when the guarded usage write cannot be recorded", () => {
    const db = freshDb();
    const warn = vi.fn();
    try {
      insertRun(db, "run-usage");

      expect(() =>
        recordCodexUsage({
          db,
          runId: "run-usage",
          kind: "coder",
          eventsContent: usageEvent(10, 5),
          beforeWrite: () => {
            throw new Error("lease lost");
          },
          onError: warn,
        }),
      ).not.toThrow();

      expect(warn).toHaveBeenCalledOnce();
      const rowCount = db
        .prepare("SELECT count(*) AS n FROM run_usage WHERE run_id = ?")
        .get("run-usage") as { n: number };
      expect(rowCount.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
