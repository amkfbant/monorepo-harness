import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  linkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, relative, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { harnessPaths } from "../config/paths.js";
import { loadRepoPolicy } from "../policy/loader.js";
import { ProjectProfileSchema, type ProjectProfile } from "./schema.js";
import { scanRepoSignals, type RepoSignals } from "./repo-signals.js";
import {
  loadDomainRegistry,
  selectDefaultRegistryId,
} from "./domain-registry.js";
import { inspectProject, type InspectResult } from "./inspector.js";
import { migratePolicyToProfile } from "./policy-migrator.js";
import { loadCompileInputs, compileProjectPolicy } from "./policy-compiler.js";
import { buildPolicyProposal, type PolicyProposal } from "./policy-proposal.js";
import { ProjectError, ProjectProfileError } from "./errors.js";

/**
 * `project init` engine (Phase 5-5).
 *
 * Builds a project profile — by inspecting a repo, or by migrating an
 * existing repo policy — compiles it, and either shows the proposal
 * (--dry-run) or safely writes the profile + repo policy + provenance.
 */

const DEFAULT_TEMPLATE = "strict-monorepo-v1";

export interface InitOptions {
  harnessRoot: string;
  projectId: string;
  /** mode A: build the profile by inspecting this repo */
  repoPath?: string;
  /** mode A: domain registry id (auto-selected when omitted) */
  registryId?: string;
  /** mode B: migrate this existing policies/repos/<id>.yaml */
  fromPolicyRepoId?: string;
  /** write the files (false → dry-run, never writes) */
  write: boolean;
  /** allow overwriting existing files */
  force: boolean;
  /** ISO instant recorded in provenance */
  generatedAt: string;
}

export interface InitResult {
  proposal: PolicyProposal;
  profileYaml: string;
  profilePath: string;
  /** absolute paths written (empty for a dry-run) */
  written: string[];
}

export async function runProjectInit(
  opts: InitOptions,
): Promise<InitResult> {
  const paths = harnessPaths(opts.harnessRoot);
  // projectProfilePath validates the id; wrap the plain Error.
  let profilePath: string;
  try {
    profilePath = paths.projectProfilePath(opts.projectId);
  } catch (e) {
    throw new ProjectError(`invalid project id: ${(e as Error).message}`);
  }

  const { profile, repoSignals } = await buildProfile(opts, paths);
  const profileYaml = stringifyYaml(profile, { sortMapEntries: false });

  const inputs = await loadCompileInputs(profile, profilePath, {
    templatesDir: paths.templatesDir,
    ...(repoSignals !== undefined ? { repoSignals } : {}),
    generatedAt: opts.generatedAt,
  });
  const proposal = buildPolicyProposal(
    compileProjectPolicy(inputs),
    opts.harnessRoot,
  );

  const written: string[] = [];
  if (opts.write) {
    writeProjectFiles(
      [
        { path: profilePath, content: profileYaml },
        { path: proposal.repoPolicyPath, content: proposal.repoPolicyYaml },
        { path: proposal.provenancePath, content: proposal.provenanceJson },
      ],
      opts.force,
      written,
    );
  }

  return { proposal, profileYaml, profilePath, written };
}

interface WriteTarget {
  path: string;
  content: string;
}

/**
 * Write the project files transactionally-ish: preflight every target,
 * then write each atomically. If a write fails midway, roll back the
 * files this call newly created (an overwritten file cannot be restored,
 * but `--force` is an explicit opt-in to that risk).
 */
function writeProjectFiles(
  targets: WriteTarget[],
  force: boolean,
  written: string[],
): void {
  if (!force) {
    const clash = targets.find((t) => existsSync(t.path));
    if (clash !== undefined) {
      throw new ProjectError(
        `refusing to overwrite existing file: ${clash.path} (pass --force)`,
      );
    }
  }
  const preExisted = new Map(
    targets.map((t) => [t.path, existsSync(t.path)] as const),
  );
  for (const t of targets) {
    try {
      atomicWrite(t.path, t.content, force);
      written.push(t.path);
    } catch (e) {
      for (const w of written) {
        if (preExisted.get(w) === false) {
          try {
            rmSync(w);
          } catch {
            // best-effort rollback
          }
        }
      }
      throw new ProjectError(
        `project init failed writing ${t.path}: ${(e as Error).message}`,
      );
    }
  }
}

/**
 * Atomically create `path`. Without `force`, `linkSync` is the no-clobber
 * gate — it fails with EEXIST if the path already exists, with no TOCTOU
 * window. With `force`, `renameSync` replaces atomically.
 */
function atomicWrite(path: string, content: string, force: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${dirname(path)}/.${basename(path)}.${randomUUID()}.tmp`;
  // "wx" — the temp name must not pre-exist either.
  writeFileSync(tmp, content, { flag: "wx" });
  try {
    if (force) {
      renameSync(tmp, path);
    } else {
      linkSync(tmp, path);
      rmSync(tmp);
    }
  } catch (e) {
    try {
      rmSync(tmp);
    } catch {
      // temp may already be gone
    }
    throw e;
  }
}

async function buildProfile(
  opts: InitOptions,
  paths: ReturnType<typeof harnessPaths>,
): Promise<{ profile: ProjectProfile; repoSignals?: RepoSignals }> {
  // mode B: migrate an existing repo policy.
  if (opts.fromPolicyRepoId !== undefined) {
    let repoPolicy;
    try {
      repoPolicy = await loadRepoPolicy(
        paths.repoPolicyPath(opts.fromPolicyRepoId),
      );
    } catch (e) {
      throw new ProjectError(
        `cannot load policy "${opts.fromPolicyRepoId}": ${(e as Error).message}`,
      );
    }
    const profile = migratePolicyToProfile(repoPolicy, {
      projectId: opts.projectId,
      policyTemplate: DEFAULT_TEMPLATE,
      ...(opts.repoPath !== undefined
        ? { repoPath: profileRelativeRepoPath(paths, opts.repoPath) }
        : {}),
    });
    const repoSignals =
      opts.repoPath !== undefined
        ? await scanRepoSignals(resolve(opts.repoPath))
        : undefined;
    return repoSignals !== undefined
      ? { profile, repoSignals }
      : { profile };
  }

  // mode A: inspect a repo.
  if (opts.repoPath === undefined) {
    throw new ProjectError("project init requires --repo or --from-policy");
  }
  const repoPath = resolve(opts.repoPath);
  if (!existsSync(repoPath)) {
    throw new ProjectError(`repo path does not exist: ${repoPath}`);
  }
  const repoSignals = await scanRepoSignals(repoPath);
  const registryId =
    opts.registryId ?? selectDefaultRegistryId(repoSignals);
  const registry = await loadDomainRegistry(paths.templatesDir, registryId);
  const inspectResult = inspectProject(repoSignals, registry);
  return {
    profile: profileFromInspect(opts, paths, repoSignals, inspectResult),
    repoSignals,
  };
}

function profileFromInspect(
  opts: InitOptions,
  paths: ReturnType<typeof harnessPaths>,
  signals: RepoSignals,
  inspect: InspectResult,
): ProjectProfile {
  if (inspect.candidates.length === 0) {
    throw new ProjectError(
      "project inspect found no candidate domains — cannot init a profile",
    );
  }
  const template =
    inspect.candidates[0]?.suggestedPolicyTemplate ?? DEFAULT_TEMPLATE;
  const domains = inspect.candidates.map((c) => ({
    id: c.id,
    root: c.root,
    kind: c.kind,
    ...(c.suggestedCommandPresets.length > 0
      ? { command_presets: c.suggestedCommandPresets }
      : {}),
    ...(c.suggestedContextPacks.length > 0
      ? { context_packs: c.suggestedContextPacks }
      : {}),
  }));
  const raw = {
    version: 1,
    project_id: opts.projectId,
    description: `Initialized by 'project init' from ${signals.repoPath}`,
    repo: {
      id: opts.projectId,
      path: profileRelativeRepoPath(paths, signals.repoPath),
      package_manager: signals.packageManager,
    },
    policy: { template },
    domains,
  };
  const result = ProjectProfileSchema.safeParse(raw);
  if (!result.success) {
    throw new ProjectProfileError(
      `generated profile failed validation:\n${result.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}`,
    );
  }
  return result.data;
}

/** repo path expressed relative to the projects/ dir (where the profile lives). */
function profileRelativeRepoPath(
  paths: ReturnType<typeof harnessPaths>,
  repoPath: string,
): string {
  return relative(paths.projectsDir, resolve(repoPath));
}
