import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { ProjectProfileSchema } from "../../project/schema.js";
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

  const upsertProject = db.prepare(
    `INSERT INTO projects (project_id, repo_id, profile_path, profile_version,
       description, repo_path, base_branch, package_manager, created_at, updated_at)
     VALUES (@project_id, @repo_id, @profile_path, @profile_version,
       @description, @repo_path, @base_branch, @package_manager, @created_at, @updated_at)
     ON CONFLICT (project_id) DO UPDATE SET
       repo_id = excluded.repo_id, profile_path = excluded.profile_path,
       profile_version = excluded.profile_version, description = excluded.description,
       repo_path = excluded.repo_path, base_branch = excluded.base_branch,
       package_manager = excluded.package_manager, updated_at = excluded.updated_at`,
  );
  const upsertProfile = db.prepare(
    `INSERT INTO project_profiles (project_id, version, source_yaml, source_sha256, loaded_at)
     VALUES (@project_id, @version, @source_yaml, @source_sha256, @loaded_at)
     ON CONFLICT (project_id, version) DO UPDATE SET
       source_yaml = excluded.source_yaml, source_sha256 = excluded.source_sha256,
       loaded_at = excluded.loaded_at`,
  );
  const upsertDomain = db.prepare(
    `INSERT INTO domains (domain_key, project_id, repo_id, domain_id, root, kind, title)
     VALUES (@domain_key, @project_id, @repo_id, @domain_id, @root, @kind, @title)
     ON CONFLICT (domain_key) DO UPDATE SET
       root = excluded.root, kind = excluded.kind, title = excluded.title`,
  );
  // a domain dropped from the profile must not linger — replace the whole
  // set per project.
  const deleteDomains = db.prepare(
    "DELETE FROM domains WHERE project_id = ?",
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
    const mtime = new Date(statSync(path).mtimeMs).toISOString();
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

    const tx = db.transaction(() => {
      upsertProject.run({
        project_id: profile.project_id,
        repo_id: profile.repo.id,
        profile_path: path,
        profile_version: profile.version,
        description: profile.description ?? null,
        repo_path: profile.repo.path ?? null,
        base_branch: profile.repo.base_branch ?? null,
        package_manager: profile.repo.package_manager ?? null,
        created_at: mtime,
        updated_at: mtime,
      });
      upsertProfile.run({
        project_id: profile.project_id,
        version: profile.version,
        source_yaml: raw,
        source_sha256: sha256(raw),
        loaded_at: mtime,
      });
      deleteDomains.run(profile.project_id);
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
    });
    tx();
    recordProjectProfileRevision(db, {
      projectId: profile.project_id,
      bodyYaml: raw,
      parsed: profile,
      actor: "db-import",
      reason: "compatibility project profile import",
      now: new Date(statSync(path).mtimeMs),
      currentPointerMode,
    });
    clearImportError(db, path);
    counters.projects += 1;
  }
}
