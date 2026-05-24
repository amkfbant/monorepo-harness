import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

/**
 * `policy_templates` + `effective_policy_snapshots` repository
 * (Phase 14-3).
 *
 * `policy_templates`: per-scope (repo / project / domain / global) ×
 *  version of the **source** YAML template the operator authored.
 * `effective_policy_snapshots`: derived, per-run/scope generated
 *  policy + provenance. Phase 14-3 minimum stores both; the existing
 *  `policy_generations` table (Phase 6 read-model) is left untouched.
 */

export type PolicyScopeType = "repo" | "project" | "domain" | "global";

export interface PolicyTemplate {
  policyTemplateId: number;
  scopeType: PolicyScopeType;
  scopeId: string;
  version: number;
  bodyYaml: string;
  bodySha256: string;
  parsedJson: string;
  actor: string;
  reason: string | null;
  createdAt: string;
}

export interface RecordPolicyTemplateInput {
  scopeType: PolicyScopeType;
  scopeId: string;
  bodyYaml: string;
  parsed: unknown;
  actor: string;
  reason?: string;
  now?: Date;
}

export interface RecordPolicyTemplateResult {
  template: PolicyTemplate;
  reusedExisting: boolean;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function recordPolicyTemplate(
  db: Database.Database,
  input: RecordPolicyTemplateInput,
): RecordPolicyTemplateResult {
  const bodySha = sha(input.bodyYaml);
  const tx = db.transaction((): RecordPolicyTemplateResult => {
    const latest = db
      .prepare(
        `SELECT * FROM policy_templates
          WHERE scope_type = ? AND scope_id = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(input.scopeType, input.scopeId) as
      | Record<string, unknown>
      | undefined;
    if (latest !== undefined && latest.body_sha256 === bodySha) {
      return { template: toTemplate(latest), reusedExisting: true };
    }
    const nextVersion =
      latest !== undefined ? (latest.version as number) + 1 : 1;
    const now = (input.now ?? new Date()).toISOString();
    const info = db
      .prepare(
        `INSERT INTO policy_templates
           (scope_type, scope_id, version, body_yaml, body_sha256,
            parsed_json, actor, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scopeType,
        input.scopeId,
        nextVersion,
        input.bodyYaml,
        bodySha,
        JSON.stringify(input.parsed),
        input.actor,
        input.reason ?? null,
        now,
      );
    return {
      template: {
        policyTemplateId: Number(info.lastInsertRowid),
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        version: nextVersion,
        bodyYaml: input.bodyYaml,
        bodySha256: bodySha,
        parsedJson: JSON.stringify(input.parsed),
        actor: input.actor,
        reason: input.reason ?? null,
        createdAt: now,
      },
      reusedExisting: false,
    };
  });
  return tx.immediate();
}

export function getCurrentPolicyTemplate(
  db: Database.Database,
  scopeType: PolicyScopeType,
  scopeId: string,
): PolicyTemplate | null {
  const row = db
    .prepare(
      `SELECT * FROM policy_templates
        WHERE scope_type = ? AND scope_id = ?
        ORDER BY version DESC LIMIT 1`,
    )
    .get(scopeType, scopeId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toTemplate(row);
}

export function listPolicyTemplates(
  db: Database.Database,
  scopeType: PolicyScopeType,
  scopeId: string,
): PolicyTemplate[] {
  const rows = db
    .prepare(
      `SELECT * FROM policy_templates
        WHERE scope_type = ? AND scope_id = ?
        ORDER BY version DESC`,
    )
    .all(scopeType, scopeId) as Record<string, unknown>[];
  return rows.map(toTemplate);
}

export interface EffectivePolicySnapshot {
  snapshotId: number;
  runId: string | null;
  projectId: string | null;
  repoId: string | null;
  domain: string | null;
  templateRevisionId: number | null;
  generatedPolicyYaml: string;
  generatedPolicySha256: string;
  provenanceJson: string;
  createdAt: string;
}

export interface RecordEffectivePolicySnapshotInput {
  runId?: string;
  projectId?: string;
  repoId?: string;
  domain?: string;
  templateRevisionId?: number;
  generatedPolicyYaml: string;
  provenance: unknown;
  now?: Date;
}

export function recordEffectivePolicySnapshot(
  db: Database.Database,
  input: RecordEffectivePolicySnapshotInput,
): EffectivePolicySnapshot {
  const now = (input.now ?? new Date()).toISOString();
  const generatedSha = sha(input.generatedPolicyYaml);
  const info = db
    .prepare(
      `INSERT INTO effective_policy_snapshots
         (run_id, project_id, repo_id, domain, template_revision_id,
          generated_policy_yaml, generated_policy_sha256,
          provenance_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId ?? null,
      input.projectId ?? null,
      input.repoId ?? null,
      input.domain ?? null,
      input.templateRevisionId ?? null,
      input.generatedPolicyYaml,
      generatedSha,
      JSON.stringify(input.provenance),
      now,
    );
  return {
    snapshotId: Number(info.lastInsertRowid),
    runId: input.runId ?? null,
    projectId: input.projectId ?? null,
    repoId: input.repoId ?? null,
    domain: input.domain ?? null,
    templateRevisionId: input.templateRevisionId ?? null,
    generatedPolicyYaml: input.generatedPolicyYaml,
    generatedPolicySha256: generatedSha,
    provenanceJson: JSON.stringify(input.provenance),
    createdAt: now,
  };
}

function toTemplate(r: Record<string, unknown>): PolicyTemplate {
  return {
    policyTemplateId: r.policy_template_id as number,
    scopeType: r.scope_type as PolicyScopeType,
    scopeId: r.scope_id as string,
    version: r.version as number,
    bodyYaml: r.body_yaml as string,
    bodySha256: r.body_sha256 as string,
    parsedJson: r.parsed_json as string,
    actor: r.actor as string,
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}
