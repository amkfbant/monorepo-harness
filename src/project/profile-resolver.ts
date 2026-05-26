import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { harnessPaths } from "../config/paths.js";
import { DbError } from "../db/connection.js";
import { withManagedDb } from "../db/managed-connection.js";
import { getCurrentProjectProfile } from "../db/repositories/project-profile-revisions.js";
import {
  loadProjectProfile,
  parseProjectProfileYaml,
} from "./profile-loader.js";
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
  /** where the profile body came from; Phase 17 makes DB the preferred source. */
  profileSource: "db" | "file";
  /** DB revision id when `profileSource === "db"`. */
  profileRevisionId?: number;
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
    profileSource: "file",
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
  const paths = harnessPaths(harnessRoot);
  let profilePath: string;
  try {
    profilePath = paths.projectProfilePath(projectId);
  } catch (e) {
    throw new ProjectError(`invalid project id: ${(e as Error).message}`);
  }
  const dbProfile = loadDbProjectById(paths, projectId, profilePath, opts);
  if (dbProfile !== null) return dbProfile;
  if (!existsSync(profilePath)) {
    throw new ProjectNotFoundError(
      `no project profile for "${projectId}" (expected ${profilePath})`,
    );
  }
  return resolveProjectProfile(profilePath, opts);
}

function loadDbProjectById(
  paths: ReturnType<typeof harnessPaths>,
  projectId: string,
  profilePath: string,
  opts: ResolveProfileOpts,
): ResolvedProjectProfile | null {
  if (!existsSync(paths.dbPath)) return null;
  try {
    return withManagedDb(
      {
        dbPath: paths.dbPath,
        lockPath: paths.dbLockPath,
        readonly: true,
        timeoutMs: 250,
      },
      (db): ResolvedProjectProfile | null => {
        const revision = getCurrentProjectProfile(db, projectId);
        if (revision === null) return null;
        const profile = parseProjectProfileYaml(
          revision.bodyYaml,
          `db:project_profile_revisions:${revision.revisionId}`,
        );
        const sourcePath =
          revision.sourcePath !== null ? resolve(revision.sourcePath) : profilePath;
        return {
          profile,
          profilePath: sourcePath,
          repoPath: resolveRepoPath(sourcePath, profile, opts.repoOverride),
          profileSource: "db",
          profileRevisionId: revision.revisionId,
        };
      },
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (
      e instanceof DbError ||
      msg.includes("no such table: project_profile_revisions") ||
      msg.includes("no such column: current_profile_revision_id")
    ) {
      return null;
    }
    throw e;
  }
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
