import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { RunRepository } from "../../../src/db/repositories/runs.js";
import { recordRunArtifacts } from "../../../src/db/run-artifacts.js";
import { beginExporting } from "../../../src/db/atomic-write.js";
import { StateConflictError } from "../../../src/db/errors.js";

/**
 * Phase 7-4 — the diff-verification result tables (`run_changed_files` /
 * `policy_violations`, deferred in Phase 6) and the artifact manifest.
 */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-results-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function insertRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, updated_at, source_mode)
     VALUES (?, 'demo', 'apps/web', 'domain-coding', 'main', 'needs_review',
       'x', 'db-first')`,
  ).run(runId);
}

describe("RunRepository.upsertChangedFiles", () => {
  it("inserts changed files and replaces on a re-run", () => {
    const db = freshDb();
    insertRun(db, "run-a");
    const repo = new RunRepository(db);
    repo.upsertChangedFiles("run-a", [
      { path: "a.ts", status: "tracked", allowed: true, source: "post-codex" },
      { path: "b.ts", status: "untracked", allowed: false, source: "post-codex" },
    ]);
    let rows = db
      .prepare(
        "SELECT path, status, allowed FROM run_changed_files WHERE run_id='run-a' ORDER BY path",
      )
      .all() as { path: string; status: string; allowed: number }[];
    expect(rows).toEqual([
      { path: "a.ts", status: "tracked", allowed: 1 },
      { path: "b.ts", status: "untracked", allowed: 0 },
    ]);
    // a second call replaces the prior set
    repo.upsertChangedFiles("run-a", [
      { path: "c.ts", status: "tracked", allowed: true, source: "post-command" },
    ]);
    rows = db
      .prepare("SELECT path FROM run_changed_files WHERE run_id='run-a'")
      .all() as { path: string; status: string; allowed: number }[];
    expect(rows.map((r) => r.path)).toEqual(["c.ts"]);
    db.close();
  });
});

describe("RunRepository.upsertViolations", () => {
  it("inserts violations and dedups a repeated (path, rule)", () => {
    const db = freshDb();
    insertRun(db, "run-b");
    const repo = new RunRepository(db);
    repo.upsertViolations("run-b", [
      { path: "x.ts", rule: "deny_write" },
      { path: "y.ts", rule: "not_in_write_scope" },
      { path: "x.ts", rule: "deny_write" }, // duplicate — absorbed by the PK
    ]);
    const rows = db
      .prepare(
        "SELECT path, rule FROM policy_violations WHERE run_id='run-b' ORDER BY path",
      )
      .all() as { path: string; rule: string }[];
    expect(rows).toEqual([
      { path: "x.ts", rule: "deny_write" },
      { path: "y.ts", rule: "not_in_write_scope" },
    ]);
    // replace semantics
    repo.upsertViolations("run-b", []);
    expect(
      (
        db
          .prepare("SELECT count(*) AS n FROM policy_violations WHERE run_id='run-b'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
    db.close();
  });
});

describe("RunRepository.applyReviewDecision", () => {
  it("transitions needs_review and records the decision", () => {
    const db = freshDb();
    insertRun(db, "run-r");
    const repo = new RunRepository(db);
    const res = repo.applyReviewDecision({
      runId: "run-r",
      newStatus: "changes_requested",
      decision: "changes_requested",
      reviewer: "alice",
      reviewedAt: "2026-05-22T01:00:00Z",
      requiredChanges: ["fix the thing"],
      decisionYaml: "decision: changes_requested\n",
    });
    expect(res.previousStatus).toBe("needs_review");
    expect(
      (
        db
          .prepare("SELECT status FROM runs WHERE run_id = 'run-r'")
          .get() as { status: string }
      ).status,
    ).toBe("changes_requested");
    const change = db
      .prepare(
        "SELECT change_text FROM review_required_changes WHERE run_id = 'run-r'",
      )
      .get() as { change_text: string };
    expect(change.change_text).toBe("fix the thing");
  });

  it("guards against a run that already left needs_review", () => {
    const db = freshDb();
    insertRun(db, "run-s");
    const repo = new RunRepository(db);
    const apply = (): unknown =>
      repo.applyReviewDecision({
        runId: "run-s",
        newStatus: "approved",
        decision: "approved",
        reviewer: null,
        reviewedAt: "2026-05-22T01:00:00Z",
        requiredChanges: [],
        decisionYaml: "decision: approved\n",
      });
    apply();
    expect(apply).toThrow(StateConflictError);
    db.close();
  });
});

describe("recordRunArtifacts", () => {
  it("records the run-dir files and skips dotfiles", () => {
    const db = freshDb();
    insertRun(db, "run-c");
    const dir = mkdtempSync(join(tmpdir(), "harness-runc-"));
    writeFileSync(join(dir, "meta.json"), "{}\n");
    writeFileSync(join(dir, "summary.md"), "# s\n");
    beginExporting(dir); // leaves a .exporting dotfile

    recordRunArtifacts(db, dir, "run-c");
    const rows = db
      .prepare(
        "SELECT relative_path, kind FROM artifacts WHERE run_id='run-c' ORDER BY relative_path",
      )
      .all() as { relative_path: string; kind: string }[];
    expect(rows).toEqual([
      { relative_path: "meta.json", kind: "meta" },
      { relative_path: "summary.md", kind: "summary" },
    ]);

    // a second call replaces the manifest
    writeFileSync(join(dir, "extra.log"), "log\n");
    recordRunArtifacts(db, dir, "run-c");
    expect(
      (
        db
          .prepare("SELECT count(*) AS n FROM artifacts WHERE run_id='run-c'")
          .get() as { n: number }
      ).n,
    ).toBe(3);
    db.close();
  });
});
