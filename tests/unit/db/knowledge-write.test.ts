import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb, DbError } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { StateConflictError } from "../../../src/db/errors.js";
import { KnowledgeRepository } from "../../../src/db/repositories/knowledge.js";

/** Phase 7-9 — knowledge write repository: candidate sync + decision guard. */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-knw-write-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function sync(repo: KnowledgeRepository, id: string): void {
  repo.syncCandidate({
    candidateId: id,
    runId: "run-x",
    projectId: null,
    repoId: null,
    domain: "apps/web",
    kind: "policy_improvement",
    title: "t",
    body: "content",
    createdAt: "2026-05-22T00:00:00.000Z",
  });
}

describe("KnowledgeRepository", () => {
  it("syncCandidate inserts a candidate at status 'candidate'", () => {
    const db = freshDb();
    const repo = new KnowledgeRepository(db);
    sync(repo, "run-x:0");
    const c = repo.getCandidate("run-x:0");
    expect(c?.status).toBe("candidate");
    expect(c?.sourceMode).toBe("legacy-file");
    expect(c?.body).toBe("content");
    db.close();
  });

  it("syncCandidate preserves an existing decision", () => {
    const db = freshDb();
    const repo = new KnowledgeRepository(db);
    sync(repo, "run-x:0");
    repo.setCandidateDecision({
      candidateId: "run-x:0",
      decision: "rejected",
      reviewer: "kn",
      reason: "too specific",
      decidedAt: "2026-05-22T01:00:00.000Z",
    });
    // a re-sync of the content must not wipe the decision
    sync(repo, "run-x:0");
    const c = repo.getCandidate("run-x:0");
    expect(c?.status).toBe("rejected");
    expect(c?.reviewer).toBe("kn");
    db.close();
  });

  it("setCandidateDecision flips to db-first and is idempotent", () => {
    const db = freshDb();
    const repo = new KnowledgeRepository(db);
    sync(repo, "run-x:0");
    const first = repo.setCandidateDecision({
      candidateId: "run-x:0",
      decision: "promoted",
      reviewer: "kn",
      reason: null,
      decidedAt: "2026-05-22T01:00:00.000Z",
    });
    expect(first.changed).toBe(true);
    expect(repo.getCandidate("run-x:0")?.sourceMode).toBe("db-first");
    const again = repo.setCandidateDecision({
      candidateId: "run-x:0",
      decision: "promoted",
      reviewer: "kn",
      reason: null,
      decidedAt: "2026-05-22T02:00:00.000Z",
    });
    expect(again.changed).toBe(false);
    db.close();
  });

  it("setCandidateDecision rejects a conflicting decision", () => {
    const db = freshDb();
    const repo = new KnowledgeRepository(db);
    sync(repo, "run-x:0");
    repo.setCandidateDecision({
      candidateId: "run-x:0",
      decision: "promoted",
      reviewer: "kn",
      reason: null,
      decidedAt: "2026-05-22T01:00:00.000Z",
    });
    // a promoted candidate cannot then be rejected
    expect(() =>
      repo.setCandidateDecision({
        candidateId: "run-x:0",
        decision: "rejected",
        reviewer: "kn",
        reason: "x",
        decidedAt: "2026-05-22T02:00:00.000Z",
      }),
    ).toThrow(StateConflictError);
    db.close();
  });

  it("setCandidateDecision throws DbError for a missing candidate", () => {
    const db = freshDb();
    expect(() =>
      new KnowledgeRepository(db).setCandidateDecision({
        candidateId: "run-x:9",
        decision: "rejected",
        reviewer: "kn",
        reason: "x",
        decidedAt: "2026-05-22T00:00:00.000Z",
      }),
    ).toThrow(DbError);
    db.close();
  });

  it("upsertEntry writes a db-first manifest row and bumps the revision", () => {
    const db = freshDb();
    const repo = new KnowledgeRepository(db);
    const entry = {
      entryId: "docs/knowledge/policy_improvement/run-x-00-t.md",
      projectId: null,
      repoId: null,
      domain: "apps/web",
      kind: "policy_improvement",
      path: "docs/knowledge/policy_improvement/run-x-00-t.md",
      title: "t",
      body: "# t\n",
      frontmatterJson: '{"hash":"abc"}',
      createdAt: "2026-05-22T00:00:00.000Z",
      sourceCandidateId: "run-x:0",
    };
    expect(repo.upsertEntry(entry).dbRevision).toBe(1);
    expect(repo.upsertEntry(entry).dbRevision).toBe(2);
    const row = db
      .prepare("SELECT source_mode FROM knowledge_entries WHERE entry_id = ?")
      .get(entry.entryId) as { source_mode: string };
    expect(row.source_mode).toBe("db-first");
    db.close();
  });
});
