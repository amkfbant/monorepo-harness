import type Database from "better-sqlite3";
import { DbError } from "../connection.js";
import { StateConflictError } from "../errors.js";

/**
 * Knowledge write repository (Phase 7-9).
 *
 * A knowledge candidate's *content* (kind / title / body / domain) is
 * file-derived — it mirrors the immutable per-run `knowledge-candidates.
 * yaml` observation log. Its *decision state* (status / decided_at /
 * reviewer / reason) is DB-canonical: `setCandidateDecision` is the
 * guarded promote / reject transition. A promoted candidate also gets a
 * `knowledge_entries` manifest row; the markdown body stays file-backed.
 */

export interface CandidateRecord {
  candidateId: string;
  runId: string;
  kind: string;
  title: string | null;
  body: string | null;
  domain: string | null;
  status: string;
  decidedAt: string | null;
  reviewer: string | null;
  reason: string | null;
  sourceMode: string;
}

/** Content fields synced from `knowledge-candidates.yaml` (no decision). */
export interface SyncCandidateInput {
  candidateId: string;
  runId: string;
  projectId: string | null;
  repoId: string | null;
  domain: string | null;
  kind: string;
  title: string | null;
  body: string | null;
  createdAt: string;
}

/** Manifest fields for a promoted `knowledge_entries` row. */
export interface UpsertEntryInput {
  entryId: string;
  projectId: string | null;
  repoId: string | null;
  domain: string | null;
  kind: string;
  path: string;
  title: string | null;
  body: string;
  frontmatterJson: string;
  createdAt: string | null;
  sourceCandidateId: string | null;
}

export class KnowledgeRepository {
  constructor(private readonly db: Database.Database) {}

  /** A candidate row with its decision state, or null. */
  getCandidate(candidateId: string): CandidateRecord | null {
    const r = this.db
      .prepare(
        `SELECT candidate_id, run_id, kind, title, body, domain, status,
                decided_at, reviewer, reason, source_mode
         FROM knowledge_candidates WHERE candidate_id = ?`,
      )
      .get(candidateId) as Record<string, unknown> | undefined;
    if (r === undefined) return null;
    return {
      candidateId: r.candidate_id as string,
      runId: r.run_id as string,
      kind: (r.kind as string | null) ?? "unknown",
      title: (r.title as string | null) ?? null,
      body: (r.body as string | null) ?? null,
      domain: (r.domain as string | null) ?? null,
      status: (r.status as string | null) ?? "candidate",
      decidedAt: (r.decided_at as string | null) ?? null,
      reviewer: (r.reviewer as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      sourceMode: (r.source_mode as string | null) ?? "legacy-file",
    };
  }

  /**
   * Upsert a candidate's content from the observation log. The decision
   * columns (`status` / `decided_at` / `reviewer` / `reason`) and the
   * migration metadata (`source_mode` / `db_revision`) are NOT touched —
   * a re-sync of an already-decided candidate keeps its decision.
   */
  syncCandidate(input: SyncCandidateInput): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_candidates (candidate_id, run_id, project_id,
           repo_id, domain, kind, title, body, status, created_at)
         VALUES (@candidate_id, @run_id, @project_id, @repo_id, @domain, @kind,
           @title, @body, 'candidate', @created_at)
         ON CONFLICT (candidate_id) DO UPDATE SET
           run_id = excluded.run_id, project_id = excluded.project_id,
           repo_id = excluded.repo_id, domain = excluded.domain,
           kind = excluded.kind, title = excluded.title, body = excluded.body`,
      )
      .run({
        candidate_id: input.candidateId,
        run_id: input.runId,
        project_id: input.projectId,
        repo_id: input.repoId,
        domain: input.domain,
        kind: input.kind,
        title: input.title,
        body: input.body,
        created_at: input.createdAt,
      });
  }

  /**
   * Guarded promote / reject of a candidate.
   *
   * Re-applying the decision the candidate already holds is an idempotent
   * no-op. A candidate already carrying the *other* decision is a
   * `StateConflictError` — a promoted candidate cannot be rejected (or
   * vice versa) without an explicit reopen. On success the decision
   * columns are written, `source_mode` flips to `db-first`, `db_revision`
   * is bumped and the row is marked `export_status = 'dirty'`.
   */
  setCandidateDecision(input: {
    candidateId: string;
    decision: "promoted" | "rejected";
    reviewer: string;
    reason: string | null;
    decidedAt: string;
  }): { changed: boolean } {
    const txn = this.db.transaction((): { changed: boolean } => {
      const current = this.requireStatus(input.candidateId);
      if (current === input.decision) return { changed: false };
      if (current !== "candidate") {
        throw new StateConflictError(
          input.candidateId,
          ["candidate"],
          current,
        );
      }
      const info = this.db
        .prepare(
          `UPDATE knowledge_candidates
             SET status = ?, decided_at = ?, reviewer = ?, reason = ?,
                 source_mode = 'db-first', db_revision = db_revision + 1,
                 export_status = 'dirty', last_export_error = NULL
           WHERE candidate_id = ? AND status = 'candidate'`,
        )
        .run(
          input.decision,
          input.decidedAt,
          input.reviewer,
          input.reason,
          input.candidateId,
        );
      if (info.changes === 0) {
        throw new StateConflictError(
          input.candidateId,
          ["candidate"],
          current,
        );
      }
      return { changed: true };
    });
    return txn.immediate();
  }

  /** Mark a candidate's decision export as `synced` at its current revision. */
  markCandidateExported(candidateId: string): void {
    this.db
      .prepare(
        `UPDATE knowledge_candidates
           SET export_status = 'synced', last_export_revision = db_revision,
               last_exported_at = ?, last_export_error = NULL
         WHERE candidate_id = ?`,
      )
      .run(new Date().toISOString(), candidateId);
  }

  /**
   * Mark a candidate's decision export as `failed`. The DB decision is
   * canonical and stays committed; the failure is recorded so
   * check-consistency / a re-export reconciles the stale file.
   */
  markCandidateExportFailed(candidateId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE knowledge_candidates
           SET export_status = 'failed', last_exported_at = ?,
               last_export_error = ?
         WHERE candidate_id = ?`,
      )
      .run(new Date().toISOString(), error, candidateId);
  }

  /**
   * Upsert a promoted entry's `knowledge_entries` manifest row and return
   * its new `db_revision`. The row is `db-first` and left `export_status =
   * 'dirty'` until the caller exports the md file and records the export.
   */
  upsertEntry(input: UpsertEntryInput): { dbRevision: number } {
    this.db
      .prepare(
        `INSERT INTO knowledge_entries (entry_id, project_id, repo_id, domain,
           kind, path, title, body, frontmatter_json, created_at,
           source_candidate_id, source_mode, db_revision, export_status,
           last_export_error)
         VALUES (@entry_id, @project_id, @repo_id, @domain, @kind, @path,
           @title, @body, @frontmatter_json, @created_at, @source_candidate_id,
           'db-first', 1, 'dirty', NULL)
         ON CONFLICT (entry_id) DO UPDATE SET
           project_id = excluded.project_id, repo_id = excluded.repo_id,
           domain = excluded.domain, kind = excluded.kind,
           title = excluded.title, body = excluded.body,
           frontmatter_json = excluded.frontmatter_json,
           source_candidate_id = excluded.source_candidate_id,
           source_mode = 'db-first',
           db_revision = knowledge_entries.db_revision + 1,
           export_status = 'dirty', last_export_error = NULL`,
      )
      .run({
        entry_id: input.entryId,
        project_id: input.projectId,
        repo_id: input.repoId,
        domain: input.domain,
        kind: input.kind,
        path: input.path,
        title: input.title,
        body: input.body,
        frontmatter_json: input.frontmatterJson,
        created_at: input.createdAt,
        source_candidate_id: input.sourceCandidateId,
      });
    const row = this.db
      .prepare("SELECT db_revision AS r FROM knowledge_entries WHERE entry_id = ?")
      .get(input.entryId) as { r: number };
    return { dbRevision: row.r };
  }

  /** Current status of a candidate, or a `DbError` when it does not exist. */
  private requireStatus(candidateId: string): string {
    const r = this.db
      .prepare("SELECT status FROM knowledge_candidates WHERE candidate_id = ?")
      .get(candidateId) as { status: string } | undefined;
    if (r === undefined) {
      throw new DbError(`knowledge candidate '${candidateId}' not found`);
    }
    return r.status;
  }
}
