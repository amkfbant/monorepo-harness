import type Database from "better-sqlite3";
import type {
  ConsensusStatus,
  ConsensusSummary,
} from "../../core/review-consensus.js";

/**
 * `review_consensus` repository (Phase 11-4).
 *
 * Stores consensus evaluation rows. One active row per run is enforced
 * by the partial unique index `review_consensus_active_idx WHERE
 * superseded_at IS NULL` (Phase 11-1).
 *
 * `insertActive` atomically supersedes any prior active row + inserts
 * the new one inside a single transaction.
 */

export interface ReviewConsensusRow {
  consensusId: number;
  runId: string;
  ruleSha256: string;
  status: ConsensusStatus;
  summaryJson: string;
  evaluatedAt: string;
  evaluatedBy: string;
  sourceProposalsJson: string;
  supersededAt: string | null;
}

export class ReviewConsensusRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new active consensus row, superseding any prior active row
   * for the same run within the same transaction.
   */
  insertActive(input: {
    runId: string;
    ruleSha256: string;
    status: ConsensusStatus;
    summary: ConsensusSummary;
    evaluatedAt: string;
    evaluatedBy: string;
    sourceProposalIds: number[];
  }): ReviewConsensusRow {
    const supersededAt = input.evaluatedAt;
    const txn = this.db.transaction((): ReviewConsensusRow => {
      this.db
        .prepare(
          `UPDATE review_consensus
              SET superseded_at = ?
            WHERE run_id = ? AND superseded_at IS NULL`,
        )
        .run(supersededAt, input.runId);
      const info = this.db
        .prepare(
          `INSERT INTO review_consensus
             (run_id, rule_sha256, status, summary_json, evaluated_at,
              evaluated_by, source_proposals_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.ruleSha256,
          input.status,
          JSON.stringify(input.summary),
          input.evaluatedAt,
          input.evaluatedBy,
          JSON.stringify(input.sourceProposalIds),
        );
      return {
        consensusId: Number(info.lastInsertRowid),
        runId: input.runId,
        ruleSha256: input.ruleSha256,
        status: input.status,
        summaryJson: JSON.stringify(input.summary),
        evaluatedAt: input.evaluatedAt,
        evaluatedBy: input.evaluatedBy,
        sourceProposalsJson: JSON.stringify(input.sourceProposalIds),
        supersededAt: null,
      };
    });
    return txn.immediate();
  }

  findActive(runId: string): ReviewConsensusRow | null {
    const row = this.db
      .prepare(
        `SELECT consensus_id, run_id, rule_sha256, status, summary_json,
                evaluated_at, evaluated_by, source_proposals_json,
                superseded_at
           FROM review_consensus
          WHERE run_id = ? AND superseded_at IS NULL`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toRow(row);
  }

  listHistory(runId: string): ReviewConsensusRow[] {
    const rows = this.db
      .prepare(
        `SELECT consensus_id, run_id, rule_sha256, status, summary_json,
                evaluated_at, evaluated_by, source_proposals_json,
                superseded_at
           FROM review_consensus
          WHERE run_id = ?
          ORDER BY evaluated_at ASC, consensus_id ASC`,
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map(toRow);
  }
}

function toRow(r: Record<string, unknown>): ReviewConsensusRow {
  return {
    consensusId: r.consensus_id as number,
    runId: r.run_id as string,
    ruleSha256: r.rule_sha256 as string,
    status: r.status as ConsensusStatus,
    summaryJson: r.summary_json as string,
    evaluatedAt: r.evaluated_at as string,
    evaluatedBy: r.evaluated_by as string,
    sourceProposalsJson: r.source_proposals_json as string,
    supersededAt: (r.superseded_at as string | null) ?? null,
  };
}
