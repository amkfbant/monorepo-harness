import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

/**
 * `project_profile_revisions` + `projects.current_profile_revision_id`
 * repository (Phase 14-2).
 *
 * 各 project profile YAML を revision として保存。`recordRevision`
 * は次 version を allocate + INSERT + current pointer update を 1
 * transaction で行う。同 body_sha256 を持つ最新 revision とは reuse
 * する (no-op insert) ことで edit fix-up の重複追加を防ぐ。
 */

export interface ProjectProfileRevision {
  revisionId: number;
  projectId: string;
  version: number;
  bodyYaml: string;
  bodySha256: string;
  parsedJson: string;
  actor: string;
  reason: string | null;
  createdAt: string;
  supersedesRevisionId: number | null;
}

export interface RecordProjectProfileRevisionInput {
  projectId: string;
  bodyYaml: string;
  parsed: unknown;
  actor: string;
  reason?: string;
  now?: Date;
}

export interface RecordResult {
  revision: ProjectProfileRevision;
  reusedExisting: boolean;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function recordProjectProfileRevision(
  db: Database.Database,
  input: RecordProjectProfileRevisionInput,
): RecordResult {
  const bodySha256 = sha256(input.bodyYaml);
  const tx = db.transaction((): RecordResult => {
    // Ensure projects row exists. The projects table has NOT NULL
    // repo_id (Phase 6); for an asset-only first import we default it
    // to the project_id (= synthetic placeholder). Phase 14-2 import
    // CLI rewrites it from the parsed profile.
    db.prepare(
      `INSERT INTO projects (project_id, repo_id) VALUES (?, ?)
       ON CONFLICT(project_id) DO NOTHING`,
    ).run(input.projectId, input.projectId);

    // Reuse if the latest revision for this project has the same sha.
    const latest = db
      .prepare(
        `SELECT revision_id, project_id, version, body_yaml, body_sha256,
                parsed_json, actor, reason, created_at, supersedes_revision_id
           FROM project_profile_revisions
          WHERE project_id = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(input.projectId) as Record<string, unknown> | undefined;
    if (latest !== undefined && latest.body_sha256 === bodySha256) {
      // Already current; just ensure pointer.
      db.prepare(
        `UPDATE projects SET current_profile_revision_id = ?
          WHERE project_id = ?`,
      ).run(latest.revision_id, input.projectId);
      return {
        revision: toRevision(latest),
        reusedExisting: true,
      };
    }

    const nextVersion =
      latest !== undefined ? (latest.version as number) + 1 : 1;
    const now = (input.now ?? new Date()).toISOString();
    const info = db
      .prepare(
        `INSERT INTO project_profile_revisions
           (project_id, version, body_yaml, body_sha256, parsed_json,
            actor, reason, created_at, supersedes_revision_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        nextVersion,
        input.bodyYaml,
        bodySha256,
        JSON.stringify(input.parsed),
        input.actor,
        input.reason ?? null,
        now,
        latest === undefined ? null : (latest.revision_id as number),
      );
    db.prepare(
      `UPDATE projects SET current_profile_revision_id = ?
        WHERE project_id = ?`,
    ).run(Number(info.lastInsertRowid), input.projectId);
    return {
      revision: {
        revisionId: Number(info.lastInsertRowid),
        projectId: input.projectId,
        version: nextVersion,
        bodyYaml: input.bodyYaml,
        bodySha256,
        parsedJson: JSON.stringify(input.parsed),
        actor: input.actor,
        reason: input.reason ?? null,
        createdAt: now,
        supersedesRevisionId:
          latest === undefined ? null : (latest.revision_id as number),
      },
      reusedExisting: false,
    };
  });
  return tx.immediate();
}

export function getCurrentProjectProfile(
  db: Database.Database,
  projectId: string,
): ProjectProfileRevision | null {
  const row = db
    .prepare(
      `SELECT r.* FROM project_profile_revisions r
        INNER JOIN projects p ON p.current_profile_revision_id = r.revision_id
        WHERE p.project_id = ?`,
    )
    .get(projectId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toRevision(row);
}

export function listProjectProfileRevisions(
  db: Database.Database,
  projectId: string,
): ProjectProfileRevision[] {
  const rows = db
    .prepare(
      `SELECT * FROM project_profile_revisions
        WHERE project_id = ?
        ORDER BY version DESC`,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(toRevision);
}

export function getProjectProfileRevision(
  db: Database.Database,
  projectId: string,
  version: number,
): ProjectProfileRevision | null {
  const row = db
    .prepare(
      `SELECT * FROM project_profile_revisions
        WHERE project_id = ? AND version = ?`,
    )
    .get(projectId, version) as Record<string, unknown> | undefined;
  return row === undefined ? null : toRevision(row);
}

function toRevision(r: Record<string, unknown>): ProjectProfileRevision {
  return {
    revisionId: r.revision_id as number,
    projectId: r.project_id as string,
    version: r.version as number,
    bodyYaml: r.body_yaml as string,
    bodySha256: r.body_sha256 as string,
    parsedJson: r.parsed_json as string,
    actor: r.actor as string,
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as string,
    supersedesRevisionId:
      (r.supersedes_revision_id as number | null) ?? null,
  };
}
