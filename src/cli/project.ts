import process from "node:process";
import type { Command } from "commander";
import {
  loadProjectById,
  type ResolvedProjectProfile,
} from "../project/profile-resolver.js";
import { ProjectError } from "../project/errors.js";

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
      try {
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
      } catch (e) {
        if (e instanceof ProjectError) {
          process.stderr.write(`harness error: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
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
