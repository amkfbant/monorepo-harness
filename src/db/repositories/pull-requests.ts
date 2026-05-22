import type Database from "better-sqlite3";

/**
 * Pull-request write repository (Phase 7-10).
 *
 * `pr create` records the pull request it opens in `pull_requests` as the
 * canonical record. One row per run: a retried `pr create` updates the
 * row in place rather than inserting a duplicate, so a failed external
 * creation can be recovered without producing a second PR.
 */

export interface PullRequestRecord {
  runId: string;
  provider: string;
  repo: string | null;
  branch: string | null;
  baseBranch: string | null;
  title: string | null;
  url: string | null;
  externalPrId: string | null;
  /** `created` (external PR exists) or `failed` (external creation failed) */
  status: string;
  operationId: string | null;
}

export class PullRequestRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * The pull request recorded for a run, or null. `pr create` keeps one
   * row per run (serialised by the run's domain lock); the explicit
   * `ORDER BY id DESC` makes the read deterministic even if a row were
   * ever duplicated out-of-band.
   */
  findByRun(runId: string): PullRequestRecord | null {
    const r = this.db
      .prepare(
        `SELECT run_id, provider, repo, branch, base_branch, title, url,
                external_pr_id, status, operation_id
         FROM pull_requests WHERE run_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    if (r === undefined) return null;
    return {
      runId: r.run_id as string,
      provider: r.provider as string,
      repo: (r.repo as string | null) ?? null,
      branch: (r.branch as string | null) ?? null,
      baseBranch: (r.base_branch as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      externalPrId: (r.external_pr_id as string | null) ?? null,
      status: r.status as string,
      operationId: (r.operation_id as string | null) ?? null,
    };
  }

  /**
   * Insert or update the run's pull-request row. Keyed by `run_id` (one PR
   * per run), so a retry after a failed creation updates the same row
   * `failed` → `created` rather than leaving a duplicate.
   */
  upsertPullRequest(input: PullRequestRecord): void {
    const now = new Date().toISOString();
    // `run_id` is UNIQUE (schema v4) — an atomic `ON CONFLICT(run_id)`
    // upsert. `created_at` is preserved on update; only `updated_at` moves.
    this.db
      .prepare(
        `INSERT INTO pull_requests (run_id, provider, repo, branch,
           base_branch, title, url, external_pr_id, status, operation_id,
           created_at, updated_at)
         VALUES (@run_id, @provider, @repo, @branch, @base_branch, @title,
           @url, @external_pr_id, @status, @operation_id, @now, @now)
         ON CONFLICT (run_id) DO UPDATE SET
           provider = excluded.provider, repo = excluded.repo,
           branch = excluded.branch, base_branch = excluded.base_branch,
           title = excluded.title, url = excluded.url,
           external_pr_id = excluded.external_pr_id, status = excluded.status,
           operation_id = excluded.operation_id,
           updated_at = excluded.updated_at`,
      )
      .run({
        run_id: input.runId,
        provider: input.provider,
        repo: input.repo,
        branch: input.branch,
        base_branch: input.baseBranch,
        title: input.title,
        url: input.url,
        external_pr_id: input.externalPrId,
        status: input.status,
        operation_id: input.operationId,
        now,
      });
  }
}
