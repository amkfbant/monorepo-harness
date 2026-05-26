import process from "node:process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { stringify as yamlStringify } from "yaml";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { recordEffectivePolicySnapshot } from "../db/repositories/policy-templates.js";
import { ProjectError } from "../project/errors.js";
import { loadProjectById } from "../project/profile-resolver.js";
import { scanRepoSignals } from "../project/repo-signals.js";
import {
  compileProjectPolicy,
  loadCompileInputs,
} from "../project/policy-compiler.js";
import { resolvePolicy } from "../policy/resolver.js";

function getHarnessRoot(): string {
  return process.env.HARNESS_ROOT ?? process.cwd();
}

export function registerPolicyCommands(program: Command): void {
  const policyCmd = program
    .command("policy")
    .description("DB-canonical policy snapshot operations (Phase 17)");

  policyCmd
    .command("snapshot")
    .description("materialize an effective policy snapshot for a project")
    .requiredOption("--project <id>", "project id")
    .option("--domain <id>", "domain id (default: first domain in profile)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      await withPolicyErrorExit(async () => {
        const snapshot = await materializePolicySnapshot(raw);
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(snapshot, null, 2)}\n`
            : `policy snapshot: project=${snapshot.projectId} domain=${snapshot.domain} snapshot=${snapshot.snapshotId}\n`,
        );
      });
    });

  policyCmd
    .command("export")
    .description("export the latest effective policy snapshot for a project")
    .requiredOption("--project <id>", "project id")
    .requiredOption("--out <path>", "destination YAML path")
    .option("--domain <id>", "domain id (default: latest for any domain)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      await withPolicyErrorExit(async () => {
        const root = getHarnessRoot();
        const handle = openManagedDb({
          dbPath: harnessPaths(root).dbPath,
          readonly: true,
        });
        try {
          const row = handle.db
            .prepare(
              `SELECT snapshot_id, project_id, repo_id, domain,
                      generated_policy_yaml
                 FROM effective_policy_snapshots
                WHERE project_id = ?
                  AND (? IS NULL OR domain = ?)
                ORDER BY created_at DESC, snapshot_id DESC
                LIMIT 1`,
            )
            .get(
              String(raw.project),
              raw.domain === undefined ? null : String(raw.domain),
              raw.domain === undefined ? null : String(raw.domain),
            ) as
            | {
                snapshot_id: number;
                project_id: string;
                repo_id: string | null;
                domain: string | null;
                generated_policy_yaml: string;
              }
            | undefined;
          if (row === undefined) {
            throw new ProjectError(
              `no effective policy snapshot for project "${String(raw.project)}"`,
            );
          }
          const outPath = resolve(String(raw.out));
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, row.generated_policy_yaml, "utf8");
          const out = {
            snapshotId: row.snapshot_id,
            projectId: row.project_id,
            repoId: row.repo_id,
            domain: row.domain,
            path: outPath,
          };
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(out, null, 2)}\n`
              : `policy export: snapshot=${row.snapshot_id} out=${outPath}\n`,
          );
        } finally {
          handle.close();
        }
      });
    });
}

async function materializePolicySnapshot(
  raw: Record<string, unknown>,
): Promise<{
  snapshotId: number;
  projectId: string;
  repoId: string;
  domain: string;
}> {
  const root = getHarnessRoot();
  const paths = harnessPaths(root);
  const resolved = await loadProjectById(root, String(raw.project), {});
  if (resolved.repoPath === null) {
    throw new ProjectError(
      `project "${String(raw.project)}" has no repo.path; cannot compile policy`,
    );
  }
  if (!existsSync(resolved.repoPath)) {
    throw new ProjectError(`repo path does not exist: ${resolved.repoPath}`);
  }
  const domain = String(raw.domain ?? resolved.profile.domains[0]?.id ?? "");
  if (domain === "") {
    throw new ProjectError(`project "${String(raw.project)}" has no domains`);
  }
  const repoSignals = await scanRepoSignals(resolved.repoPath);
  const inputs = await loadCompileInputs(resolved.profile, resolved.profilePath, {
    templatesDir: paths.templatesDir,
    repoSignals,
    generatedAt: new Date().toISOString(),
  });
  const compiled = compileProjectPolicy(inputs);
  if (!Object.prototype.hasOwnProperty.call(compiled.repoPolicy.domains, domain)) {
    throw new ProjectError(
      `domain "${domain}" is not defined in project "${String(raw.project)}"`,
    );
  }
  const policy = resolvePolicy(compiled.globalPolicy, compiled.repoPolicy, domain);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    const snapshot = recordEffectivePolicySnapshot(handle.db, {
      projectId: compiled.projectId,
      repoId: compiled.repoId,
      domain,
      generatedPolicyYaml: yamlStringify(policy),
      provenance: {
        source: "policy snapshot CLI",
        profileSource: resolved.profileSource,
        profileRevisionId: resolved.profileRevisionId ?? null,
        policyTemplate: compiled.provenance.policyTemplate,
        commandPresets: compiled.provenance.commandPresets,
        contextPackPresets: compiled.provenance.contextPackPresets,
      },
    });
    return {
      snapshotId: snapshot.snapshotId,
      projectId: compiled.projectId,
      repoId: compiled.repoId,
      domain,
    };
  } finally {
    handle.close();
  }
}

async function withPolicyErrorExit(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    if (e instanceof ProjectError) {
      process.stderr.write(`harness error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}
