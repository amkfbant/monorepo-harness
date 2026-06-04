import type {
  ConsensusStatus,
  ConsensusRequirementCheck,
} from "./review-consensus.js";

/**
 * Consensus stall detector (Phase 2-3).
 *
 * Pure, deterministic: given a time-ordered history of consensus
 * evaluation snapshots, decide whether the consensus is "stuck" (long
 * pending / unresolved blocking / quorum not reached with no progress) so
 * the goal orchestrator can escalate (fail-closed). Inputs are derived only
 * from harness-side consensus evaluations — never from LLM output.
 */

export interface ConsensusProgressSnapshot {
  /** Evaluation time (ISO 8601). Snapshots are expected in ascending order. */
  evaluatedAt: string;
  status: ConsensusStatus;
  /** Sum of approvals across all requirement groups. */
  totalApprovals: number;
  /** Sum of distinct participants across all requirement groups. */
  totalParticipants: number;
  /** Whether any requirement group is currently blocked. */
  blocked: boolean;
}

export interface ConsensusStallConfig {
  /**
   * Stall when this many trailing snapshots show no progress. A window
   * smaller than this is treated as undecided (not stalled) unless a
   * time-based signal fires.
   */
  stallAfterSnapshots: number;
  /**
   * Optional absolute timeout: when the current unresolved streak has
   * spanned more than this many hours, treat it as stalled.
   */
  maxPendingHours?: number;
}

export interface ConsensusStallResult {
  stalled: boolean;
  reason: string | null;
}

const UNRESOLVED = new Set<ConsensusStatus>(["pending", "changes_requested"]);

export function detectConsensusStall(
  snapshots: ConsensusProgressSnapshot[],
  config: ConsensusStallConfig,
): ConsensusStallResult {
  // fail-closed on a misconfigured window: an invalid threshold cannot be
  // interpreted, so surface it rather than silently never-stalling.
  if (
    !Number.isInteger(config.stallAfterSnapshots) ||
    config.stallAfterSnapshots <= 0
  ) {
    throw new Error(
      `invalid stallAfterSnapshots: ${config.stallAfterSnapshots}`,
    );
  }
  if (
    config.maxPendingHours !== undefined &&
    (!Number.isFinite(config.maxPendingHours) || config.maxPendingHours < 0)
  ) {
    throw new Error(`invalid maxPendingHours: ${config.maxPendingHours}`);
  }
  if (snapshots.length === 0) return notStalled();
  const last = snapshots[snapshots.length - 1]!;

  // A decisive outcome (approved / rejected) is never stalled.
  if (!UNRESOLVED.has(last.status)) return notStalled();

  // Time-based signal: the current trailing run of unresolved snapshots
  // has been open longer than the allowed window.
  if (config.maxPendingHours !== undefined) {
    const streak = trailingUnresolvedStreak(snapshots);
    const oldestMs = Date.parse(streak[0]!.evaluatedAt);
    const lastMs = Date.parse(last.evaluatedAt);
    if (Number.isNaN(oldestMs) || Number.isNaN(lastMs)) {
      // fail-closed: a pending timeout is being enforced but the timeline
      // carries an unparseable timestamp — treat as stalled.
      return {
        stalled: true,
        reason: "unparseable evaluatedAt in consensus timeline",
      };
    }
    const hours = (lastMs - oldestMs) / 3_600_000;
    if (hours > config.maxPendingHours) {
      return {
        stalled: true,
        reason: `consensus pending beyond max ${config.maxPendingHours}h (${hours.toFixed(1)}h)`,
      };
    }
  }

  // Progress-based signal: across the trailing window, the consensus stayed
  // unresolved and neither approvals nor participation increased.
  if (snapshots.length >= config.stallAfterSnapshots) {
    const window = snapshots.slice(-config.stallAfterSnapshots);
    const allUnresolved = window.every((s) => UNRESOLVED.has(s.status));
    const first = window[0]!;
    const wlast = window[window.length - 1]!;
    const noApprovalProgress = wlast.totalApprovals <= first.totalApprovals;
    const noParticipantProgress = wlast.totalParticipants <= first.totalParticipants;
    if (allUnresolved && noApprovalProgress && noParticipantProgress) {
      return {
        stalled: true,
        reason: `consensus made no progress across ${config.stallAfterSnapshots} snapshots`,
      };
    }
  }

  return notStalled();
}

/**
 * Build a progress snapshot from a persisted consensus evaluation. The
 * goal wiring uses this to turn `review_consensus` rows into the detector's
 * input.
 */
export function snapshotFromConsensus(input: {
  evaluatedAt: string;
  status: ConsensusStatus;
  requirements: ReadonlyArray<
    Pick<ConsensusRequirementCheck, "approvals" | "participants" | "blocked">
  >;
}): ConsensusProgressSnapshot {
  return {
    evaluatedAt: input.evaluatedAt,
    status: input.status,
    totalApprovals: input.requirements.reduce((sum, r) => sum + r.approvals, 0),
    totalParticipants: input.requirements.reduce(
      (sum, r) => sum + (r.participants ?? 0),
      0,
    ),
    blocked: input.requirements.some((r) => r.blocked),
  };
}

function trailingUnresolvedStreak(
  snapshots: ConsensusProgressSnapshot[],
): ConsensusProgressSnapshot[] {
  let start = snapshots.length;
  while (start > 0 && UNRESOLVED.has(snapshots[start - 1]!.status)) {
    start -= 1;
  }
  return snapshots.slice(start);
}

function notStalled(): ConsensusStallResult {
  return { stalled: false, reason: null };
}
