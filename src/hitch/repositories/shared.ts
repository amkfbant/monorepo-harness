import type Database from "better-sqlite3";
import { DbError } from "../../db/connection.js";
import {
  parseHitchCloseConditions,
  parseHitchPolicy,
  parseHitchScope,
} from "../schemas.js";
import type {
  HitchAttemptType,
  HitchCreatedSource,
  HitchSession,
  HitchStatus,
} from "../types.js";

/**
 * Cross-concern helpers shared by the {@link HitchRepository} facade and its
 * per-concern sub-repositories (#125 Track C). Every sub-repo is constructed
 * with the FACADE's `db` handle and holds NO transaction of its own, so these
 * helpers operate directly on that shared handle and compose inside whatever
 * transaction the caller already opened.
 */

/** Implement/rerun attempt types whose `run_id` is a "coding run" — the review
 * target lineage that {@link latestCodingRunId} resolves. Mirrors the former
 * module-private `CODING_RUN_ATTEMPT_TYPES` in `repository.ts`. */
const CODING_RUN_ATTEMPT_TYPES: ReadonlySet<HitchAttemptType> =
  new Set<HitchAttemptType>(["implement", "rerun"]);

interface CodingAttemptRunRow {
  run_id: string | null;
  attempt_type: HitchAttemptType;
}

/**
 * Run-lineage helper shared by the session concern (`adoptPr`, C5) and the
 * finding concern (`resolveSupersededReviewFindings`, C6): the run_id of the
 * hitch's CURRENT review target — the newest implement/rerun attempt that has a
 * run_id, ranked deterministically by attempt iteration then created_at (NOT
 * nullable `runs.started_at`). Intentionally LENIENT: it skips a newer run-less
 * coding attempt and falls back to an older one (the #278 auto-resolve guard
 * relies on this). Mirrors the former `HitchRepository.latestCodingRunId`; lives
 * here against the shared `db` handle so both consumers share ONE implementation
 * without depending on each other's sub-repo.
 */
export function latestCodingRunId(
  db: Database.Database,
  hitchId: string,
): string | null {
  const rows = db
    .prepare(
      `SELECT run_id, attempt_type FROM hitch_attempts
        WHERE hitch_id = ?
        ORDER BY iteration ASC, created_at ASC`,
    )
    .all(hitchId) as CodingAttemptRunRow[];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row === undefined) continue;
    if (!CODING_RUN_ATTEMPT_TYPES.has(row.attempt_type)) continue;
    if (row.run_id !== null && row.run_id !== "") return row.run_id;
  }
  return null;
}

/** The adopt-pr superseded-PR read: the (pr_url, pr_number) recorded against a
 * run, or null when neither is set. Mirrors the former private
 * `HitchRepository.runPr`; shared because `adoptPr` (C5) is the sole caller but
 * it composes the run-lineage read above. */
export function runPr(
  db: Database.Database,
  runId: string,
): { url: string | null; number: number | null } | null {
  const row = db
    .prepare("SELECT pr_url, pr_number FROM runs WHERE run_id = ?")
    .get(runId) as { pr_url: string | null; pr_number: number | null } | undefined;
  if (row === undefined) return null;
  if (row.pr_url === null && row.pr_number === null) return null;
  return { url: row.pr_url, number: row.pr_number };
}

/** Bump a hitch session's `updated_at`. Shared because nearly every mutating
 * path (attempt / review-cycle / finding / close-check / decision writes) must
 * mark the session touched. Pre-extraction this was the private
 * `HitchRepository.touchSession`; lifting it here lets the sub-repos and the
 * facade share ONE implementation against the single shared db handle. */
export function touchHitchSession(
  db: Database.Database,
  hitchId: string,
  updatedAt: string,
): void {
  db.prepare(
    "UPDATE hitch_sessions SET updated_at = ? WHERE hitch_id = ?",
  ).run(updatedAt, hitchId);
}

/** Stable JSON encoder used by every repository write that stores a JSON column
 * (`metrics_json`, `evidence_json`, `input_json`, …). Mirrors the former
 * module-private `json` helper. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Parse a stored JSON object column back into a record, returning `{}` for a
 * non-object payload (null / array / scalar). Mirrors the former module-private
 * `parseRecord` helper shared by the `rowTo*` converters. */
export function parseRecord(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

/** Render `count` comma-separated SQL placeholders (`?, ?, …`). Mirrors the
 * former module-private `placeholders` helper. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Append `column = ?` (and bind `value`) when `value` is defined. Mirrors the
 * former module-private `addWhere` helper; shared by the session (`listSessions`)
 * and finding (`listFindings` / `countFindings`) list builders. */
export function addWhere(
  clauses: string[],
  args: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  clauses.push(`${column} = ?`);
  args.push(value);
}

/** Append `column IN (…)` (and bind each value) when `values` is defined. An
 * empty array becomes the always-false `0 = 1` so an explicit empty filter
 * matches nothing. Mirrors the former module-private `addWhereIn` helper. */
export function addWhereIn(
  clauses: string[],
  args: unknown[],
  column: string,
  values: readonly string[] | undefined,
): void {
  if (values === undefined) return;
  if (values.length === 0) {
    clauses.push("0 = 1");
    return;
  }
  clauses.push(`${column} IN (${placeholders(values.length)})`);
  args.push(...values);
}

/** Join WHERE clauses into a ` WHERE a AND b …` suffix, or `""` when empty.
 * Mirrors the former module-private `whereSql` helper. */
export function whereSql(clauses: string[]): string {
  return clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
}

export interface HitchSessionRow {
  hitch_id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  repo_id: string | null;
  domain: string | null;
  backlog_item_id: string | null;
  status: HitchStatus;
  scope_json: string;
  close_conditions_json: string;
  policy_json: string;
  max_iterations: number;
  max_review_cycles: number;
  max_reruns: number;
  max_total_new_findings: number;
  current_iteration: number;
  current_review_cycle: number;
  created_by: string;
  created_source: HitchCreatedSource;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_summary: string | null;
  escalation_reason: string | null;
}

/** Hydrate a `hitch_sessions` row into a {@link HitchSession}. Mirrors the
 * former module-private `rowToSession`; shared so the session concern (which
 * owns the lifecycle) and the finding concern (which reads
 * `session.policy.divergence.nearDuplicateDedup` for near-dup gating) decode
 * sessions identically. */
export function rowToSession(row: HitchSessionRow): HitchSession {
  return {
    hitchId: row.hitch_id,
    title: row.title,
    description: row.description,
    projectId: row.project_id,
    repoId: row.repo_id,
    domain: row.domain,
    backlogItemId: row.backlog_item_id,
    status: row.status,
    scope: parseHitchScope(JSON.parse(row.scope_json) as unknown),
    closeConditions: parseHitchCloseConditions(
      JSON.parse(row.close_conditions_json) as unknown,
    ),
    policy: parseHitchPolicy(JSON.parse(row.policy_json) as unknown),
    maxIterations: row.max_iterations,
    maxReviewCycles: row.max_review_cycles,
    maxReruns: row.max_reruns,
    maxTotalNewFindings: row.max_total_new_findings,
    currentIteration: row.current_iteration,
    currentReviewCycle: row.current_review_cycle,
    createdBy: row.created_by,
    createdSource: row.created_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closeSummary: row.close_summary,
    escalationReason: row.escalation_reason,
  };
}

/** Read a hitch session by id, or null. Mirrors the former
 * `HitchRepository.getSession`; shared because the finding concern also needs a
 * session read for near-dup policy gating. */
export function getHitchSession(
  db: Database.Database,
  hitchId: string,
): HitchSession | null {
  const row = db
    .prepare("SELECT * FROM hitch_sessions WHERE hitch_id = ?")
    .get(hitchId) as HitchSessionRow | undefined;
  return row === undefined ? null : rowToSession(row);
}

/** Read a hitch session by id or throw {@link DbError}. Mirrors the former
 * `HitchRepository.requireSession`. */
export function requireHitchSession(
  db: Database.Database,
  hitchId: string,
): HitchSession {
  const session = getHitchSession(db, hitchId);
  if (session === null) throw new DbError(`hitch not found: ${hitchId}`);
  return session;
}
