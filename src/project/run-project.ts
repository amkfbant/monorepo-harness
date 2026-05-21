import { harnessPaths } from "../config/paths.js";
import { resolvePolicy } from "../policy/resolver.js";
import type {
  GlobalPolicy,
  RepoPolicy,
  ResolvedPolicy,
} from "../policy/schema.js";
import type { RunMeta } from "../logging/run-log.js";
import { loadProjectById } from "./profile-resolver.js";
import { ProjectError } from "./errors.js";
import { scanRepoSignals } from "./repo-signals.js";
import { loadCompileInputs, compileProjectPolicy } from "./policy-compiler.js";
import {
  normalizeInlineContextPack,
  normalizeContextPackPreset,
  type NormalizedContextPack,
} from "./context-pack-spec.js";
import {
  assembleProjectContextPacks,
  type AssembledContextPacks,
} from "./run-context-packs.js";

/**
 * Prepare a `harness run --project` invocation (Phase 5-7).
 *
 * Loads the profile, compiles its policy, resolves the requested domain,
 * and assembles the domain's context packs — everything the workflow
 * needs to run a profile-driven domain task.
 */

export interface PreparedProjectRun {
  repoPath: string;
  repoId: string;
  domain: string;
  /** the profile's base branch (repo.base_branch, defaulting to "main") */
  baseBranch: string;
  compiledPolicy: { global: GlobalPolicy; repo: RepoPolicy };
  /** the resolved policy for the requested domain (used by --dry-run) */
  resolvedPolicy: ResolvedPolicy;
  project: NonNullable<RunMeta["project"]>;
  projectContextPacks?: AssembledContextPacks;
}

export async function prepareProjectRun(opts: {
  harnessRoot: string;
  projectId: string;
  domain: string;
  repoOverride?: string;
}): Promise<PreparedProjectRun> {
  const resolved = await loadProjectById(opts.harnessRoot, opts.projectId, {
    ...(opts.repoOverride !== undefined
      ? { repoOverride: opts.repoOverride }
      : {}),
  });
  const { profile, profilePath, repoPath } = resolved;
  if (repoPath === null) {
    throw new ProjectError(
      `project "${opts.projectId}" has no repo.path — pass --repo`,
    );
  }
  const domainSpec = profile.domains.find((d) => d.id === opts.domain);
  if (domainSpec === undefined) {
    throw new ProjectError(
      `domain "${opts.domain}" is not defined in project "${opts.projectId}"`,
    );
  }

  const repoSignals = await scanRepoSignals(repoPath);
  const inputs = await loadCompileInputs(profile, profilePath, {
    templatesDir: harnessPaths(opts.harnessRoot).templatesDir,
    repoSignals,
    generatedAt: new Date().toISOString(),
  });
  const compiled = compileProjectPolicy(inputs);
  const resolvedPolicy = resolvePolicy(
    compiled.globalPolicy,
    compiled.repoPolicy,
    opts.domain,
  );

  // resolve the domain's context packs (inline definition wins; otherwise a
  // catalog preset) and assemble them for the prompt.
  const packs: NormalizedContextPack[] = [];
  for (const ref of domainSpec.context_packs ?? []) {
    const inline = profile.context_packs?.[ref];
    if (inline !== undefined) {
      packs.push(normalizeInlineContextPack(ref, inline));
      continue;
    }
    const preset = inputs.contextPackPresets.get(ref);
    if (preset !== undefined) {
      packs.push(normalizeContextPackPreset(preset));
    }
    // an unresolved ref already produced a compiler warning — skip it here.
  }
  const assembled =
    packs.length > 0
      ? await assembleProjectContextPacks({ repoPath, packs })
      : undefined;

  const project: NonNullable<RunMeta["project"]> = {
    projectId: compiled.projectId,
    profilePath,
    profileVersion: profile.version,
    ...(compiled.provenance.policyTemplate !== null
      ? { policyTemplateId: compiled.provenance.policyTemplate.id }
      : {}),
    commandPresetIds: compiled.provenance.commandPresets.map((p) => p.id),
    contextPackIds: assembled?.packIds ?? [],
  };

  return {
    repoPath,
    repoId: compiled.repoId,
    domain: opts.domain,
    baseBranch: profile.repo.base_branch ?? "main",
    compiledPolicy: {
      global: compiled.globalPolicy,
      repo: compiled.repoPolicy,
    },
    resolvedPolicy,
    project,
    ...(assembled !== undefined ? { projectContextPacks: assembled } : {}),
  };
}
