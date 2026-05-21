import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { parseProvenance } from "../../project/provenance.js";
import {
  sha256,
  recordImportError,
  clearImportError,
  type ImportCounters,
} from "./common.js";

/**
 * Import generated repo policies into `policy_generations`.
 *
 * Only repos with a `<id>.generated.json` provenance sidecar are
 * "generations"; a hand-written `policies/repos/<id>.yaml` with no
 * sidecar is not a profile-compiled policy and is skipped. The DB read
 * model reflects the current generation per repo, keyed by repo id.
 */
export function importPolicies(
  db: Database.Database,
  policiesDir: string,
  counters: ImportCounters,
): void {
  const reposDir = join(policiesDir, "repos");
  if (!existsSync(reposDir)) return;
  const sidecars = readdirSync(reposDir).filter((f) =>
    f.endsWith(".generated.json"),
  );

  const upsert = db.prepare(
    `INSERT INTO policy_generations (generation_id, project_id, repo_id,
       profile_version, policy_template_id, policy_template_version,
       generated_at, repo_policy_yaml, global_policy_yaml, provenance_json,
       repo_policy_sha256)
     VALUES (@generation_id, @project_id, @repo_id, @profile_version,
       @policy_template_id, @policy_template_version, @generated_at,
       @repo_policy_yaml, @global_policy_yaml, @provenance_json,
       @repo_policy_sha256)
     ON CONFLICT (generation_id) DO UPDATE SET
       project_id = excluded.project_id, repo_id = excluded.repo_id,
       profile_version = excluded.profile_version,
       policy_template_id = excluded.policy_template_id,
       policy_template_version = excluded.policy_template_version,
       generated_at = excluded.generated_at,
       repo_policy_yaml = excluded.repo_policy_yaml,
       provenance_json = excluded.provenance_json,
       repo_policy_sha256 = excluded.repo_policy_sha256`,
  );

  for (const sidecar of sidecars) {
    const repoId = sidecar.slice(0, -".generated.json".length);
    const sidecarPath = join(reposDir, sidecar);
    const policyPath = join(reposDir, `${repoId}.yaml`);
    try {
      const provRaw = readFileSync(sidecarPath, "utf8");
      const prov = parseProvenance(provRaw);
      if (prov === null) {
        recordImportError(
          db,
          counters,
          sidecarPath,
          "policy",
          "provenance sidecar is malformed",
        );
        continue;
      }
      if (!existsSync(policyPath)) {
        recordImportError(
          db,
          counters,
          policyPath,
          "policy",
          "generated policy YAML is missing for its provenance sidecar",
        );
        continue;
      }
      const policyYaml = readFileSync(policyPath, "utf8");
      upsert.run({
        generation_id: prov.repoId,
        project_id: prov.projectId,
        repo_id: prov.repoId,
        profile_version: prov.profileVersion,
        policy_template_id: prov.policyTemplate?.id ?? null,
        policy_template_version: prov.policyTemplate?.version ?? null,
        generated_at: prov.generatedAt,
        repo_policy_yaml: policyYaml,
        global_policy_yaml: null,
        provenance_json: provRaw,
        repo_policy_sha256: sha256(policyYaml),
      });
      clearImportError(db, sidecarPath);
      counters.policies += 1;
    } catch (e) {
      recordImportError(
        db,
        counters,
        sidecarPath,
        "policy",
        (e as Error).message,
      );
    }
  }
}
