import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  ReviewOverridesRepository,
  OverrideReasonRequiredError,
} from "../../../src/db/repositories/review-overrides.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-revovr-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, source_mode, db_revision, export_status, started_at,
       updated_at, meta_json)
     VALUES ('run-test', 't', 'apps/user', 'domain-coding', 'main',
       'needs_review', 'db-first', 1, 'disabled',
       '2026-05-24T00:00:00Z', '2026-05-24T00:00:00Z', '{}')`,
  ).run();
  return db;
}

describe("ReviewOverridesRepository (Phase 11-6)", () => {
  it("insert appends an audit row with actor / decision / reason", () => {
    const db = freshDb();
    try {
      const repo = new ReviewOverridesRepository(db);
      const r = repo.insert({
        runId: "run-test",
        actorReviewerId: "human",
        decision: "approved",
        reason: "Critical hotfix",
        now: new Date("2026-05-24T11:00:00Z"),
      });
      expect(r.actorReviewerId).toBe("human");
      expect(r.decision).toBe("approved");
      expect(r.reason).toBe("Critical hotfix");
      expect(repo.findLatest("run-test")?.overrideId).toBe(r.overrideId);
    } finally {
      db.close();
    }
  });

  it("insert throws OverrideReasonRequiredError when reason is empty / whitespace", () => {
    const db = freshDb();
    try {
      const repo = new ReviewOverridesRepository(db);
      expect(() =>
        repo.insert({
          runId: "run-test",
          actorReviewerId: "human",
          decision: "approved",
          reason: "",
        }),
      ).toThrow(OverrideReasonRequiredError);
      expect(() =>
        repo.insert({
          runId: "run-test",
          actorReviewerId: "human",
          decision: "approved",
          reason: "   \t  ",
        }),
      ).toThrow(OverrideReasonRequiredError);
    } finally {
      db.close();
    }
  });

  it("listForRun is append-only — subsequent overrides do not delete prior rows", () => {
    const db = freshDb();
    try {
      const repo = new ReviewOverridesRepository(db);
      repo.insert({
        runId: "run-test",
        actorReviewerId: "human",
        decision: "changes_requested",
        reason: "needs more tests",
        now: new Date("2026-05-24T11:00:00Z"),
      });
      repo.insert({
        runId: "run-test",
        actorReviewerId: "system",
        decision: "approved",
        reason: "overrule",
        now: new Date("2026-05-24T12:00:00Z"),
      });
      const all = repo.listForRun("run-test");
      expect(all).toHaveLength(2);
      expect(all[0]?.decision).toBe("changes_requested");
      expect(all[1]?.decision).toBe("approved");
      expect(repo.findLatest("run-test")?.decision).toBe("approved");
    } finally {
      db.close();
    }
  });
});
