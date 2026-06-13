import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations, MIGRATIONS } from "../../../src/db/migrations.js";
import {
  metricsSummary,
  inboxSummary,
  knowledgeDigest,
  backlogList,
  tokenUsageSummary,
} from "../../../src/db/repositories/aggregates.js";
import {
  recordOperationalKnowledge,
  deprecateOperationalKnowledge,
} from "../../../src/core/operational-knowledge.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-agg-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

/** A DB migrated only up to v18 — no `knowledge_entries.category` column. */
function preV19Db(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-agg-pre19-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const m of MIGRATIONS.filter((x) => x.version < 19)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(m.version, m.name, "2026-06-08T00:00:00Z");
  }
  return db;
}

interface InsertRunOptions {
  parentRunId?: string;
  secretSuspectCount?: number;
  safetyStatus?: string | null;
}

function insertRun(
  db: Database.Database,
  runId: string,
  projectId: string | null,
  status: string,
  options: InsertRunOptions = {},
): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, project_id, domain, workflow,
       base_branch, status, safety_status, started_at, parent_run_id,
       secret_suspect_count, source_meta_sha256, updated_at)
     VALUES (?, 'demo', ?, 'apps/web', 'domain-coding', 'main', ?,
       ?, '2026-05-21T00:00:00Z', ?, ?, 'x', '2026-05-22T00:00:00Z')`,
  ).run(
    runId,
    projectId,
    status,
    options.safetyStatus ?? null,
    options.parentRunId ?? null,
    options.secretSuspectCount ?? null,
  );
}

function insertPolicyViolation(
  db: Database.Database,
  runId: string,
  path: string,
): void {
  db.prepare(
    `INSERT INTO policy_violations (run_id, path, rule, reason)
     VALUES (?, ?, 'deny_write', 'outside scope')`,
  ).run(runId, path);
}

function insertUsage(
  db: Database.Database,
  runId: string,
  usageSource: "exact" | "parsed_log" | "estimated" | "unavailable",
  inputTokens: number | null,
  outputTokens: number | null,
  totalTokens: number | null,
): void {
  db.prepare(
    `INSERT INTO run_usage
       (run_id, input_tokens, output_tokens, total_tokens, usage_source,
        created_at)
     VALUES (?, ?, ?, ?, ?, '2026-06-13T00:00:00.000Z')`,
  ).run(runId, inputTokens, outputTokens, totalTokens, usageSource);
}

function insertLockContention(
  db: Database.Database,
  input: {
    contentionId: string;
    repoId: string;
    domain: string;
    observedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO domain_lock_contention
       (contention_id, domain_key, repo_id, domain, observed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.contentionId,
    `${input.repoId}::${input.domain}`,
    input.repoId,
    input.domain,
    input.observedAt,
  );
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

  it("metricsSummary reports one-shot approval rate over root decided runs", () => {
    const db = freshDb();
    try {
      insertRun(db, "root-approved-a", "demo", "approved");
      insertRun(db, "root-approved-b", "demo", "approved");
      insertRun(db, "root-changes", "demo", "changes_requested");
      insertRun(db, "child-approved", "demo", "approved", {
        parentRunId: "root-changes",
      });

      expect(metricsSummary(db).oneShotApprovalRate).toBe(2 / 3);
    } finally {
      db.close();
    }
  });

  it("metricsSummary reports policy violation rate over scoped runs", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-with-violation", "demo", "approved");
      insertRun(db, "run-clean-a", "demo", "approved");
      insertRun(db, "run-clean-b", "demo", "approved");
      insertPolicyViolation(db, "run-with-violation", "src/app.ts");
      insertPolicyViolation(db, "run-with-violation", "src/other.ts");

      expect(metricsSummary(db).policyViolationRate).toBe(1 / 3);
    } finally {
      db.close();
    }
  });

  it("metricsSummary counts safety denied and policy violation rows as distinct violating runs", () => {
    const db = freshDb();
    try {
      insertRun(db, "denied-without-row", "demo", "approved", {
        safetyStatus: "denied",
      });
      insertRun(db, "allowed-with-row", "demo", "approved", {
        safetyStatus: "allowed",
      });
      insertRun(db, "denied-with-row", "demo", "failed-policy-violation", {
        safetyStatus: "denied",
      });
      insertRun(db, "clean", "demo", "approved", {
        safetyStatus: "allowed",
      });
      insertPolicyViolation(db, "allowed-with-row", "src/app.ts");
      insertPolicyViolation(db, "denied-with-row", "src/one.ts");
      insertPolicyViolation(db, "denied-with-row", "src/two.ts");

      expect(metricsSummary(db).policyViolationRate).toBe(3 / 4);
    } finally {
      db.close();
    }
  });

  it("metricsSummary reports secret suspect rate", () => {
    const db = freshDb();
    try {
      insertRun(db, "run-secret-a", "demo", "approved", {
        secretSuspectCount: 2,
      });
      insertRun(db, "run-secret-b", "demo", "approved", {
        secretSuspectCount: 1,
      });
      insertRun(db, "run-clean", "demo", "approved", {
        secretSuspectCount: 0,
      });

      expect(metricsSummary(db).secretSuspectRate).toBe(2 / 3);
    } finally {
      db.close();
    }
  });

  it("metricsSummary reports null run KPI rates for an empty DB", () => {
    const db = freshDb();
    try {
      const summary = metricsSummary(db);
      expect(summary.oneShotApprovalRate).toBeNull();
      expect(summary.policyViolationRate).toBeNull();
      expect(summary.secretSuspectRate).toBeNull();
    } finally {
      db.close();
    }
  });

  it("metricsSummary applies project scope to run KPI rates", () => {
    const db = freshDb();
    try {
      insertRun(db, "demo-approved", "demo", "approved", {
        secretSuspectCount: 1,
      });
      insertRun(db, "demo-changes", "demo", "changes_requested", {
        secretSuspectCount: 0,
      });
      insertRun(db, "other-approved", "other", "approved", {
        secretSuspectCount: 0,
      });
      insertPolicyViolation(db, "demo-approved", "src/demo.ts");
      insertPolicyViolation(db, "other-approved", "src/other.ts");

      const demo = metricsSummary(db, { projectId: "demo" });
      expect(demo.oneShotApprovalRate).toBe(1 / 2);
      expect(demo.policyViolationRate).toBe(1 / 2);
      expect(demo.secretSuspectRate).toBe(1 / 2);
    } finally {
      db.close();
    }
  });

  it("metricsSummary counts domain lock contention scoped by repo, domain, and since", () => {
    const db = freshDb();
    try {
      insertLockContention(db, {
        contentionId: "dlc-old",
        repoId: "demo",
        domain: "apps/web",
        observedAt: "2026-06-01T00:00:00.000Z",
      });
      insertLockContention(db, {
        contentionId: "dlc-demo-web-a",
        repoId: "demo",
        domain: "apps/web",
        observedAt: "2026-06-13T00:00:00.000Z",
      });
      insertLockContention(db, {
        contentionId: "dlc-demo-web-b",
        repoId: "demo",
        domain: "apps/web",
        observedAt: "2026-06-14T00:00:00.000Z",
      });
      insertLockContention(db, {
        contentionId: "dlc-demo-api",
        repoId: "demo",
        domain: "apps/api",
        observedAt: "2026-06-13T00:00:00.000Z",
      });
      insertLockContention(db, {
        contentionId: "dlc-other-web",
        repoId: "other",
        domain: "apps/web",
        observedAt: "2026-06-13T00:00:00.000Z",
      });

      expect(
        metricsSummary(db, {
          projectId: "not-a-contention-column",
          repoId: "demo",
          domain: "apps/web",
          since: "2026-06-13T00:00:00.000Z",
        }).lockContentionCount,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it("tokenUsageSummary scopes through runs and sums exact rows only", () => {
    const db = freshDb();
    try {
      insertRun(db, "demo-exact", "demo", "approved");
      insertRun(db, "demo-unavailable", "demo", "approved");
      insertRun(db, "other-exact", "other", "approved");
      insertUsage(db, "demo-exact", "exact", 100, 25, 125);
      insertUsage(db, "demo-unavailable", "unavailable", null, null, null);
      insertUsage(db, "other-exact", "exact", 999, 111, 1110);

      const all = tokenUsageSummary(db);
      expect(all).toEqual({
        runsWithUsage: 3,
        totalInputTokens: 1099,
        totalOutputTokens: 136,
        totalTokens: 1235,
        bySource: { exact: 2, unavailable: 1 },
      });

      const demo = tokenUsageSummary(db, { projectId: "demo" });
      expect(demo).toEqual({
        runsWithUsage: 2,
        totalInputTokens: 100,
        totalOutputTokens: 25,
        totalTokens: 125,
        bySource: { exact: 1, unavailable: 1 },
      });
    } finally {
      db.close();
    }
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

  it("inboxSummary surfaces operational knowledge (total + recent, scoped, non-deprecated)", () => {
    recordOperationalKnowledge(db, { key: "portable", title: "Portable", body: "p", actor: "op" });
    recordOperationalKnowledge(db, { key: "demo-a", title: "Demo A", body: "a", projectId: "demo", actor: "op" });
    recordOperationalKnowledge(db, { key: "other-a", title: "Other A", body: "b", projectId: "other", actor: "op" });
    const gone = recordOperationalKnowledge(db, { key: "gone", title: "Gone", body: "g", actor: "op" });
    deprecateOperationalKnowledge(db, { entryId: gone.entryId, actor: "op" });

    const all = inboxSummary(db);
    expect(all.operationalKnowledge.total).toBe(3); // gone is deprecated
    expect(all.operationalKnowledge.recent.map((e) => e.entryId).sort()).toEqual([
      "ops/demo-a", "ops/other-a", "ops/portable",
    ]);

    const demo = inboxSummary(db, { projectId: "demo" });
    expect(demo.operationalKnowledge.total).toBe(2); // demo + portable
    expect(demo.operationalKnowledge.recent.map((e) => e.entryId)).not.toContain("ops/other-a");
  });

  it("inboxSummary fails soft on a pre-v19 schema (no category column)", () => {
    const db = preV19Db();
    try {
      const inbox = inboxSummary(db);
      expect(inbox.operationalKnowledge).toEqual({ total: 0, recent: [] });
    } finally {
      db.close();
    }
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
