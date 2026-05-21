import process from "node:process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import {
  loadProjectById,
  type ResolvedProjectProfile,
} from "../project/profile-resolver.js";
import { ProjectError } from "../project/errors.js";
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
    repoPath: r.repoPath,
    profile: r.profile,
  };
}

function formatProjectShow(r: ResolvedProjectProfile): string {
  const p = r.profile;
  const lines: string[] = [];
  lines.push(`Project: ${p.project_id}`);
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
