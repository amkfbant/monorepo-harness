import type Database from "better-sqlite3";
import {
  canonicaliseRule,
  ruleSha256,
  type ReviewRule,
} from "../../core/review-rule.js";

/**
 * `review_rules` and `run_review_rule_snapshots` repositories (Phase
 * 11-3).
 *
 * `review_rules` holds the template history (one row per
 * (project / repo / domain) × version). `run_review_rule_snapshots`
 * freezes the effective rule per run so the run's review semantics do
 * not move with later profile edits.
 *
 * `upsertRuleTemplate` reuses an existing row when the canonical
 * `rule_json` matches, otherwise INSERTs a new version.
 */

export interface ReviewRuleTemplate {
  ruleId: number;
  projectId: string | null;
  repoId: string | null;
  domain: string | null;
  ruleVersion: number;
  source: "project-profile" | "default" | "manual";
  ruleJson: string;
  sourceSha256: string;
  createdAt: string;
}

export interface RunRuleSnapshot {
  runId: string;
  ruleId: number | null;
  ruleJson: string;
  sourceSha256: string;
  createdAt: string;
}

export class ReviewRulesRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert or reuse a rule template row.
   *
   * Reuse rule: an existing row in the same scope with the same
   * `source_sha256` returns its `rule_id` without inserting. Otherwise
   * the next `rule_version` is allocated for that scope.
   */
  upsertRuleTemplate(input: {
    projectId?: string;
    repoId?: string;
    domain?: string;
    source: "project-profile" | "default" | "manual";
    rule: ReviewRule;
    now?: Date;
  }): ReviewRuleTemplate {
    const sha = ruleSha256(input.rule);
    const json = canonicaliseRule(input.rule);
    const existing = this.db
      .prepare(
        `SELECT rule_id, project_id, repo_id, domain, rule_version, source,
                rule_json, source_sha256, created_at
           FROM review_rules
          WHERE (project_id IS ? OR (project_id IS NULL AND ? IS NULL))
            AND (repo_id IS ? OR (repo_id IS NULL AND ? IS NULL))
            AND (domain IS ? OR (domain IS NULL AND ? IS NULL))
            AND source_sha256 = ?
          ORDER BY rule_version DESC
          LIMIT 1`,
      )
      .get(
        input.projectId ?? null,
        input.projectId ?? null,
        input.repoId ?? null,
        input.repoId ?? null,
        input.domain ?? null,
        input.domain ?? null,
        sha,
      ) as Record<string, unknown> | undefined;
    if (existing !== undefined) return toTemplate(existing);

    const maxVersion = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(rule_version), 0) AS v
             FROM review_rules
            WHERE (project_id IS ? OR (project_id IS NULL AND ? IS NULL))
              AND (repo_id IS ? OR (repo_id IS NULL AND ? IS NULL))
              AND (domain IS ? OR (domain IS NULL AND ? IS NULL))`,
        )
        .get(
          input.projectId ?? null,
          input.projectId ?? null,
          input.repoId ?? null,
          input.repoId ?? null,
          input.domain ?? null,
          input.domain ?? null,
        ) as { v: number }
    ).v;
    const now = (input.now ?? new Date()).toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO review_rules
           (project_id, repo_id, domain, rule_version, source,
            rule_json, source_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId ?? null,
        input.repoId ?? null,
        input.domain ?? null,
        maxVersion + 1,
        input.source,
        json,
        sha,
        now,
      );
    return {
      ruleId: Number(info.lastInsertRowid),
      projectId: input.projectId ?? null,
      repoId: input.repoId ?? null,
      domain: input.domain ?? null,
      ruleVersion: maxVersion + 1,
      source: input.source,
      ruleJson: json,
      sourceSha256: sha,
      createdAt: now,
    };
  }

  /** Snapshot the effective rule onto a run (Phase 11-3 hook point). */
  snapshotForRun(input: {
    runId: string;
    template: ReviewRuleTemplate;
    now?: Date;
  }): RunRuleSnapshot {
    const now = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_review_rule_snapshots
           (run_id, rule_id, rule_json, source_sha256, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.template.ruleId,
        input.template.ruleJson,
        input.template.sourceSha256,
        now,
      );
    return {
      runId: input.runId,
      ruleId: input.template.ruleId,
      ruleJson: input.template.ruleJson,
      sourceSha256: input.template.sourceSha256,
      createdAt: now,
    };
  }

  findSnapshotByRun(runId: string): RunRuleSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT run_id, rule_id, rule_json, source_sha256, created_at
           FROM run_review_rule_snapshots
          WHERE run_id = ?`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      runId: row.run_id as string,
      ruleId: (row.rule_id as number | null) ?? null,
      ruleJson: row.rule_json as string,
      sourceSha256: row.source_sha256 as string,
      createdAt: row.created_at as string,
    };
  }
}

function toTemplate(r: Record<string, unknown>): ReviewRuleTemplate {
  return {
    ruleId: r.rule_id as number,
    projectId: (r.project_id as string | null) ?? null,
    repoId: (r.repo_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    ruleVersion: r.rule_version as number,
    source: r.source as "project-profile" | "default" | "manual",
    ruleJson: r.rule_json as string,
    sourceSha256: r.source_sha256 as string,
    createdAt: r.created_at as string,
  };
}
