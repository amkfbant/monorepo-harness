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
import type { GoalSession } from "./types.js";

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
}

export function evaluateConsensusStallForGoal(input: {
  repository: GoalRepository;
  goalId: string;
  provider: ConsensusSnapshotProvider;
  config?: ConsensusStallConfig;
  createdBy: string;
  now?: string;
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
  const snapshots = input.provider(runIds);
  const result = detectConsensusStall(snapshots, config);
  if (!result.stalled) {
    return { ...result, goalStatus: null };
  }
  // Stall detected → escalate. The metrics come from the deterministic
  // convergence evaluation; only the decision/reason reflect the stall.
  const metrics = new ConvergenceService(input.repository).evaluate(
    input.goalId,
  ).metrics;
  const recorded = recordConvergenceDecisionWithStatus({
    repository: input.repository,
    goalId: input.goalId,
    decision: "escalate",
    reason: `consensus stall: ${result.reason}`,
    metrics,
    recommendedNextAction: {
      kind: "ask_human",
      message: `Escalate: consensus is stuck (${result.reason}).`,
    },
    createdBy: input.createdBy,
    ...(input.now !== undefined ? { createdAt: input.now } : {}),
  });
  return { ...result, goalStatus: recorded.goalStatus };
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
    const snapshots: ConsensusProgressSnapshot[] = [];
    for (const runId of runIds) {
      for (const row of repo.listHistory(runId)) {
        const summary = JSON.parse(row.summaryJson) as ConsensusSummary;
        snapshots.push(
          snapshotFromConsensus({
            evaluatedAt: row.evaluatedAt,
            status: row.status,
            requirements: summary.requirements ?? [],
          }),
        );
      }
    }
    return snapshots.sort((a, b) =>
      a.evaluatedAt < b.evaluatedAt ? -1 : a.evaluatedAt > b.evaluatedAt ? 1 : 0,
    );
  };
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}
