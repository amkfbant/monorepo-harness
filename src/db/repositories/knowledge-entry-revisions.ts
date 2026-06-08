import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

/**
 * `knowledge_entry_revisions` + `knowledge_entries.current_revision_id`
 * repository (Phase 14-4).
 *
 * Mirrors the project_profile_revisions pattern: idempotent record
 * with body_sha reuse, version per entry_id, current pointer update
 * in one transaction.
 */

export interface KnowledgeEntryRevision {
  revisionId: number;
  entryId: string;
  version: number;
  bodyMarkdown: string;
  bodySha256: string;
  frontmatterJson: string;
  title: string | null;
  actor: string;
  reason: string | null;
  createdAt: string;
  supersedesRevisionId: number | null;
}

export interface RecordKnowledgeEntryRevisionInput {
  entryId: string;
  bodyMarkdown: string;
  frontmatter: Record<string, unknown>;
  title?: string;
  actor: string;
  reason?: string;
  now?: Date;
  currentPointerMode?: CurrentPointerMode;
}

export type CurrentPointerMode =
  | "set-current"
  | "if-missing"
  | "do-not-change";

export interface RecordKnowledgeRevisionResult {
  revision: KnowledgeEntryRevision;
  reusedExisting: boolean;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function recordKnowledgeEntryRevision(
  db: Database.Database,
  input: RecordKnowledgeEntryRevisionInput,
): RecordKnowledgeRevisionResult {
  const bodySha = sha(input.bodyMarkdown);
  const currentPointerMode = input.currentPointerMode ?? "set-current";
  const tx = db.transaction((): RecordKnowledgeRevisionResult => {
    // Ensure knowledge_entries row exists. Phase 6 schema requires
    // NOT NULL `kind` and `body`; for an asset-revision first import
    // we default `kind='imported'` and `body=''` (knowledge_entry_
    // revisions is the new canonical body source). Existing rows are
    // left untouched.
    const nowStr = (input.now ?? new Date()).toISOString();
    db.prepare(
      `INSERT INTO knowledge_entries (entry_id, kind, body, created_at)
       VALUES (?, 'imported', '', ?)
       ON CONFLICT(entry_id) DO NOTHING`,
    ).run(input.entryId, nowStr);
    const current = db
      .prepare(
        `SELECT current_revision_id
           FROM knowledge_entries
          WHERE entry_id = ?`,
      )
      .get(input.entryId) as
      | { current_revision_id: number | null }
      | undefined;
    const shouldSetCurrent =
      currentPointerMode === "set-current" ||
      (currentPointerMode === "if-missing" &&
        current?.current_revision_id == null);
    const latest = db
      .prepare(
        `SELECT * FROM knowledge_entry_revisions
          WHERE entry_id = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(input.entryId) as Record<string, unknown> | undefined;
    if (latest !== undefined && latest.body_sha256 === bodySha) {
      if (shouldSetCurrent) {
        db.prepare(
          `UPDATE knowledge_entries SET current_revision_id = ?
            WHERE entry_id = ?`,
        ).run(latest.revision_id, input.entryId);
      }
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
        `INSERT INTO knowledge_entry_revisions
           (entry_id, version, body_markdown, body_sha256,
            frontmatter_json, title, actor, reason, created_at,
            supersedes_revision_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.entryId,
        nextVersion,
        input.bodyMarkdown,
        bodySha,
        JSON.stringify(input.frontmatter),
        input.title ?? null,
        input.actor,
        input.reason ?? null,
        now,
        latest === undefined ? null : (latest.revision_id as number),
      );
    if (shouldSetCurrent) {
      db.prepare(
        `UPDATE knowledge_entries SET current_revision_id = ?
          WHERE entry_id = ?`,
      ).run(Number(info.lastInsertRowid), input.entryId);
    }
    return {
      revision: {
        revisionId: Number(info.lastInsertRowid),
        entryId: input.entryId,
        version: nextVersion,
        bodyMarkdown: input.bodyMarkdown,
        bodySha256: bodySha,
        frontmatterJson: JSON.stringify(input.frontmatter),
        title: input.title ?? null,
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

export function getCurrentKnowledgeRevision(
  db: Database.Database,
  entryId: string,
): KnowledgeEntryRevision | null {
  const row = db
    .prepare(
      `SELECT r.* FROM knowledge_entry_revisions r
        INNER JOIN knowledge_entries e ON e.current_revision_id = r.revision_id
        WHERE e.entry_id = ?`,
    )
    .get(entryId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toRevision(row);
}

export function listKnowledgeRevisions(
  db: Database.Database,
  entryId: string,
): KnowledgeEntryRevision[] {
  const rows = db
    .prepare(
      `SELECT * FROM knowledge_entry_revisions
        WHERE entry_id = ?
        ORDER BY version DESC`,
    )
    .all(entryId) as Record<string, unknown>[];
  return rows.map(toRevision);
}

export type KnowledgeCategory = "codebase" | "operational";

export interface CurrentKnowledgeRevision extends KnowledgeEntryRevision {
  projectId: string | null;
  repoId: string | null;
  domain: string | null;
  kind: string;
  path: string | null;
  category: KnowledgeCategory;
}

export interface ListCurrentKnowledgeFilter {
  projectId?: string;
  repoId?: string;
  domain?: string;
  /**
   * Which knowledge category to list. Defaults to `'codebase'` (fail-closed):
   * the coder-prompt context path and every legacy caller must never see
   * `operational` entries unless they opt in explicitly (issue #57 safety
   * boundary). There is intentionally no "all categories" option.
   */
  category?: KnowledgeCategory;
}

export function listCurrentKnowledgeRevisions(
  db: Database.Database,
  filter: ListCurrentKnowledgeFilter = {},
): CurrentKnowledgeRevision[] {
  const where = ["e.current_revision_id IS NOT NULL", "e.category = ?"];
  const params: unknown[] = [filter.category ?? "codebase"];
  if (filter.projectId !== undefined) {
    where.push("(e.project_id = ? OR e.project_id IS NULL)");
    params.push(filter.projectId);
  }
  if (filter.repoId !== undefined) {
    where.push("(e.repo_id = ? OR e.repo_id IS NULL)");
    params.push(filter.repoId);
  }
  if (filter.domain !== undefined) {
    where.push("e.domain = ?");
    params.push(filter.domain);
  }
  const rows = db
    .prepare(
      `SELECT r.*, e.project_id, e.repo_id, e.domain, e.kind, e.path, e.category
         FROM knowledge_entries e
         INNER JOIN knowledge_entry_revisions r
            ON e.current_revision_id = r.revision_id
        WHERE ${where.join(" AND ")}
        ORDER BY e.kind, e.path, e.entry_id`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...toRevision(r),
    projectId: (r.project_id as string | null) ?? null,
    repoId: (r.repo_id as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    kind: r.kind as string,
    path: (r.path as string | null) ?? null,
    category: (r.category as KnowledgeCategory | null) ?? "codebase",
  }));
}

function toRevision(r: Record<string, unknown>): KnowledgeEntryRevision {
  return {
    revisionId: r.revision_id as number,
    entryId: r.entry_id as string,
    version: r.version as number,
    bodyMarkdown: r.body_markdown as string,
    bodySha256: r.body_sha256 as string,
    frontmatterJson: r.frontmatter_json as string,
    title: (r.title as string | null) ?? null,
    actor: r.actor as string,
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as string,
    supersedesRevisionId:
      (r.supersedes_revision_id as number | null) ?? null,
  };
}
