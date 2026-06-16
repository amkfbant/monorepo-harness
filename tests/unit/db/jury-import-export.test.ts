import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { runFullImport } from "../../../src/db/import-files.js";

/**
 * RED for Task A3 (#230) — the three v31 jury tables are DB-only audit
 * tables. They must NOT be on any import/export reset list, so a
 * `runFullImport({ reset: true })` (run by every read-only scoped command
 * via withRefreshedDb) leaves seeded audit rows intact. They only ever
 * empty on a genuinely fresh DB. FK-zero: deleting a parent finding does
 * NOT error and leaves the jury rows behind (orphan), which doctor later
 * reports as advisory.
 */

const NOW = "2026-01-01T00:00:00Z";

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-jury-imp-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  return root;
}

function db(root: string): Database.Database {
  const d = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(d);
  return d;
}

function seedJuryRows(d: Database.Database): void {
  d.prepare(
    `INSERT INTO hitch_sessions
       (hitch_id, title, status, scope_json, close_conditions_json,
        policy_json, max_iterations, max_review_cycles, max_reruns,
        max_total_new_findings, created_by, created_source,
        created_at, updated_at)
     VALUES ('h1', 's', 'open', '{}', '[]', '{}', 10, 5, 3, 100,
             'tester', 'cli', ?, ?)`,
  ).run(NOW, NOW);
  d.prepare(
    `INSERT INTO hitch_findings
       (finding_id, hitch_id, stable_key, source, severity, category,
        scope_status, lifecycle_status, summary, file_path,
        first_seen_at, last_seen_at)
     VALUES ('f1', 'h1', 'k', 'review', 'P1', 'core', 'unknown', 'open',
             's', 'src/a.ts', ?, ?)`,
  ).run(NOW, NOW);
  d.prepare(
    `INSERT INTO jury_classification_proposals
       (finding_id, hitch_id, lens, reviewer_id, proposed_scope,
        proposal_status, prompt_sha256, round, evidence_json,
        deliberation_id, created_at)
     VALUES ('f1', 'h1', 'correctness', 'r1', 'in_scope', 'complete',
             'sha', 1, '[]', 'd1', ?)`,
  ).run(NOW);
  d.prepare(
    `INSERT INTO jury_classification_refutations
       (finding_id, hitch_id, target_scope, refute_verdict, reviewer_id,
        prompt_sha256, deliberation_id, created_at)
     VALUES ('f1', 'h1', 'in_scope', 'uphold', 'r1', 'sha', 'd1', ?)`,
  ).run(NOW);
  d.prepare(
    `INSERT INTO jury_severity_audits
       (finding_id, hitch_id, harness_severity, audit_status, escalate_flag,
        prompt_sha256, jury_votes_json, deliberation_id, created_at)
     VALUES ('f1', 'h1', 'P1', 'aligned', 0, 'sha', '[]', 'd1', ?)`,
  ).run(NOW);
}

function juryCounts(d: Database.Database): {
  proposals: number;
  refutations: number;
  audits: number;
} {
  const count = (t: string) =>
    (d.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
  return {
    proposals: count("jury_classification_proposals"),
    refutations: count("jury_classification_refutations"),
    audits: count("jury_severity_audits"),
  };
}

describe("jury audit tables are DB-only (import/export reset)", () => {
  it("runFullImport({ reset: true }) leaves seeded jury rows intact", () => {
    const root = freshRoot();
    const d = db(root);
    try {
      seedJuryRows(d);
      expect(juryCounts(d)).toEqual({
        proposals: 1,
        refutations: 1,
        audits: 1,
      });
      runFullImport(d, { harnessRoot: root, reset: true });
      // DB-only audit tables: NOT on any reset list -> rows survive.
      expect(juryCounts(d)).toEqual({
        proposals: 1,
        refutations: 1,
        audits: 1,
      });
    } finally {
      d.close();
    }
  });

  it("a fresh DB has zero jury rows (the only state that is empty)", () => {
    const root = freshRoot();
    const d = db(root);
    try {
      runFullImport(d, { harnessRoot: root });
      expect(juryCounts(d)).toEqual({
        proposals: 0,
        refutations: 0,
        audits: 0,
      });
    } finally {
      d.close();
    }
  });
});

describe("jury audit tables have zero foreign keys (P2g)", () => {
  it("all three v31 tables report an empty PRAGMA foreign_key_list", () => {
    const root = freshRoot();
    const d = db(root);
    try {
      for (const t of [
        "jury_classification_proposals",
        "jury_classification_refutations",
        "jury_severity_audits",
      ]) {
        const fks = d.prepare(`PRAGMA foreign_key_list(${t})`).all();
        expect(fks).toEqual([]);
      }
    } finally {
      d.close();
    }
  });

  it("deleting the parent finding does NOT error and leaves jury rows behind (orphan)", () => {
    const root = freshRoot();
    const d = db(root);
    d.pragma("foreign_keys = ON");
    try {
      seedJuryRows(d);
      // FK-zero on jury tables: the parent finding can be deleted without a
      // constraint error, and the audit rows remain as orphans.
      expect(() =>
        d.prepare("DELETE FROM hitch_findings WHERE finding_id = 'f1'").run(),
      ).not.toThrow();
      expect(
        (
          d
            .prepare("SELECT count(*) c FROM hitch_findings WHERE finding_id='f1'")
            .get() as { c: number }
        ).c,
      ).toBe(0);
      // jury rows survive the parent delete (no CASCADE).
      expect(juryCounts(d)).toEqual({
        proposals: 1,
        refutations: 1,
        audits: 1,
      });
    } finally {
      d.close();
    }
  });
});
