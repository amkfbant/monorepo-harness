import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { RunRepository } from "../../../src/db/repositories/runs.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-runrepo-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

interface RunSpec {
  runId: string;
  repoId: string;
  projectId?: string | null;
  domain?: string;
  status?: string;
  startedAt?: string;
  parentRunId?: string | null;
  rootRunId?: string | null;
  rerunAttempt?: number | null;
}

function insertRun(db: Database.Database, s: RunSpec): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, project_id, domain, workflow,
       base_branch, status, started_at, parent_run_id, root_run_id,
       rerun_attempt, source_meta_sha256, updated_at)
     VALUES (@run_id, @repo_id, @project_id, @domain, 'domain-coding',
       'main', @status, @started_at, @parent_run_id, @root_run_id,
       @rerun_attempt, 'x', '2026-05-22T00:00:00Z')`,
  ).run({
    run_id: s.runId,
    repo_id: s.repoId,
    project_id: s.projectId ?? null,
    domain: s.domain ?? "apps/web",
    status: s.status ?? "needs_review",
    started_at: s.startedAt ?? "2026-05-21T00:00:00Z",
    parent_run_id: s.parentRunId ?? null,
    root_run_id: s.rootRunId ?? null,
    rerun_attempt: s.rerunAttempt ?? null,
  });
}

describe("RunRepository.listRuns", () => {
  let db: Database.Database;
  let repo: RunRepository;
  beforeEach(() => {
    db = freshDb();
    repo = new RunRepository(db);
    // two projects sharing the domain id apps/web, plus a legacy repo-id run
    insertRun(db, {
      runId: "run-a",
      repoId: "demo",
      projectId: "demo",
      domain: "apps/web",
      status: "approved",
      startedAt: "2026-05-21T03:00:00Z",
    });
    insertRun(db, {
      runId: "run-b",
      repoId: "other",
      projectId: "other",
      domain: "apps/web",
      status: "needs_review",
      startedAt: "2026-05-21T02:00:00Z",
    });
    insertRun(db, {
      runId: "run-legacy",
      repoId: "demo",
      projectId: null,
      domain: "apps/api",
      status: "needs_review",
      startedAt: "2026-05-21T01:00:00Z",
    });
  });

  it("returns all runs newest-first by default", () => {
    const runs = repo.listRuns();
    expect(runs.map((r) => r.runId)).toEqual(["run-a", "run-b", "run-legacy"]);
  });

  it("filters by projectId", () => {
    const runs = repo.listRuns({ projectId: "demo" });
    expect(runs.map((r) => r.runId)).toEqual(["run-a"]);
  });

  it("separates the same domain across projects", () => {
    expect(repo.listRuns({ projectId: "demo", domain: "apps/web" })).toHaveLength(
      1,
    );
    expect(repo.listRuns({ projectId: "other", domain: "apps/web" })).toHaveLength(
      1,
    );
  });

  it("a legacy run is included by repo filter, excluded by project filter", () => {
    const byRepo = repo.listRuns({ repoId: "demo" });
    expect(byRepo.map((r) => r.runId).sort()).toEqual(["run-a", "run-legacy"]);
    const byProject = repo.listRuns({ projectId: "demo" });
    expect(byProject.map((r) => r.runId)).not.toContain("run-legacy");
  });

  it("filters by status set", () => {
    const runs = repo.listRuns({ statuses: ["needs_review"] });
    expect(runs.map((r) => r.runId).sort()).toEqual(["run-b", "run-legacy"]);
  });

  it("filters by date range", () => {
    const runs = repo.listRuns({ since: "2026-05-21T02:00:00Z" });
    expect(runs.map((r) => r.runId).sort()).toEqual(["run-a", "run-b"]);
  });

  it("paginates with limit and offset", () => {
    expect(repo.listRuns({ limit: 1 }).map((r) => r.runId)).toEqual(["run-a"]);
    expect(repo.listRuns({ limit: 1, offset: 1 }).map((r) => r.runId)).toEqual([
      "run-b",
    ]);
    expect(repo.countRuns()).toBe(3);
    expect(repo.countRuns({ projectId: "demo" })).toBe(1);
  });

  it("an explicit empty statuses set matches nothing", () => {
    expect(repo.listRuns({ statuses: [] })).toHaveLength(0);
    expect(repo.countRuns({ statuses: [] })).toBe(0);
  });

  it("clamps a fractional / non-finite offset instead of throwing", () => {
    expect(() =>
      repo.listRuns({ offset: 1.7 as number }),
    ).not.toThrow();
    expect(() =>
      repo.listRuns({ limit: Number.NaN, offset: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
  });
});

describe("RunRepository detail methods", () => {
  it("getRun returns null for an unknown run", () => {
    const db = freshDb();
    expect(new RunRepository(db).getRun("nope")).toBeNull();
    db.close();
  });

  it("getRerunChain returns every run in the chain", () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    insertRun(db, { runId: "root", repoId: "demo" });
    insertRun(db, {
      runId: "child",
      repoId: "demo",
      parentRunId: "root",
      rootRunId: "root",
      rerunAttempt: 1,
    });
    const chain = repo.getRerunChain("child");
    expect(chain.map((c) => c.runId).sort()).toEqual(["child", "root"]);
    db.close();
  });

  it("getRerunChain follows parent links for a legacy chain (no root_run_id)", () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    // legacy chain: parent_run_id set, root_run_id / rerun_attempt absent
    insertRun(db, { runId: "leg-root", repoId: "demo" });
    insertRun(db, {
      runId: "leg-child",
      repoId: "demo",
      parentRunId: "leg-root",
    });
    insertRun(db, {
      runId: "leg-grandchild",
      repoId: "demo",
      parentRunId: "leg-child",
    });
    const chain = repo.getRerunChain("leg-child");
    expect(chain.map((c) => c.runId).sort()).toEqual([
      "leg-child",
      "leg-grandchild",
      "leg-root",
    ]);
    db.close();
  });

  it("getTimeline / getReviewDecision read child rows", () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    insertRun(db, { runId: "run-x", repoId: "demo" });
    db.prepare(
      `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
       VALUES ('run-x', 0, 'run_started', NULL, '{"type":"run_started"}')`,
    ).run();
    db.prepare(
      `INSERT INTO review_decisions (run_id, decision, reviewer, summary,
         reviewed_at, source_yaml, source_sha256)
       VALUES ('run-x', 'changes_requested', 'alice', NULL, NULL, 'y', 'h')`,
    ).run();
    db.prepare(
      `INSERT INTO review_required_changes (run_id, idx, change_text)
       VALUES ('run-x', 0, 'fix it')`,
    ).run();
    expect(repo.getTimeline("run-x")).toHaveLength(1);
    const decision = repo.getReviewDecision("run-x");
    expect(decision?.decision).toBe("changes_requested");
    expect(decision?.requiredChanges).toEqual(["fix it"]);
    db.close();
  });
});
