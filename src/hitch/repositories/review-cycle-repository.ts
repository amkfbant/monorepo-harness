import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DbError } from "../../db/connection.js";
import type { HitchReviewCycle, HitchReviewMode } from "../types.js";
import { touchHitchSession } from "./shared.js";

/**
 * #125 Track C (C4) — the review-cycle concern extracted from the frozen
 * `HitchRepository` by composition delegation. Owns the `hitch_review_cycles`
 * lifecycle (start / complete / read) and the per-hitch cycle-number counter
 * (`nextReviewCycleNumber`, moved with its sole caller `startReviewCycle`).
 *
 * Holds the FACADE's `db` handle and opens NO transaction of its own:
 * `startReviewCycle` / `completeReviewCycle` are the "plain writers" the atomic
 * review-import (`HitchRepository.runAtomically`) calls DIRECTLY inside its
 * single BEGIN, so they must compose without an inner transaction boundary.
 * Behaviour-identical to the former `HitchRepository` review-cycle methods.
 */
export interface StartHitchReviewCycleInput {
  cycleId?: string;
  hitchId: string;
  cycleNumber?: number;
  reviewMode: HitchReviewMode;
  triggerAttemptId?: string;
  sourceReviewId?: string;
  sourceRunId?: string;
  createdAt?: string;
}

export interface CompleteHitchReviewCycleInput {
  cycleId: string;
  findingsSeen?: number;
  findingsNew?: number;
  findingsReopened?: number;
  findingsFixed?: number;
  findingsDeferred?: number;
  findingsInScopeOpen?: number;
  summary?: string;
  completedAt?: string;
}

interface HitchReviewCycleRow {
  cycle_id: string;
  hitch_id: string;
  cycle_number: number;
  review_mode: HitchReviewMode;
  trigger_attempt_id: string | null;
  source_review_id: string | null;
  source_run_id: string | null;
  findings_seen: number;
  findings_new: number;
  findings_reopened: number;
  findings_fixed: number;
  findings_deferred: number;
  findings_in_scope_open: number;
  created_at: string;
  completed_at: string | null;
  summary: string | null;
}

export class ReviewCycleRepository {
  constructor(private readonly db: Database.Database) {}

  startReviewCycle(input: StartHitchReviewCycleInput): HitchReviewCycle {
    const now = input.createdAt ?? new Date().toISOString();
    const cycleId = input.cycleId ?? `cycle-${randomUUID()}`;
    const cycleNumber =
      input.cycleNumber ?? this.nextReviewCycleNumber(input.hitchId);
    this.db
      .prepare(
        `INSERT INTO hitch_review_cycles (
           cycle_id, hitch_id, cycle_number, review_mode, trigger_attempt_id,
           source_review_id, source_run_id, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cycleId,
        input.hitchId,
        cycleNumber,
        input.reviewMode,
        input.triggerAttemptId ?? null,
        input.sourceReviewId ?? null,
        input.sourceRunId ?? null,
        now,
      );
    this.db
      .prepare(
        `UPDATE hitch_sessions
            SET current_review_cycle = MAX(current_review_cycle, ?),
                updated_at = ?
          WHERE hitch_id = ?`,
      )
      .run(cycleNumber, now, input.hitchId);
    return this.requireReviewCycle(cycleId);
  }

  completeReviewCycle(input: CompleteHitchReviewCycleInput): HitchReviewCycle {
    const now = input.completedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE hitch_review_cycles
            SET findings_seen = ?, findings_new = ?, findings_reopened = ?,
                findings_fixed = ?, findings_deferred = ?,
                findings_in_scope_open = ?, summary = ?, completed_at = ?
          WHERE cycle_id = ?`,
      )
      .run(
        input.findingsSeen ?? 0,
        input.findingsNew ?? 0,
        input.findingsReopened ?? 0,
        input.findingsFixed ?? 0,
        input.findingsDeferred ?? 0,
        input.findingsInScopeOpen ?? 0,
        input.summary ?? null,
        now,
        input.cycleId,
      );
    const cycle = this.requireReviewCycle(input.cycleId);
    touchHitchSession(this.db, cycle.hitchId, now);
    return cycle;
  }

  getReviewCycle(cycleId: string): HitchReviewCycle | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_review_cycles WHERE cycle_id = ?")
      .get(cycleId) as HitchReviewCycleRow | undefined;
    return row === undefined ? null : rowToReviewCycle(row);
  }

  requireReviewCycle(cycleId: string): HitchReviewCycle {
    const cycle = this.getReviewCycle(cycleId);
    if (cycle === null) throw new DbError(`hitch review cycle not found: ${cycleId}`);
    return cycle;
  }

  listReviewCycles(hitchId: string): HitchReviewCycle[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_review_cycles
          WHERE hitch_id = ?
          ORDER BY cycle_number ASC`,
      )
      .all(hitchId) as HitchReviewCycleRow[];
    return rows.map(rowToReviewCycle);
  }

  private nextReviewCycleNumber(hitchId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(cycle_number), 0) + 1 AS n FROM hitch_review_cycles WHERE hitch_id = ?",
      )
      .get(hitchId) as { n: number };
    return row.n;
  }
}

function rowToReviewCycle(row: HitchReviewCycleRow): HitchReviewCycle {
  return {
    cycleId: row.cycle_id,
    hitchId: row.hitch_id,
    cycleNumber: row.cycle_number,
    reviewMode: row.review_mode,
    triggerAttemptId: row.trigger_attempt_id,
    sourceReviewId: row.source_review_id,
    sourceRunId: row.source_run_id,
    findingsSeen: row.findings_seen,
    findingsNew: row.findings_new,
    findingsReopened: row.findings_reopened,
    findingsFixed: row.findings_fixed,
    findingsDeferred: row.findings_deferred,
    findingsInScopeOpen: row.findings_in_scope_open,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    summary: row.summary,
  };
}
