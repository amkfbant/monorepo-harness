import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewRulesRepository } from "../../../src/db/repositories/review-rules.js";
import {
  DEFAULT_REVIEW_RULE,
  resolveEffectiveRule,
  ruleSha256,
  canonicaliseRule,
  type ReviewRule,
} from "../../../src/core/review-rule.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-revrules-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  // also seed a run row so FK to runs(run_id) is satisfied
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, source_mode, db_revision, export_status, started_at,
       updated_at, meta_json)
     VALUES ('run-test', 't', 'apps/user', 'domain-coding', 'main',
       'running', 'db-first', 1, 'disabled',
       '2026-05-24T00:00:00Z', '2026-05-24T00:00:00Z', '{}')`,
  ).run();
  return db;
}

describe("review-rule core (Phase 11-3)", () => {
  it("DEFAULT_REVIEW_RULE matches pre-Phase-11 semantics (mode=latest-proposal, no requirements)", () => {
    expect(DEFAULT_REVIEW_RULE.mode).toBe("latest-proposal");
    expect(DEFAULT_REVIEW_RULE.requirements).toEqual([]);
    expect(DEFAULT_REVIEW_RULE.staleProposal.rejectSuperseded).toBe(true);
  });

  it("resolveEffectiveRule returns the default resolution when profile.review is absent", () => {
    expect(resolveEffectiveRule({})).toEqual({
      rule: DEFAULT_REVIEW_RULE,
      source: "default",
      ruleSha256: ruleSha256(DEFAULT_REVIEW_RULE),
    });
    expect(resolveEffectiveRule({ projectId: "mini" }).rule).toEqual(
      DEFAULT_REVIEW_RULE,
    );
  });

  it("canonicaliseRule produces key-sorted JSON (stable sha256)", () => {
    const r1: ReviewRule = { ...DEFAULT_REVIEW_RULE };
    const r2: ReviewRule = {
      // intentionally different field order
      staleProposal: DEFAULT_REVIEW_RULE.staleProposal,
      overrides: DEFAULT_REVIEW_RULE.overrides,
      requirements: DEFAULT_REVIEW_RULE.requirements,
      mode: DEFAULT_REVIEW_RULE.mode,
    };
    expect(canonicaliseRule(r1)).toBe(canonicaliseRule(r2));
    expect(ruleSha256(r1)).toBe(ruleSha256(r2));
  });
});

describe("ReviewRulesRepository (Phase 11-3)", () => {
  it("upsertRuleTemplate reuses existing row when sha matches in the same scope", () => {
    const db = freshDb();
    try {
      const repo = new ReviewRulesRepository(db);
      const t1 = repo.upsertRuleTemplate({
        projectId: "mini",
        source: "default",
        rule: DEFAULT_REVIEW_RULE,
      });
      const t2 = repo.upsertRuleTemplate({
        projectId: "mini",
        source: "default",
        rule: DEFAULT_REVIEW_RULE,
      });
      expect(t2.ruleId).toBe(t1.ruleId);
      expect(t2.ruleVersion).toBe(1);
    } finally {
      db.close();
    }
  });

  it("upsertRuleTemplate does not reuse a row across different sources (preserves provenance)", () => {
    const db = freshDb();
    try {
      const repo = new ReviewRulesRepository(db);
      // Same canonical rule (DEFAULT) but distinct provenance: a project-profile
      // run that compiles to the default rule must not inherit a default-sourced
      // template row (codex SP-10 P2).
      const def = repo.upsertRuleTemplate({
        projectId: "mini",
        source: "default",
        rule: DEFAULT_REVIEW_RULE,
      });
      const profile = repo.upsertRuleTemplate({
        projectId: "mini",
        source: "project-profile",
        rule: DEFAULT_REVIEW_RULE,
      });
      expect(profile.ruleId).not.toBe(def.ruleId);
      expect(profile.source).toBe("project-profile");
      // re-upsert with the same source still reuses
      const profile2 = repo.upsertRuleTemplate({
        projectId: "mini",
        source: "project-profile",
        rule: DEFAULT_REVIEW_RULE,
      });
      expect(profile2.ruleId).toBe(profile.ruleId);
    } finally {
      db.close();
    }
  });

  it("upsertRuleTemplate inserts a new version when the rule changes within the same scope", () => {
    const db = freshDb();
    try {
      const repo = new ReviewRulesRepository(db);
      const t1 = repo.upsertRuleTemplate({
        projectId: "mini",
        source: "default",
        rule: DEFAULT_REVIEW_RULE,
      });
      const r2: ReviewRule = {
        ...DEFAULT_REVIEW_RULE,
        mode: "consensus",
      };
      const t2 = repo.upsertRuleTemplate({
        projectId: "mini",
        source: "manual",
        rule: r2,
      });
      expect(t2.ruleId).not.toBe(t1.ruleId);
      expect(t2.ruleVersion).toBe(2);
      expect(t2.source).toBe("manual");
    } finally {
      db.close();
    }
  });

  it("snapshotForRun freezes the rule onto a run and findSnapshotByRun reads it back", () => {
    const db = freshDb();
    try {
      const repo = new ReviewRulesRepository(db);
      const t = repo.upsertRuleTemplate({
        source: "default",
        rule: DEFAULT_REVIEW_RULE,
      });
      const s = repo.snapshotForRun({ runId: "run-test", template: t });
      expect(s.ruleId).toBe(t.ruleId);
      expect(s.sourceSha256).toBe(t.sourceSha256);
      const found = repo.findSnapshotByRun("run-test");
      expect(found?.sourceSha256).toBe(t.sourceSha256);
    } finally {
      db.close();
    }
  });

  it("findSnapshotByRun returns null for an unknown run", () => {
    const db = freshDb();
    try {
      const repo = new ReviewRulesRepository(db);
      expect(repo.findSnapshotByRun("run-does-not-exist")).toBeNull();
    } finally {
      db.close();
    }
  });
});
