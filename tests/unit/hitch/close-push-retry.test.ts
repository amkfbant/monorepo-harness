import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import {
  classifyAndRecordClosePushFailure,
  MAX_CLOSE_PUSH_ATTEMPTS,
} from "../../../src/hitch/close-push-retry.js";
import { PrPushError, PrGateError } from "../../../src/core/pr-creator.js";
import { LeaseLostError } from "../../../src/workspace/db-domain-lock.js";

// (#396 part 2) The helper is the sole decision point that lets a close push
// deviate from "any throw escalates". It must: only ever retry a transient
// PrPushError; run-scope the budget; escalate permanent / exhaustion; and never
// touch the counter for non-transient outcomes.

function freshDb(): { dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-close-push-"));
  const dbPath = join(dir, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  new HitchRepository(db).createSession({
    hitchId: "h1",
    title: "t",
    projectId: "p",
    domain: "self",
    scope: { targetFiles: ["src/**"], allowedFindingCategories: ["correctness"] },
    closeConditions: [
      { id: "tc", kind: "command", required: true, description: "typecheck" },
    ],
    createdBy: "test",
    createdSource: "cli",
    createdAt: "2026-06-29T00:00:00.000Z",
  });
  db.close();
  return { dbPath };
}

function attempts(dbPath: string): { n: number; runId: string | null } {
  const db = openDb(dbPath);
  const row = db
    .prepare(
      "SELECT close_push_attempts, close_push_run_id FROM hitch_sessions WHERE hitch_id = 'h1'",
    )
    .get() as { close_push_attempts: number; close_push_run_id: string | null };
  db.close();
  return { n: row.close_push_attempts, runId: row.close_push_run_id };
}

const transientPush = () =>
  new PrPushError(
    "git push of b failed: Could not resolve host",
    128,
    "fatal: unable to access ...: Could not resolve host: github.com",
    "",
  );
const permanentPush = () =>
  new PrPushError(
    "git push of b failed: GH006",
    1,
    "remote: error: GH006: Protected branch update failed for refs/heads/main.",
    "",
  );

describe("classifyAndRecordClosePushFailure (#396 part 2)", () => {
  it("transient PrPushError, fresh run → recheck, counter=1, run-scoped", () => {
    const { dbPath } = freshDb();
    const d = classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", transientPush(), false);
    expect(d.kind).toBe("recheck");
    expect(attempts(dbPath)).toEqual({ n: 1, runId: "run-A" });
  });

  it("repeated transient on the SAME run accumulates, then escalates over budget", () => {
    const { dbPath } = freshDb();
    for (let i = 1; i <= MAX_CLOSE_PUSH_ATTEMPTS; i++) {
      const d = classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", transientPush(), false);
      expect(d.kind).toBe("recheck");
      expect(attempts(dbPath).n).toBe(i);
    }
    // the (MAX+1)th transient pushes the counter past the budget → escalate
    const over = classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", transientPush(), false);
    expect(over.kind).toBe("escalate");
    if (over.kind === "escalate") expect(over.reason).toMatch(/exhausted/);
  });

  it("a DIFFERENT run id restarts the budget at 1 (per-episode run-scoping)", () => {
    const { dbPath } = freshDb();
    classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", transientPush(), false);
    classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", transientPush(), false);
    expect(attempts(dbPath).n).toBe(2);
    const d = classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-B", transientPush(), false);
    expect(d.kind).toBe("recheck");
    expect(attempts(dbPath)).toEqual({ n: 1, runId: "run-B" }); // restarted
  });

  it("permanent PrPushError → escalate, counter NOT incremented (classification dominates)", () => {
    const { dbPath } = freshDb();
    const d = classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", permanentPush(), false);
    expect(d.kind).toBe("escalate");
    expect(attempts(dbPath).n).toBe(0);
  });

  it("non-PrPushError (PrGateError / plain Error) → rethrow, no increment", () => {
    const { dbPath } = freshDb();
    expect(classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", new PrGateError("gate"), false).kind).toBe("rethrow");
    expect(classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", new Error("x"), false).kind).toBe("rethrow");
    expect(attempts(dbPath).n).toBe(0);
  });

  it("signalAborted=true with a transient PrPushError → rethrow, no increment", () => {
    const { dbPath } = freshDb();
    const d = classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", transientPush(), true);
    expect(d.kind).toBe("rethrow");
    expect(attempts(dbPath).n).toBe(0);
  });

  it("a lease-loss in the .cause chain → rethrow, no increment", () => {
    const { dbPath } = freshDb();
    const wrapped = new PrPushError("git push failed", 1, "boom", "");
    (wrapped as { cause?: unknown }).cause = new LeaseLostError("self", 7);
    const d = classifyAndRecordClosePushFailure({ dbPath }, "h1", "run-A", wrapped, false);
    expect(d.kind).toBe("rethrow");
    expect(attempts(dbPath).n).toBe(0);
  });
});
