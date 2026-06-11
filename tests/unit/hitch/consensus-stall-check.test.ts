import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewConsensusRepository } from "../../../src/db/repositories/review-consensus.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import {
  dbConsensusSnapshotProvider,
  evaluateConsensusStallForHitch,
} from "../../../src/hitch/consensus-stall-check.js";
import type { ConsensusStatus, ConsensusSummary } from "../../../src/core/review-consensus.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-consensus-stall-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, goals: new HitchRepository(db) };
}

function summary(input: {
  evaluatedAt: string;
  approvals: number;
  participants: number;
  blocked?: boolean;
}): ConsensusSummary {
  return {
    evaluatedAt: input.evaluatedAt,
    ruleSha256: "sha",
    proposals: [],
    override: null,
    excludedProposals: [],
    requirements: [
      {
        group: "g",
        required: 1,
        approvals: input.approvals,
        participants: input.participants,
        quorumMet: false,
        blocked: input.blocked ?? false,
      },
    ],
    decisionPath: "requirements-pending",
  };
}

function seedRun(db: ReturnType<typeof openDb>, runId: string) {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch, status,
       started_at, updated_at, source_mode, db_revision, meta_json)
     VALUES (?, 'repo', 'domain', 'domain-coding', 'main', 'needs_review',
       '2026-06-05T08:00:00Z', '2026-06-05T08:00:00Z', 'db-first', 1, '{}')`,
  ).run(runId);
}

function seedConsensus(
  db: ReturnType<typeof openDb>,
  runId: string,
  evaluatedAt: string,
  status: ConsensusStatus,
  approvals: number,
  participants: number,
  blocked = false,
) {
  new ReviewConsensusRepository(db).insertActive({
    runId,
    ruleSha256: "sha",
    status,
    summary: summary({ evaluatedAt, approvals, participants, blocked }),
    evaluatedAt,
    evaluatedBy: "test",
    sourceProposalIds: [],
  });
}

function seedReviewCycle(goals: HitchRepository, hitchId: string, runId: string): string {
  const cycle = goals.startReviewCycle({
    hitchId,
    reviewMode: "delta",
    sourceRunId: runId,
  });
  goals.completeReviewCycle({ cycleId: cycle.cycleId, summary: "seed" });
  return cycle.cycleId;
}

describe("evaluateConsensusStallForHitch (Phase 2-3)", () => {
  it("escalates the goal when consensus is stalled (no progress)", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-stall",
        title: "Goal stall",
        createdBy: "test",
        createdSource: "cli",
      });
      const cycleId = seedReviewCycle(goals, "goal-stall", "run-1");
      seedRun(db, "run-1");
      seedConsensus(db, "run-1", "2026-06-05T09:00:00Z", "pending", 0, 1);
      seedConsensus(db, "run-1", "2026-06-05T10:00:00Z", "pending", 0, 1);
      seedConsensus(db, "run-1", "2026-06-05T11:00:00Z", "pending", 0, 1);

      const result = evaluateConsensusStallForHitch({
        repository: goals,
        hitchId: "goal-stall",
        provider: dbConsensusSnapshotProvider(db),
        createdBy: "test",
        cycleId,
      });

      expect(result.stalled).toBe(true);
      expect(result.goalStatus?.status).toBe("escalated");
      expect(goals.requireSession("goal-stall").status).toBe("escalated");
      // P3: the escalate record links the triggering cycle + is surfaced.
      expect(result.decisionRecord?.decision).toBe("escalate");
      expect(result.decisionRecord?.cycleId).toBe(cycleId);
    } finally {
      db.close();
    }
  });

  it("does not escalate when consensus is progressing", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-progress",
        title: "Goal progress",
        createdBy: "test",
        createdSource: "cli",
      });
      seedReviewCycle(goals, "goal-progress", "run-1");
      seedRun(db, "run-1");
      seedConsensus(db, "run-1", "2026-06-05T09:00:00Z", "pending", 0, 1);
      seedConsensus(db, "run-1", "2026-06-05T10:00:00Z", "pending", 0, 2);
      seedConsensus(db, "run-1", "2026-06-05T11:00:00Z", "pending", 1, 3);

      const result = evaluateConsensusStallForHitch({
        repository: goals,
        hitchId: "goal-progress",
        provider: dbConsensusSnapshotProvider(db),
        createdBy: "test",
      });

      expect(result.stalled).toBe(false);
      expect(result.goalStatus).toBeNull();
      expect(goals.requireSession("goal-progress").status).not.toBe("escalated");
    } finally {
      db.close();
    }
  });

  it("does not escalate a resolved (approved) consensus", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-approved",
        title: "Goal approved",
        createdBy: "test",
        createdSource: "cli",
      });
      seedReviewCycle(goals, "goal-approved", "run-1");
      seedRun(db, "run-1");
      seedConsensus(db, "run-1", "2026-06-05T09:00:00Z", "pending", 0, 1);
      seedConsensus(db, "run-1", "2026-06-05T10:00:00Z", "pending", 0, 1);
      seedConsensus(db, "run-1", "2026-06-05T11:00:00Z", "approved", 1, 1);

      const result = evaluateConsensusStallForHitch({
        repository: goals,
        hitchId: "goal-approved",
        provider: dbConsensusSnapshotProvider(db),
        createdBy: "test",
      });

      expect(result.stalled).toBe(false);
      expect(goals.requireSession("goal-approved").status).not.toBe("escalated");
    } finally {
      db.close();
    }
  });

  it("does not stall on a latest-proposal flow (repeated changes_requested, no requirements)", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-latest",
        title: "Goal latest-proposal",
        createdBy: "test",
        createdSource: "cli",
      });
      seedReviewCycle(goals, "goal-latest", "run-1");
      seedRun(db, "run-1");
      // latest-proposal mode: consensus rows carry NO requirements.
      const repo = new ReviewConsensusRepository(db);
      for (const evaluatedAt of [
        "2026-06-05T09:00:00Z",
        "2026-06-05T10:00:00Z",
        "2026-06-05T11:00:00Z",
      ]) {
        repo.insertActive({
          runId: "run-1",
          ruleSha256: "sha",
          status: "changes_requested",
          summary: {
            evaluatedAt,
            ruleSha256: "sha",
            proposals: [],
            override: null,
            excludedProposals: [],
            requirements: [],
            decisionPath: "no-requirements-latest-proposal",
          },
          evaluatedAt,
          evaluatedBy: "test",
          sourceProposalIds: [],
        });
      }

      const result = evaluateConsensusStallForHitch({
        repository: goals,
        hitchId: "goal-latest",
        provider: dbConsensusSnapshotProvider(db),
        createdBy: "test",
      });

      expect(result.stalled).toBe(false);
      expect(goals.requireSession("goal-latest").status).not.toBe("escalated");
    } finally {
      db.close();
    }
  });

  it("fail-closed: a malformed consensus summary (requirements not an array) escalates", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-malformed",
        title: "Goal malformed",
        createdBy: "test",
        createdSource: "cli",
      });
      seedReviewCycle(goals, "goal-malformed", "run-1");
      seedRun(db, "run-1");
      new ReviewConsensusRepository(db).insertActive({
        runId: "run-1",
        ruleSha256: "sha",
        status: "pending",
        // requirements deliberately not an array → corruption.
        summary: {
          evaluatedAt: "2026-06-05T09:00:00Z",
          ruleSha256: "sha",
          proposals: [],
          override: null,
          excludedProposals: [],
          requirements: null as unknown as [],
          decisionPath: "requirements-pending",
        },
        evaluatedAt: "2026-06-05T09:00:00Z",
        evaluatedBy: "test",
        sourceProposalIds: [],
      });

      const result = evaluateConsensusStallForHitch({
        repository: goals,
        hitchId: "goal-malformed",
        provider: dbConsensusSnapshotProvider(db),
        createdBy: "test",
      });

      expect(result.stalled).toBe(true);
      expect(result.reason).toContain("unreadable");
      expect(goals.requireSession("goal-malformed").status).toBe("escalated");
    } finally {
      db.close();
    }
  });

  it("fail-closed: provider failure escalates the goal", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-corrupt",
        title: "Goal corrupt",
        createdBy: "test",
        createdSource: "cli",
      });
      seedReviewCycle(goals, "goal-corrupt", "run-1");

      const result = evaluateConsensusStallForHitch({
        repository: goals,
        hitchId: "goal-corrupt",
        provider: () => {
          throw new Error("malformed summary_json");
        },
        createdBy: "test",
      });

      expect(result.stalled).toBe(true);
      expect(result.reason).toContain("unreadable");
      expect(goals.requireSession("goal-corrupt").status).toBe("escalated");
    } finally {
      db.close();
    }
  });

  it("is a no-op when the goal has no review runs", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-none",
        title: "Goal none",
        createdBy: "test",
        createdSource: "cli",
      });
      const result = evaluateConsensusStallForHitch({
        repository: goals,
        hitchId: "goal-none",
        provider: dbConsensusSnapshotProvider(db),
        createdBy: "test",
      });
      expect(result.stalled).toBe(false);
      expect(result.goalStatus).toBeNull();
    } finally {
      db.close();
    }
  });
});
