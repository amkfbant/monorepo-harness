import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import {
  ProjectProfileSchema,
  type ProjectProfile,
} from "../../project/schema.js";
import {
  recordProjectProfileRevision,
  type CurrentPointerMode,
} from "../repositories/project-profile-revisions.js";
import {
  sha256,
  recordImportError,
  clearImportError,
  type ImportCounters,
} from "./common.js";

/** Stable surrogate key for a domain row (overview §5 / schema.ts). */
export function domainKey(
  repoId: string,
  domainId: string,
  projectId: string | null,
): string {
  // JSON array — unambiguous, collision-safe, no control chars in source
  return sha256(JSON.stringify([repoId, domainId, projectId ?? ""]));
}

export interface WriteProjectProfileImportRowsInput {
  profile: ProjectProfile;
  profilePath: string;
  bodyYaml: string;
  loadedAt: Date | string;
}

/**
 * Write the project profile rows that remain as compatibility/read-model
 * surfaces while `project_profile_revisions` is the canonical body store.
 *
 * Callers decide the surrounding transaction. Single-profile import passes
 * this through `recordProjectProfileRevision(..., writeThrough)` so projects,
 * project_profile_revisions, project_profiles, and domains commit atomically.
 */
export function writeProjectProfileImportRows(
  db: Database.Database,
  input: WriteProjectProfileImportRowsInput,
): void {
  const { profile, profilePath, bodyYaml } = input;
  const loadedAt =
    typeof input.loadedAt === "string"
      ? input.loadedAt
      : input.loadedAt.toISOString();
  db.prepare(
    `INSERT INTO projects (project_id, repo_id, profile_path, profile_version,
       description, repo_path, base_branch, package_manager, created_at, updated_at)
     VALUES (@project_id, @repo_id, @profile_path, @profile_version,
       @description, @repo_path, @base_branch, @package_manager, @created_at, @updated_at)
     ON CONFLICT (project_id) DO UPDATE SET
       repo_id = excluded.repo_id, profile_path = excluded.profile_path,
       profile_version = excluded.profile_version, description = excluded.description,
       repo_path = excluded.repo_path, base_branch = excluded.base_branch,
       package_manager = excluded.package_manager,
       created_at = COALESCE(projects.created_at, excluded.created_at),
       updated_at = excluded.updated_at`,
  ).run({
    project_id: profile.project_id,
    repo_id: profile.repo.id,
    profile_path: profilePath,
    profile_version: profile.version,
    description: profile.description ?? null,
    repo_path: profile.repo.path ?? null,
    base_branch: profile.repo.base_branch ?? null,
    package_manager: profile.repo.package_manager ?? null,
    created_at: loadedAt,
    updated_at: loadedAt,
  });
  db.prepare(
    `INSERT INTO project_profiles (project_id, version, source_yaml, source_sha256, loaded_at)
     VALUES (@project_id, @version, @source_yaml, @source_sha256, @loaded_at)
     ON CONFLICT (project_id, version) DO UPDATE SET
       source_yaml = excluded.source_yaml, source_sha256 = excluded.source_sha256,
       loaded_at = excluded.loaded_at`,
  ).run({
    project_id: profile.project_id,
    version: profile.version,
    source_yaml: bodyYaml,
    source_sha256: sha256(bodyYaml),
    loaded_at: loadedAt,
  });
  db.prepare("DELETE FROM domains WHERE project_id = ?").run(profile.project_id);
  const upsertDomain = db.prepare(
    `INSERT INTO domains (domain_key, project_id, repo_id, domain_id, root, kind, title)
     VALUES (@domain_key, @project_id, @repo_id, @domain_id, @root, @kind, @title)
     ON CONFLICT (domain_key) DO UPDATE SET
       root = excluded.root, kind = excluded.kind, title = excluded.title`,
  );
  for (const d of profile.domains) {
    upsertDomain.run({
      domain_key: domainKey(profile.repo.id, d.id, profile.project_id),
      project_id: profile.project_id,
      repo_id: profile.repo.id,
      domain_id: d.id,
      root: d.root,
      kind: d.kind ?? null,
      title: null,
    });
  }
}

/**
 * Import `projects/*.yaml` into `projects` / `project_profiles` /
 * `domains`. Each profile is validated with `ProjectProfileSchema`; a
 * malformed file is recorded in `import_errors` and skipped.
 */
export function importProjects(
  db: Database.Database,
  projectsDir: string,
  counters: ImportCounters,
  opts: { currentPointerMode?: CurrentPointerMode } = {},
): void {
  if (!existsSync(projectsDir)) return;
  const files = readdirSync(projectsDir).filter((f) => f.endsWith(".yaml"));
  const currentPointerMode = opts.currentPointerMode ?? "set-current";
  const currentProject = db.prepare(
    `SELECT current_profile_revision_id
       FROM projects
      WHERE project_id = ?`,
  );

  for (const file of files) {
    const path = join(projectsDir, file);
    let profile;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
      const parsed = ProjectProfileSchema.safeParse(parseYaml(raw));
      if (!parsed.success) {
        recordImportError(db, counters, path, "project", parsed.error.message);
        continue;
      }
      profile = parsed.data;
    } catch (e) {
      recordImportError(db, counters, path, "project", (e as Error).message);
      continue;
    }

    // timestamps come from the source file's mtime, not wall-clock time,
    // so re-importing an unchanged profile yields an identical row
    // (idempotency).
    const mtime = new Date(statSync(path).mtimeMs);
    const existing = currentProject.get(profile.project_id) as
      | { current_profile_revision_id: number | null }
      | undefined;
    const mayUpdateCurrentAsset =
      currentPointerMode === "set-current" ||
      (currentPointerMode === "if-missing" &&
        existing?.current_profile_revision_id == null);
    if (!mayUpdateCurrentAsset) {
      clearImportError(db, path);
      continue;
    }

    recordProjectProfileRevision(db, {
      projectId: profile.project_id,
      bodyYaml: raw,
      parsed: profile,
      actor: "db-import",
      reason: "compatibility project profile import",
      now: mtime,
      currentPointerMode,
      writeThrough: (txDb) =>
        writeProjectProfileImportRows(txDb, {
          profile,
          profilePath: path,
          bodyYaml: raw,
          loadedAt: mtime,
        }),
    });
    clearImportError(db, path);
    counters.projects += 1;
  }
}
