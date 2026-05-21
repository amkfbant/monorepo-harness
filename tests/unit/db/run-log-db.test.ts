import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { createDbRunLog } from "../../../src/db/run-log-db.js";
import type { RunMeta } from "../../../src/logging/run-log.js";

/**
 * Phase 7-3 — DB-first run log. `createDbRunLog` writes the canonical run
 * state to the DB and exports `meta.json` / `events.jsonl` from it.
 */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-runlog-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-runlog-"));
}

function baseMeta(runId: string): RunMeta {
  return {
    runId,
    repoId: "demo",
    repoPath: "/repo",
    domain: "apps/web",
    workflow: "domain-coding",
    baseBranch: "main",
    baseSha: "abc123",
    runBranch: "harness/run",
    status: "running",
    startedAt: "2026-05-22T00:00:00Z",
  };
}

function readMeta(runsDir: string, runId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(runsDir, runId, "meta.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("createDbRunLog", () => {
  it("inserts a db-first run row and exports the initial meta.json", () => {
    const db = freshDb();
    const runsDir = tmpDir();
    createDbRunLog({ db, runsDir, runId: "run-a", meta: baseMeta("run-a") });

    const row = db
      .prepare(
        `SELECT status, source_mode, db_revision, meta_json
         FROM runs WHERE run_id = 'run-a'`,
      )
      .get() as {
      status: string;
      source_mode: string;
      db_revision: number;
      meta_json: string;
    };
    expect(row.status).toBe("running");
    expect(row.source_mode).toBe("db-first");
    expect(row.db_revision).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(row.meta_json).runId).toBe("run-a");
    // meta.json on disk matches the DB
    expect(readMeta(runsDir, "run-a").status).toBe("running");
  });

  it("appends events to the DB and exports events.jsonl", async () => {
    const db = freshDb();
    const runsDir = tmpDir();
    const log = createDbRunLog({
      db,
      runsDir,
      runId: "run-b",
      meta: baseMeta("run-b"),
    });
    await log.emit({ type: "run_started", runId: "run-b" });
    await log.emit({ type: "worktree_created", path: "/wt" });

    const events = db
      .prepare(
        "SELECT seq, type FROM run_events WHERE run_id = 'run-b' ORDER BY seq",
      )
      .all() as { seq: number; type: string }[];
    expect(events).toEqual([
      { seq: 1, type: "run_started" },
      { seq: 2, type: "worktree_created" },
    ]);
    const lines = readFileSync(join(runsDir, "run-b", "events.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).type).toBe("run_started");
  });

  it("setStatus / setSafetyStatus update the run row and meta.json", async () => {
    const db = freshDb();
    const runsDir = tmpDir();
    const log = createDbRunLog({
      db,
      runsDir,
      runId: "run-c",
      meta: baseMeta("run-c"),
    });
    await log.setStatus("generated");
    await log.setSafetyStatus("allowed");

    const row = db
      .prepare(
        "SELECT status, safety_status, export_status FROM runs WHERE run_id = 'run-c'",
      )
      .get() as {
      status: string;
      safety_status: string;
      export_status: string;
    };
    expect(row.status).toBe("generated");
    expect(row.safety_status).toBe("allowed");
    // the export ran after each write — the run is in sync with its files
    expect(row.export_status).toBe("synced");
    const meta = readMeta(runsDir, "run-c");
    expect(meta.status).toBe("generated");
    expect(meta.safetyStatus).toBe("allowed");
  });

  it("finalize writes command_results and the final meta fields", async () => {
    const db = freshDb();
    const runsDir = tmpDir();
    const log = createDbRunLog({
      db,
      runsDir,
      runId: "run-d",
      meta: baseMeta("run-d"),
    });
    await log.finalize({
      status: "needs_review",
      safetyStatus: "allowed",
      ignoredUntrackedCount: 0,
      secretSuspectCount: 0,
      commandResults: [
        { command: "npm test", exitCode: 0, durationMs: 1200, timedOut: false },
      ],
      changedFilesCount: 4,
      finishedAt: "2026-05-22T00:05:00Z",
    });

    const cmd = db
      .prepare(
        "SELECT command, exit_code FROM command_results WHERE run_id = 'run-d'",
      )
      .get() as { command: string; exit_code: number };
    expect(cmd).toEqual({ command: "npm test", exit_code: 0 });
    const meta = readMeta(runsDir, "run-d");
    expect(meta.status).toBe("needs_review");
    expect(meta.changedFilesCount).toBe(4);
    expect(meta.finishedAt).toBe("2026-05-22T00:05:00Z");
  });

  it("exports lossless meta.json — full project provenance and reviewed", async () => {
    const db = freshDb();
    const runsDir = tmpDir();
    const meta: RunMeta = {
      ...baseMeta("run-e"),
      project: {
        projectId: "demo",
        profilePath: "projects/demo.yaml",
        profileVersion: 3,
        policyTemplateId: "strict-monorepo-v1",
        commandPresetIds: ["node-test"],
        contextPackIds: ["pack-a"],
      },
    };
    const log = createDbRunLog({ db, runsDir, runId: "run-e", meta });
    await log.finalize({
      status: "needs_review",
      safetyStatus: "allowed",
      ignoredUntrackedCount: 0,
      secretSuspectCount: 0,
      commandResults: [],
      changedFilesCount: 1,
      reviewed: { paths: ["apps/web/x.ts"], fingerprint: "fp-1" },
      finishedAt: "2026-05-22T00:05:00Z",
    });
    // fields the flattened runs columns cannot hold still round-trip,
    // because meta_json stores the canonical document verbatim.
    const exported = readMeta(runsDir, "run-e");
    expect(exported.project).toEqual(meta.project);
    expect(exported.reviewed).toEqual({
      paths: ["apps/web/x.ts"],
      fingerprint: "fp-1",
    });
  });

  it("leaves the run at the last completed stage after a crash", async () => {
    const db = freshDb();
    const runsDir = tmpDir();
    const log = createDbRunLog({
      db,
      runsDir,
      runId: "run-f",
      meta: baseMeta("run-f"),
    });
    await log.emit({ type: "run_started", runId: "run-f" });
    await log.setStatus("generated");
    // simulate a crash here — no finalize. The run row must be sane.
    const row = db
      .prepare("SELECT status, finished_at FROM runs WHERE run_id = 'run-f'")
      .get() as { status: string; finished_at: string | null };
    expect(row.status).toBe("generated");
    expect(row.finished_at).toBeNull();
  });
});
