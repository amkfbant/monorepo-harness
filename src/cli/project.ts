import process from "node:process";
import { existsSync, statSync } from "node:fs";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import {
  getCurrentProjectProfile,
  recordProjectProfileRevision,
} from "../db/repositories/project-profile-revisions.js";
import {
  loadProjectById,
  type ResolvedProjectProfile,
} from "../project/profile-resolver.js";
import { ProjectError } from "../project/errors.js";
import { parseProjectProfileYaml } from "../project/profile-loader.js";
import { scanRepoSignals } from "../project/repo-signals.js";
import {
  loadDomainRegistry,
  selectDefaultRegistryId,
} from "../project/domain-registry.js";
import {
  inspectProject,
  formatInspectText,
  formatInspectJson,
} from "../project/inspector.js";
import { runProjectInit, type InitResult } from "../project/init.js";
import { formatProposalMarkdown } from "../project/format-proposal.js";
import { checkProject } from "../project/checker.js";
import {
  formatCheckText,
  formatCheckJson,
} from "../project/format-check.js";

function getHarnessRoot(): string {
  return process.env.HARNESS_ROOT ?? process.cwd();
}

/**
 * Register the `harness project ...` command group (Phase 5).
 *
 * Kept in its own module so `run.ts` does not keep growing. Later phases
 * add `inspect` / `init` / `check` subcommands here.
 */
export function registerProjectCommands(program: Command): void {
  const projectCmd = program
    .command("project")
    .description("project profile management (Phase 5)");

  projectCmd
    .command("show")
    .description("display a project profile")
    .requiredOption("--project <id>", "project id (projects/<id>.yaml)")
    .option("--repo <path>", "override the profile's repo path")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      await withProjectErrorExit(async () => {
        const resolved = await loadProjectById(
          getHarnessRoot(),
          String(raw.project),
          raw.repo !== undefined ? { repoOverride: String(raw.repo) } : {},
        );
        process.stdout.write(
          raw.json
            ? `${JSON.stringify(toShowJson(resolved), null, 2)}\n`
            : formatProjectShow(resolved),
        );
      });
    });

  projectCmd
    .command("import")
    .description("import a project profile YAML into the DB canonical store")
    .argument("<path>", "project profile YAML path")
    .option("--actor <actor>", "actor label", "cli")
    .option("--reason <text>", "revision reason")
    .option("--json", "emit JSON instead of text", false)
    .action(async (pathArg: string, raw: Record<string, unknown>) => {
      await withProjectErrorExit(async () => {
        const path = resolve(pathArg);
        if (!existsSync(path)) throw new ProjectError(`file not found: ${path}`);
        const bodyYaml = readFileSync(path, "utf8");
        const profile = parseProjectProfileYaml(bodyYaml, path);
        const handle = openManagedDb({ dbPath: harnessPaths(getHarnessRoot()).dbPath });
        try {
          runMigrations(handle.db);
          const result = recordProjectProfileRevision(handle.db, {
            projectId: profile.project_id,
            bodyYaml,
            parsed: profile,
            actor: String(raw.actor),
            ...(raw.reason !== undefined ? { reason: String(raw.reason) } : {}),
          });
          upsertProjectMetadata(handle.db, profile, path);
          const out = {
            projectId: profile.project_id,
            revisionId: result.revision.revisionId,
            version: result.revision.version,
            reusedExisting: result.reusedExisting,
          };
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(out, null, 2)}\n`
              : `project import: ${profile.project_id} revision=${result.revision.revisionId} version=${result.revision.version}${result.reusedExisting ? " (reused)" : ""}\n`,
          );
        } finally {
          handle.close();
        }
      });
    });

  projectCmd
    .command("export")
    .description("export the DB-current project profile YAML")
    .requiredOption("--project <id>", "project id")
    .requiredOption("--out <path>", "destination YAML path")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      await withProjectErrorExit(async () => {
        const handle = openManagedDb({
          dbPath: harnessPaths(getHarnessRoot()).dbPath,
          readonly: true,
        });
        try {
          const revision = getCurrentProjectProfile(handle.db, String(raw.project));
          if (revision === null) {
            throw new ProjectError(
              `no DB-current project profile for "${String(raw.project)}"`,
            );
          }
          const outPath = resolve(String(raw.out));
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, revision.bodyYaml, "utf8");
          const out = {
            projectId: revision.projectId,
            revisionId: revision.revisionId,
            path: outPath,
          };
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify(out, null, 2)}\n`
              : `project export: ${revision.projectId} revision=${revision.revisionId} out=${outPath}\n`,
          );
        } finally {
          handle.close();
        }
      });
    });

  projectCmd
    .command("edit")
    .description("edit the DB-current project profile using $EDITOR")
    .argument("<project-id>", "project id")
    .option("--actor <actor>", "actor label", "cli")
    .option("--reason <text>", "revision reason", "manual edit")
    .action(async (projectId: string, raw: Record<string, unknown>) => {
      await withProjectErrorExit(async () => {
        const editor = process.env.EDITOR;
        if (!editor) {
          throw new ProjectError(
            "$EDITOR is not set; use project export/import to edit explicitly",
          );
        }
        const paths = harnessPaths(getHarnessRoot());
        const handle = openManagedDb({ dbPath: paths.dbPath });
        try {
          runMigrations(handle.db);
          const revision = getCurrentProjectProfile(handle.db, projectId);
          if (revision === null) {
            throw new ProjectError(
              `no DB-current project profile for "${projectId}"`,
            );
          }
          const dir = mkdtempSync(join(tmpdir(), "harness-project-edit-"));
          const editPath = join(dir, `${projectId}.yaml`);
          writeFileSync(editPath, revision.bodyYaml, "utf8");
          const child = spawnSync(editor, [editPath], { stdio: "inherit" });
          if (child.status !== 0) {
            throw new ProjectError(`editor exited with status ${child.status}`);
          }
          const bodyYaml = readFileSync(editPath, "utf8");
          const profile = parseProjectProfileYaml(bodyYaml, editPath);
          if (profile.project_id !== projectId) {
            throw new ProjectError(
              `edited profile changed project_id from "${projectId}" to "${profile.project_id}"`,
            );
          }
          const result = recordProjectProfileRevision(handle.db, {
            projectId,
            bodyYaml,
            parsed: profile,
            actor: String(raw.actor),
            reason: String(raw.reason),
          });
          upsertProjectMetadata(
            handle.db,
            profile,
            revision.sourcePath ?? paths.projectProfilePath(projectId),
          );
          process.stdout.write(
            `project edit: ${projectId} revision=${result.revision.revisionId} version=${result.revision.version}${result.reusedExisting ? " (unchanged)" : ""}\n`,
          );
        } finally {
          handle.close();
        }
      });
    });

  projectCmd
    .command("inspect")
    .description("statically inspect a repo and propose candidate domains")
    .requiredOption("--repo <path>", "target repo path")
    .option("--registry <id>", "domain registry id (auto-selected if omitted)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      await withProjectErrorExit(async () => {
        const repoPath = resolve(String(raw.repo));
        if (!existsSync(repoPath)) {
          throw new ProjectError(`repo path does not exist: ${repoPath}`);
        }
        if (!statSync(repoPath).isDirectory()) {
          throw new ProjectError(`repo path is not a directory: ${repoPath}`);
        }
        const signals = await scanRepoSignals(repoPath);
        const registryId =
          raw.registry !== undefined
            ? String(raw.registry)
            : selectDefaultRegistryId(signals);
        const registry = await loadDomainRegistry(
          harnessPaths(getHarnessRoot()).templatesDir,
          registryId,
        );
        const result = inspectProject(signals, registry);
        process.stdout.write(
          raw.json ? formatInspectJson(result) : formatInspectText(result),
        );
      });
    });

  projectCmd
    .command("init")
    .description("build a project profile from a repo or an existing policy")
    .requiredOption("--project-id <id>", "new project id")
    .option(
      "--repo <path>",
      "repo to inspect (mode A); with --from-policy, the repo path to embed",
    )
    .option(
      "--from-policy <repo-id>",
      "existing policies/repos/<id>.yaml to migrate (mode B)",
    )
    .option("--registry <id>", "domain registry id (auto-selected if omitted)")
    .option("--dry-run", "show the proposal, write nothing", false)
    .option("--write", "write the profile / policy / provenance files", false)
    .option("--force", "overwrite existing files", false)
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      await withProjectErrorExit(async () => {
        if (raw.write === true && raw.dryRun === true) {
          throw new ProjectError(
            "--write and --dry-run are mutually exclusive",
          );
        }
        if (raw.repo === undefined && raw.fromPolicy === undefined) {
          throw new ProjectError(
            "project init requires --repo or --from-policy",
          );
        }
        const result = await runProjectInit({
          harnessRoot: getHarnessRoot(),
          projectId: String(raw.projectId),
          ...(raw.repo !== undefined ? { repoPath: String(raw.repo) } : {}),
          ...(raw.registry !== undefined
            ? { registryId: String(raw.registry) }
            : {}),
          ...(raw.fromPolicy !== undefined
            ? { fromPolicyRepoId: String(raw.fromPolicy) }
            : {}),
          write: raw.write === true,
          force: raw.force === true,
          generatedAt: new Date().toISOString(),
        });
        process.stdout.write(
          raw.json
            ? `${JSON.stringify(toInitJson(result), null, 2)}\n`
            : formatInitText(result, getHarnessRoot()),
        );
      });
    });

  projectCmd
    .command("check")
    .description("validate a project profile without running Codex")
    .requiredOption("--project <id>", "project id (projects/<id>.yaml)")
    .option("--repo <path>", "override the profile's repo path")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      await withProjectErrorExit(async () => {
        const report = await checkProject({
          harnessRoot: getHarnessRoot(),
          projectId: String(raw.project),
          ...(raw.repo !== undefined ? { repoOverride: String(raw.repo) } : {}),
          generatedAt: new Date().toISOString(),
        });
        process.stdout.write(
          raw.json ? formatCheckJson(report) : formatCheckText(report),
        );
        // a config error fails the command (CI gate); ok/warn pass.
        if (report.status === "error") process.exit(1);
      });
    });
}

function toInitJson(r: InitResult): unknown {
  return {
    projectId: r.proposal.result.projectId,
    repoId: r.proposal.result.repoId,
    profilePath: r.profilePath,
    repoPolicyPath: r.proposal.repoPolicyPath,
    provenancePath: r.proposal.provenancePath,
    written: r.written,
    warnings: r.proposal.result.warnings,
    domains: r.proposal.domains,
  };
}

function formatInitText(r: InitResult, harnessRoot: string): string {
  if (r.written.length === 0) {
    return formatProposalMarkdown(r.proposal, harnessRoot);
  }
  const lines = [`project init: wrote ${r.written.length} file(s)`];
  for (const f of r.written) lines.push(`  ${f}`);
  lines.push("");
  lines.push(
    `Next: harness project check --project ${r.proposal.result.projectId}`,
  );
  lines.push("");
  return lines.join("\n");
}

/** Run a project command body, mapping ProjectError to exit 1. */
async function withProjectErrorExit(body: () => Promise<void>): Promise<void> {
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

function toShowJson(r: ResolvedProjectProfile): unknown {
  return {
    projectId: r.profile.project_id,
    profilePath: r.profilePath,
    profileSource: r.profileSource,
    ...(r.profileRevisionId !== undefined
      ? { profileRevisionId: r.profileRevisionId }
      : {}),
    repoPath: r.repoPath,
    profile: r.profile,
  };
}

function formatProjectShow(r: ResolvedProjectProfile): string {
  const p = r.profile;
  const lines: string[] = [];
  lines.push(`Project: ${p.project_id}`);
  lines.push(
    `profileSource: ${r.profileSource}` +
      (r.profileRevisionId !== undefined
        ? ` (revision ${r.profileRevisionId})`
        : ""),
  );
  if (p.description) lines.push(`description: ${p.description}`);
  lines.push("");
  lines.push("repo:");
  lines.push(`  id: ${p.repo.id}`);
  lines.push(`  path: ${r.repoPath ?? "(unresolved — pass --repo)"}`);
  lines.push(`  baseBranch: ${p.repo.base_branch ?? "main"}`);
  lines.push(`  packageManager: ${p.repo.package_manager ?? "unknown"}`);
  lines.push("");
  lines.push(`policy template: ${p.policy?.template ?? "(none)"}`);
  lines.push(
    `command presets: ${fmtList(p.commands?.presets)}`,
  );
  lines.push(
    `context packs: ${fmtList(Object.keys(p.context_packs ?? {}))}`,
  );
  lines.push("");
  lines.push(`domains (${p.domains.length}):`);
  for (const d of p.domains) {
    const kind = d.kind ?? "other";
    const title = d.title ? `  title=${JSON.stringify(d.title)}` : "";
    lines.push(`  ${d.id}  kind=${kind}  root=${d.root}${title}`);
  }
  lines.push("");
  return lines.join("\n");
}

function fmtList(items: string[] | undefined): string {
  return items && items.length > 0 ? items.join(", ") : "(none)";
}

function upsertProjectMetadata(
  db: Database.Database,
  profile: ResolvedProjectProfile["profile"],
  profilePath: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (project_id, repo_id, profile_path,
       profile_version, description, repo_path, base_branch,
       package_manager, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       repo_id = excluded.repo_id,
       profile_path = excluded.profile_path,
       profile_version = excluded.profile_version,
       description = excluded.description,
       repo_path = excluded.repo_path,
       base_branch = excluded.base_branch,
       package_manager = excluded.package_manager,
       updated_at = excluded.updated_at`,
  ).run(
    profile.project_id,
    profile.repo.id,
    profilePath,
    profile.version,
    profile.description ?? null,
    profile.repo.path ?? null,
    profile.repo.base_branch ?? null,
    profile.repo.package_manager ?? null,
    now,
    now,
  );
}
