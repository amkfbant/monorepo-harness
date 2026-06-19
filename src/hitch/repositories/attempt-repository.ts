import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DbError } from "../../db/connection.js";
import type {
  HitchAttempt,
  HitchAttemptStatus,
  HitchAttemptType,
} from "../types.js";
import { json, parseRecord, touchHitchSession } from "./shared.js";

/**
 * #125 Track C (C3) — the attempt concern extracted from the frozen
 * `HitchRepository` by composition delegation. Owns the `hitch_attempts`
 * lifecycle (create / complete / discard / read) and the per-hitch iteration
 * counter (`nextIteration`, moved with its sole caller `createAttempt`).
 *
 * Holds the FACADE's `db` handle. `createAttempt` / `completeAttempt` perform
 * single writes (no transaction); `discardAttempt` opens its OWN transaction on
 * the shared handle — exactly as the pre-extraction facade did. It is never
 * called inside the atomic review-import `runAtomically` closure (which only
 * composes finding / close-check / review-cycle writes), so this self-contained
 * transaction does not nest under the single-BEGIN primitive. Behaviour-identical
 * to the former `HitchRepository` attempt methods.
 */
export interface CreateHitchAttemptInput {
  attemptId?: string;
  hitchId: string;
  iteration?: number;
  attemptType: HitchAttemptType;
  status?: HitchAttemptStatus;
  operationId?: string;
  runId?: string;
  parentAttemptId?: string;
  input?: Record<string, unknown>;
  startedAt?: string;
  createdAt?: string;
}

export interface CompleteHitchAttemptInput {
  attemptId: string;
  status: Exclude<HitchAttemptStatus, "pending" | "running">;
  operationId?: string;
  runId?: string;
  result?: Record<string, unknown>;
  errorMessage?: string;
  completedAt?: string;
}

interface HitchAttemptRow {
  attempt_id: string;
  hitch_id: string;
  iteration: number;
  attempt_type: HitchAttemptType;
  status: HitchAttemptStatus;
  operation_id: string | null;
  run_id: string | null;
  parent_attempt_id: string | null;
  input_json: string;
  result_json: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export class AttemptRepository {
  constructor(private readonly db: Database.Database) {}

  createAttempt(input: CreateHitchAttemptInput): HitchAttempt {
    const now = input.createdAt ?? new Date().toISOString();
    const attemptId = input.attemptId ?? `attempt-${randomUUID()}`;
    const iteration = input.iteration ?? this.nextIteration(input.hitchId);
    this.db
      .prepare(
        `INSERT INTO hitch_attempts (
           attempt_id, hitch_id, iteration, attempt_type, status,
           operation_id, run_id, parent_attempt_id, input_json,
           result_json, started_at, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        attemptId,
        input.hitchId,
        iteration,
        input.attemptType,
        input.status ?? "running",
        input.operationId ?? null,
        input.runId ?? null,
        input.parentAttemptId ?? null,
        json(input.input ?? {}),
        input.startedAt ?? now,
        now,
      );
    touchHitchSession(this.db, input.hitchId, now);
    return this.requireAttempt(attemptId);
  }

  completeAttempt(input: CompleteHitchAttemptInput): HitchAttempt {
    const now = input.completedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE hitch_attempts
            SET status = ?, operation_id = COALESCE(?, operation_id),
                run_id = COALESCE(?, run_id), result_json = ?,
                error_message = ?, completed_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        input.status,
        input.operationId ?? null,
        input.runId ?? null,
        json(input.result ?? {}),
        input.errorMessage ?? null,
        now,
        input.attemptId,
      );
    const attempt = this.requireAttempt(input.attemptId);
    touchHitchSession(this.db, attempt.hitchId, now);
    return attempt;
  }

  discardAttempt(attemptId: string, now = new Date().toISOString()): void {
    const tx = this.db.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (attempt === null) return;
      this.db
        .prepare("DELETE FROM hitch_attempts WHERE attempt_id = ?")
        .run(attemptId);
      this.db
        .prepare(
          `UPDATE hitch_sessions
              SET current_iteration = (
                    SELECT COALESCE(MAX(iteration), 0)
                      FROM hitch_attempts
                     WHERE hitch_id = ?
                  ),
                  updated_at = ?
            WHERE hitch_id = ?`,
        )
        .run(attempt.hitchId, now, attempt.hitchId);
    });
    tx.immediate();
  }

  getAttempt(attemptId: string): HitchAttempt | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_attempts WHERE attempt_id = ?")
      .get(attemptId) as HitchAttemptRow | undefined;
    return row === undefined ? null : rowToAttempt(row);
  }

  requireAttempt(attemptId: string): HitchAttempt {
    const attempt = this.getAttempt(attemptId);
    if (attempt === null) throw new DbError(`hitch attempt not found: ${attemptId}`);
    return attempt;
  }

  listAttempts(hitchId: string): HitchAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_attempts
          WHERE hitch_id = ?
          ORDER BY iteration ASC, created_at ASC`,
      )
      .all(hitchId) as HitchAttemptRow[];
    return rows.map(rowToAttempt);
  }

  private nextIteration(hitchId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(iteration), 0) + 1 AS n FROM hitch_attempts WHERE hitch_id = ?",
      )
      .get(hitchId) as { n: number };
    this.db
      .prepare(
        `UPDATE hitch_sessions
            SET current_iteration = MAX(current_iteration, ?),
                updated_at = ?
          WHERE hitch_id = ?`,
      )
      .run(row.n, new Date().toISOString(), hitchId);
    return row.n;
  }
}

function rowToAttempt(row: HitchAttemptRow): HitchAttempt {
  return {
    attemptId: row.attempt_id,
    hitchId: row.hitch_id,
    iteration: row.iteration,
    attemptType: row.attempt_type,
    status: row.status,
    operationId: row.operation_id,
    runId: row.run_id,
    parentAttemptId: row.parent_attempt_id,
    input: parseRecord(row.input_json),
    result: parseRecord(row.result_json),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}
