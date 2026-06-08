import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  metricsSummary,
  inboxSummary,
  knowledgeDigest,
  backlogList,
} from "../../../src/db/repositories/aggregates.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-agg-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function insertRun(
  db: Database.Database,
  runId: string,
  projectId: string | null,
  status: string,
): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, project_id, domain, workflow,
       base_branch, status, started_at, source_meta_sha256, updated_at)
     VALUES (?, 'demo', ?, 'apps/web', 'domain-coding', 'main', ?,
       '2026-05-21T00:00:00Z', 'x', '2026-05-22T00:00:00Z')`,
  ).run(runId, projectId, status);
}

function insertCandidate(
  db: Database.Database,
  candidateId: string,
  runId: string,
  projectId: string | null,
  kind: string,
  status: string,
): void {
  db.prepare(
    `INSERT INTO knowledge_candidates (candidate_id, run_id, project_id,
       repo_id, domain, kind, status, created_at)
     VALUES (?, ?, ?, 'demo', 'apps/web', ?, ?, '2026-05-21T00:00:00Z')`,
  ).run(candidateId, runId, projectId, kind, status);
}

describe("aggregates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertRun(db, "run-a", "demo", "approved");
    insertRun(db, "run-b", "demo", "needs_review");
    insertRun(db, "run-c", "other", "needs_review");
    insertRun(db, "run-d", "demo", "failed-policy-violation");
    insertRun(db, "run-e", "demo", "changes_requested");
  });

  it("metricsSummary counts by status and approval rate", () => {
    const all = metricsSummary(db);
    expect(all.totalRuns).toBe(5);
    expect(all.needsReview).toBe(2);
    expect(all.failed).toBe(1);
    // approved 1 / (approved 1 + changes_requested 1 + rejected 0) = 0.5
    expect(all.approvedRate).toBe(0.5);
  });

  it("metricsSummary scopes by project", () => {
    const demo = metricsSummary(db, { projectId: "demo" });
    expect(demo.totalRuns).toBe(4);
    const other = metricsSummary(db, { projectId: "other" });
    expect(other.totalRuns).toBe(1);
    expect(other.needsReview).toBe(1);
  });

  it("inboxSummary buckets runs and scopes by project", () => {
    const demo = inboxSummary(db, { projectId: "demo" });
    expect(demo.needsReview.map((r) => r.runId)).toEqual(["run-b"]);
    expect(demo.changesRequested.map((r) => r.runId)).toEqual(["run-e"]);
    expect(demo.failed.map((r) => r.runId)).toEqual(["run-d"]);
  });

  it("knowledgeDigest counts candidates by kind and status, scoped", () => {
    insertCandidate(db, "run-a:0", "run-a", "demo", "policy_violation", "candidate");
    insertCandidate(db, "run-a:1", "run-a", "demo", "policy_violation", "promoted");
    insertCandidate(db, "run-c:0", "run-c", "other", "secret_suspect", "candidate");
    const all = knowledgeDigest(db);
    expect(all.candidateTotal).toBe(3);
    expect(all.byKind.policy_violation).toBe(2);
    const demo = knowledgeDigest(db, { projectId: "demo" });
    expect(demo.candidateTotal).toBe(2);
    expect(demo.byStatus.promoted).toBe(1);
  });

  it("knowledgeDigest entryTotal excludes operational entries (issue #57)", () => {
    db.prepare(
      `INSERT INTO knowledge_entries (entry_id, kind, body, category)
       VALUES ('docs/knowledge/note/a.md', 'note', 'codebase body', 'codebase')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_entries (entry_id, kind, body, category)
       VALUES ('ops/x', 'operational', 'ops body', 'operational')`,
    ).run();
    expect(knowledgeDigest(db).entryTotal).toBe(1);
  });

  it("inboxSummary counts un-decided knowledge-candidate runs", () => {
    insertCandidate(db, "run-a:0", "run-a", "demo", "policy_violation", "candidate");
    insertCandidate(db, "run-a:1", "run-a", "demo", "secret_suspect", "promoted");
    const demo = inboxSummary(db, { projectId: "demo" });
    expect(demo.knowledgeCandidateRuns).toBe(1);
  });

  it("backlogList scopes by project", () => {
    db.prepare(
      `INSERT INTO backlog_items (item_id, project_id, domain, title, goal,
         status, priority, tags_json, created_at)
       VALUES ('item-1', 'demo', 'apps/web', 't1', 'g', 'open', 'medium',
         '[]', '2026-05-21T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO backlog_items (item_id, project_id, domain, title, goal,
         status, priority, tags_json, created_at)
       VALUES ('item-2', 'other', 'apps/api', 't2', 'g', 'open', 'high',
         '[]', '2026-05-21T00:00:00Z')`,
    ).run();
    expect(backlogList(db).items).toHaveLength(2);
    const demo = backlogList(db, { projectId: "demo" });
    expect(demo.items.map((i) => i.itemId)).toEqual(["item-1"]);
    expect(demo.byStatus.open).toBe(1);
  });
});

describe("aggregate date / status filters", () => {
  it("metricsSummary applies a since date filter on started_at", () => {
    const db = freshDb();
    const ins = db.prepare(
      `INSERT INTO runs (run_id, repo_id, project_id, domain, workflow,
         base_branch, status, started_at, source_meta_sha256, updated_at)
       VALUES (?, 'demo', 'demo', 'apps/web', 'domain-coding', 'main',
         'approved', ?, 'x', 'x')`,
    );
    ins.run("run-old", "2026-01-01T00:00:00Z");
    ins.run("run-new", "2026-05-20T00:00:00Z");
    expect(metricsSummary(db).totalRuns).toBe(2);
    expect(
      metricsSummary(db, { since: "2026-05-01T00:00:00Z" }).totalRuns,
    ).toBe(1);
    db.close();
  });

  it("knowledgeDigest applies a since date filter on created_at", () => {
    const db = freshDb();
    const ins = db.prepare(
      `INSERT INTO knowledge_candidates (candidate_id, run_id, kind, status,
         created_at)
       VALUES (?, 'run-x', 'policy_violation', 'candidate', ?)`,
    );
    ins.run("c-old", "2026-01-01T00:00:00Z");
    ins.run("c-new", "2026-05-20T00:00:00Z");
    expect(knowledgeDigest(db).candidateTotal).toBe(2);
    expect(
      knowledgeDigest(db, { since: "2026-05-01T00:00:00Z" }).candidateTotal,
    ).toBe(1);
    db.close();
  });

  it("backlogList applies a status filter", () => {
    const db = freshDb();
    const ins = db.prepare(
      `INSERT INTO backlog_items (item_id, project_id, domain, title, goal,
         status, priority, tags_json, created_at)
       VALUES (?, 'demo', 'apps/web', 't', 'g', ?, 'medium', '[]', 'x')`,
    );
    ins.run("item-1", "open");
    ins.run("item-2", "done");
    expect(backlogList(db).items).toHaveLength(2);
    expect(
      backlogList(db, { status: "open" }).items.map((i) => i.itemId),
    ).toEqual(["item-1"]);
    db.close();
  });
});
