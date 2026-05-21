import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { harnessPaths } from "../config/paths.js";
import { loadProjectProfile } from "./profile-loader.js";
import { ProjectError, ProjectNotFoundError } from "./errors.js";
import type { ProjectProfile } from "./schema.js";

export interface ResolvedProjectProfile {
  profile: ProjectProfile;
  /** absolute path to the profile YAML it was loaded from */
  profilePath: string;
  /**
   * absolute path to the target repo, or null when `repo.path` is absent
   * and no `--repo` override was given. Commands that need to read the
   * repo (inspect / check / run) must require this; `project show` does not.
   */
  repoPath: string | null;
}

export interface ResolveProfileOpts {
  /** `--repo` override; takes precedence over the profile's `repo.path` */
  repoOverride?: string;
}

/**
 * Load a profile from an explicit path and resolve its target repo path.
 *
 * `repo.path` is resolved relative to the profile file's directory (an
 * absolute `repo.path` is used as-is). A `--repo` override wins outright.
 */
export async function resolveProjectProfile(
  profilePath: string,
  opts: ResolveProfileOpts = {},
): Promise<ResolvedProjectProfile> {
  if (opts.repoOverride !== undefined && opts.repoOverride.includes("\0")) {
    throw new ProjectError("--repo path must not contain a NUL byte");
  }
  const absProfile = resolve(profilePath);
  const profile = await loadProjectProfile(absProfile);
  return {
    profile,
    profilePath: absProfile,
    repoPath: resolveRepoPath(absProfile, profile, opts.repoOverride),
  };
}

/** Resolve `projects/<id>.yaml` under a harness root, then load it. */
export async function loadProjectById(
  harnessRoot: string,
  projectId: string,
  opts: ResolveProfileOpts = {},
): Promise<ResolvedProjectProfile> {
  // projectProfilePath validates the id; assertValidRepoId throws a plain
  // Error, so wrap it as ProjectError to keep the CLI's exit-1 mapping.
  let profilePath: string;
  try {
    profilePath = harnessPaths(harnessRoot).projectProfilePath(projectId);
  } catch (e) {
    throw new ProjectError(`invalid project id: ${(e as Error).message}`);
  }
  if (!existsSync(profilePath)) {
    throw new ProjectNotFoundError(
      `no project profile for "${projectId}" (expected ${profilePath})`,
    );
  }
  return resolveProjectProfile(profilePath, opts);
}

function resolveRepoPath(
  absProfile: string,
  profile: ProjectProfile,
  override: string | undefined,
): string | null {
  if (override !== undefined) return resolve(override);
  const declared = profile.repo.path;
  if (declared === undefined) return null;
  if (isAbsolute(declared)) return declared;
  return resolve(dirname(absProfile), declared);
}
