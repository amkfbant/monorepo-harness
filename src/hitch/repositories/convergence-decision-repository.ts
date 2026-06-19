import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DbError } from "../../db/connection.js";
import type {
  HitchConvergenceDecision,
  HitchConvergenceDecisionRecord,
  HitchNextAction,
} from "../types.js";
import { json, parseRecord, touchHitchSession } from "./shared.js";

/**
 * #125 Track C (C1) — the convergence-decision concern extracted from the frozen
 * `HitchRepository` by composition delegation. Records the immutable
 * `hitch_convergence_decisions` audit rows the convergence controller emits.
 *
 * Holds the FACADE's `db` handle and NO transaction of its own, so its writes
 * compose inside the caller's transaction when one is open. Behaviour-identical
 * to the former `HitchRepository.recordConvergenceDecision` / `getDecision` /
 * `requireDecision` / `listDecisions`.
 */
export interface RecordHitchConvergenceDecisionInput {
  decisionId?: string;
  hitchId: string;
  cycleId?: string;
  attemptId?: string;
  decision: HitchConvergenceDecision;
  reason: string;
  metrics?: Record<string, unknown>;
  recommendedNextAction?: HitchNextAction;
  createdAt?: string;
  createdBy: string;
}

interface HitchDecisionRow {
  decision_id: string;
  hitch_id: string;
  cycle_id: string | null;
  attempt_id: string | null;
  decision: HitchConvergenceDecision;
  reason: string;
  metrics_json: string;
  recommended_next_action: string | null;
  created_at: string;
  created_by: string;
}

export class ConvergenceDecisionRepository {
  constructor(private readonly db: Database.Database) {}

  recordConvergenceDecision(
    input: RecordHitchConvergenceDecisionInput,
  ): HitchConvergenceDecisionRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const decisionId = input.decisionId ?? `decision-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO hitch_convergence_decisions (
           decision_id, hitch_id, cycle_id, attempt_id, decision, reason,
           metrics_json, recommended_next_action, created_at, created_by
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decisionId,
        input.hitchId,
        input.cycleId ?? null,
        input.attemptId ?? null,
        input.decision,
        input.reason,
        json(input.metrics ?? {}),
        input.recommendedNextAction === undefined
          ? null
          : json(input.recommendedNextAction),
        createdAt,
        input.createdBy,
      );
    touchHitchSession(this.db, input.hitchId, createdAt);
    return this.requireDecision(decisionId);
  }

  getDecision(decisionId: string): HitchConvergenceDecisionRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM hitch_convergence_decisions WHERE decision_id = ?",
      )
      .get(decisionId) as HitchDecisionRow | undefined;
    return row === undefined ? null : rowToDecision(row);
  }

  requireDecision(decisionId: string): HitchConvergenceDecisionRecord {
    const decision = this.getDecision(decisionId);
    if (decision === null) {
      throw new DbError(`hitch convergence decision not found: ${decisionId}`);
    }
    return decision;
  }

  listDecisions(hitchId: string): HitchConvergenceDecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hitch_convergence_decisions
          WHERE hitch_id = ?
          ORDER BY created_at ASC, decision_id ASC`,
      )
      .all(hitchId) as HitchDecisionRow[];
    return rows.map(rowToDecision);
  }
}

function rowToDecision(row: HitchDecisionRow): HitchConvergenceDecisionRecord {
  return {
    decisionId: row.decision_id,
    hitchId: row.hitch_id,
    cycleId: row.cycle_id,
    attemptId: row.attempt_id,
    decision: row.decision,
    reason: row.reason,
    metrics: parseRecord(row.metrics_json),
    recommendedNextAction:
      row.recommended_next_action === null
        ? null
        : (JSON.parse(row.recommended_next_action) as HitchNextAction),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
