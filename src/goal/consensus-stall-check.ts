import type Database from "better-sqlite3";
import {
  detectConsensusStall,
  snapshotFromConsensus,
  type ConsensusProgressSnapshot,
  type ConsensusStallConfig,
  type ConsensusStallResult,
} from "../core/consensus-stall.js";
import type { ConsensusSummary } from "../core/review-consensus.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import { ConvergenceService } from "./convergence.js";
import { recordConvergenceDecisionWithStatus } from "./convergence-status.js";
import type { GoalRepository } from "./repository.js";
import type { GoalConvergenceDecisionRecord, GoalSession } from "./types.js";

/**
 * Phase 2-3: consensus stall → goal escalation.
 *
 * After a review cycle, build the consensus timeline for the goal's review
 * runs and, if the deterministic detector flags a stall, escalate the goal
 * (a harness-only state transition, fail-closed). LLM output is never an
 * input — only persisted `review_consensus` rows.
 */

export type ConsensusSnapshotProvider = (
  runIds: string[],
) => ConsensusProgressSnapshot[];

export const DEFAULT_CONSENSUS_STALL_CONFIG: ConsensusStallConfig = {
  stallAfterSnapshots: 3,
};

export interface GoalConsensusStallResult extends ConsensusStallResult {
  /** Non-null when the stall caused an escalate transition. */
  goalStatus: GoalSession | null;
  /** The escalate convergence record, when a stall transition was made. */
  decisionRecord?: GoalConvergenceDecisionRecord;
}

export function evaluateConsensusStallForGoal(input: {
  repository: GoalRepository;
  goalId: string;
  provider: ConsensusSnapshotProvider;
  config?: ConsensusStallConfig;
  createdBy: string;
  now?: string;
  cycleId?: string;
}): GoalConsensusStallResult {
  const config = input.config ?? DEFAULT_CONSENSUS_STALL_CONFIG;
  const cycles = input.repository.listReviewCycles(input.goalId);
  const runIds = distinct(
    cycles
      .map((c) => c.sourceRunId)
      .filter((id): id is string => id !== null),
  );
  if (runIds.length === 0) {
    return { stalled: false, reason: null, goalStatus: null };
  }
  let result: ConsensusStallResult;
  try {
    const snapshots = input.provider(runIds);
    result = detectConsensusStall(snapshots, config);
  } catch (e) {
    // fail-closed: the consensus timeline could not be reconstructed or
    // evaluated (corrupted summary_json / unparseable evaluated_at /
    // misconfigured window). Escalate rather than silently proceeding.
    return escalate(input, `consensus data unreadable: ${(e as Error).message}`);
  }
  if (!result.stalled) {
    return { stalled: false, reason: result.reason, goalStatus: null };
  }
  return escalate(input, `consensus stall: ${result.reason}`, result.reason);
}

function escalate(
  input: {
    repository: GoalRepository;
    goalId: string;
    createdBy: string;
    now?: string;
    cycleId?: string;
  },
  reason: string,
  stallReason?: string | null,
): GoalConsensusStallResult {
  // The metrics come from the deterministic convergence evaluation; only the
  // decision/reason reflect the stall. State transition is harness-only.
  const metrics = new ConvergenceService(input.repository).evaluate(
    input.goalId,
  ).metrics;
  const recorded = recordConvergenceDecisionWithStatus({
    repository: input.repository,
    goalId: input.goalId,
    ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
    decision: "escalate",
    reason,
    metrics,
    recommendedNextAction: {
      kind: "ask_human",
      message: `Escalate: ${reason}.`,
    },
    createdBy: input.createdBy,
    ...(input.now !== undefined ? { createdAt: input.now } : {}),
  });
  return {
    stalled: true,
    reason: stallReason ?? reason,
    goalStatus: recorded.goalStatus,
    decisionRecord: recorded.decisionRecord,
  };
}

/**
 * Production provider: rebuild the consensus timeline from `review_consensus`
 * (active + superseded history) for the given runs, ordered by evaluation
 * time. No new schema — the persisted consensus rows are the source.
 */
export function dbConsensusSnapshotProvider(
  db: Database.Database,
): ConsensusSnapshotProvider {
  const repo = new ReviewConsensusRepository(db);
  return (runIds) => {
    const rows: Array<{
      snapshot: ConsensusProgressSnapshot;
      sortMs: number;
      consensusId: number;
    }> = [];
    for (const runId of runIds) {
      for (const row of repo.listHistory(runId)) {
        // JSON.parse throws on a corrupted summary → propagates to the
        // caller, which escalates (fail-closed).
        const summary = JSON.parse(row.summaryJson) as ConsensusSummary;
        // A malformed summary (requirements is not an array) is corruption →
        // fail-closed (throw → escalate), NOT silently skipped.
        if (!Array.isArray(summary.requirements)) {
          throw new Error(
            `malformed review_consensus.summary (requirements not an array) for ${row.runId}#${row.consensusId}`,
          );
        }
        // Stall detection applies only to consensus-mode evaluations. A
        // latest-proposal row (an empty requirements array) is a decisive
        // single-reviewer verdict handled by the normal convergence / rerun
        // loop — feeding it here would falsely stall on repeated
        // changes_requested verdicts.
        if (summary.requirements.length === 0) {
          continue;
        }
        const sortMs = Date.parse(row.evaluatedAt);
        if (Number.isNaN(sortMs)) {
          throw new Error(
            `unparseable review_consensus.evaluated_at for ${row.runId}#${row.consensusId}: ${row.evaluatedAt}`,
          );
        }
        rows.push({
          snapshot: snapshotFromConsensus({
            evaluatedAt: row.evaluatedAt,
            status: row.status,
            requirements: summary.requirements,
          }),
          sortMs,
          consensusId: row.consensusId,
        });
      }
    }
    // Deterministic order: by evaluation time, tie-broken by consensus_id.
    rows.sort((a, b) => a.sortMs - b.sortMs || a.consensusId - b.consensusId);
    return rows.map((r) => r.snapshot);
  };
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}
