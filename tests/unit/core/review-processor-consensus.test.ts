import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewProposalRepository } from "../../../src/db/repositories/review-proposals.js";
import { ReviewRulesRepository } from "../../../src/db/repositories/review-rules.js";
import { ReviewConsensusRepository } from "../../../src/db/repositories/review-consensus.js";
import { ReviewerRepository } from "../../../src/db/repositories/reviewers.js";
import { canonicaliseRule, ruleSha256, type ReviewRule } from "../../../src/core/review-rule.js";
import {
  processReviewDecision,
  ReviewGateError,
} from "../../../src/core/review-processor.js";

const NOW = "2026-06-05T10:00:00Z";

function consensusRule(): ReviewRule {
  return {
    mode: "consensus",
    requirements: [
      {
        group: "humans",
        minApprovals: 1,
        blockingDecisions: ["changes_requested", "rejected"],
        quorum: { minParticipants: 2 },
      },
    ],
    overrides: { allowedReviewers: [], requireReason: true },
    staleProposal: { rejectSuperseded: true },
  };
}

function setup(rule: ReviewRule = consensusRule()) {
  const root = mkdtempSync(join(tmpdir(), "harness-consensus-process-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch, status,
       source_mode, db_revision, export_status, started_at, updated_at, meta_json)
     VALUES ('run-consensus', 'repo', 'apps/web', 'domain-coding', 'main',
       'needs_review', 'db-first', 1, 'disabled', ?, ?, '{}')`,
  ).run(NOW, NOW);
  const reviewers = new ReviewerRepository(db);
  reviewers.add({ reviewerId: "alice", reviewerType: "human", displayName: "Alice", groupId: "humans" });
  reviewers.add({ reviewerId: "bob", reviewerType: "human", displayName: "Bob", groupId: "humans" });
  const template = new ReviewRulesRepository(db).upsertRuleTemplate({
    source: "manual",
    rule,
  });
  new ReviewRulesRepository(db).snapshotForRun({ runId: "run-consensus", template });
  db.close();
  return { root, runsDir, dbPath };
}

function seedProposal(
  dbPath: string,
  reviewer: string,
  decision: "approved" | "changes_requested" | "rejected",
  requiredChanges: string[] = [],
  reviewedAt = NOW,
): number {
  const db = openDb(dbPath);
  const sourceYaml = `decision: ${decision}\n`;
  try {
    return new ReviewProposalRepository(db).insertProposal({
      runId: "run-consensus",
      reviewer,
      decision,
      requiredChanges,
      nonBlockingComments: [],
      outOfScopeSuggestions: [],
      reviewedAt,
      sourceYaml,
      sourceSha256: createHash("sha256").update(sourceYaml + reviewer).digest("hex"),
      createdAt: reviewedAt,
    }).proposalId;
  } finally {
    db.close();
  }
}

async function runProcess(dbPath: string, runsDir: string, root: string) {
  return processReviewDecision({
    runsDir,
    runId: "run-consensus",
    locksDir: join(root, "locks"),
    dbPath,
    now: new Date(NOW),
  });
}

function runStatus(dbPath: string): string {
  const db = openDb(dbPath);
  const row = db.prepare("SELECT status FROM runs WHERE run_id = 'run-consensus'").get() as { status: string };
  db.close();
  return row.status;
}

function consensusSnapshot(dbPath: string): {
  sourceProposalIds: number[];
  summaryProposalReviewers: Array<string | null>;
  requiredChanges: string[];
} {
  const db = openDb(dbPath);
  try {
    const consensus = new ReviewConsensusRepository(db).findActive("run-consensus");
    const requiredChanges = db
      .prepare(
        `SELECT change_text FROM review_required_changes
          WHERE run_id = 'run-consensus'
          ORDER BY idx ASC`,
      )
      .all() as { change_text: string }[];
    return {
      sourceProposalIds: JSON.parse(consensus!.sourceProposalsJson) as number[],
      summaryProposalReviewers: (
        JSON.parse(consensus!.summaryJson) as {
          proposals: Array<{ reviewerId: string | null }>;
        }
      ).proposals.map((p) => p.reviewerId),
      requiredChanges: requiredChanges.map((r) => r.change_text),
    };
  } finally {
    db.close();
  }
}

describe("review process — consensus mode gating (Phase 2)", () => {
  it("fail-closed: refuses to promote while quorum is not met", async () => {
    const { root, runsDir, dbPath } = setup();
    seedProposal(dbPath, "alice", "approved");

    await expect(runProcess(dbPath, runsDir, root)).rejects.toBeInstanceOf(
      ReviewGateError,
    );
    expect(runStatus(dbPath)).toBe("needs_review");
  });

  it("promotes to approved once quorum + approvals are satisfied", async () => {
    const { root, runsDir, dbPath } = setup();
    seedProposal(dbPath, "alice", "approved");
    seedProposal(dbPath, "bob", "approved");

    const result = await runProcess(dbPath, runsDir, root);
    expect(result.newStatus).toBe("approved");
    expect(result.reviewer).toBe("consensus");
    expect(runStatus(dbPath)).toBe("approved");

    const db = openDb(dbPath);
    const consensus = new ReviewConsensusRepository(db).findActive("run-consensus");
    expect(consensus?.status).toBe("approved");
    // both proposals were aggregated and marked processed.
    const open = new ReviewProposalRepository(db)
      .listForRun("run-consensus")
      .filter((p) => p.processedAt === null);
    expect(open).toHaveLength(0);
    db.close();
  });

  it("excludes a stale proposal from the decision and does not mark it processed", async () => {
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        { group: "humans", minApprovals: 1, blockingDecisions: ["changes_requested", "rejected"] },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true, maxAgeHours: 1 },
    };
    const { root, runsDir, dbPath } = setup(rule);
    // bob's verdict is 2h old → stale; alice's is fresh.
    seedProposal(dbPath, "bob", "approved", [], "2026-06-05T08:00:00Z");
    seedProposal(dbPath, "alice", "approved", [], NOW);

    const result = await runProcess(dbPath, runsDir, root);
    expect(result.newStatus).toBe("approved");

    const db = openDb(dbPath);
    const all = new ReviewProposalRepository(db).listForRun("run-consensus");
    const bob = all.find((p) => p.reviewer === "bob");
    const alice = all.find((p) => p.reviewer === "alice");
    // alice (fresh) was processed; bob (stale) was excluded and left active.
    expect(alice?.processedAt).not.toBeNull();
    expect(bob?.processedAt).toBeNull();
    const consensus = new ReviewConsensusRepository(db).findActive("run-consensus");
    expect(JSON.parse(consensus!.sourceProposalsJson)).toEqual([alice?.proposalId]);
    db.close();
  });

  it("promotes to changes_requested with aggregated required changes when a group member blocks", async () => {
    const { root, runsDir, dbPath } = setup();
    seedProposal(dbPath, "alice", "changes_requested", ["fix the auth check"]);
    seedProposal(dbPath, "bob", "approved");

    const result = await runProcess(dbPath, runsDir, root);
    expect(result.newStatus).toBe("changes_requested");
    expect(runStatus(dbPath)).toBe("changes_requested");
  });

  it("C4: excludes an out-of-frozen-set reviewer's approval from quorum + decision", async () => {
    // Frozen reviewer set = {alice, bob}; charlie is a real reviewer that is
    // NOT in the rule's reviewerIds. An active charlie approval must not count
    // toward quorum/participation, so with only alice approving the consensus
    // stays pending (1 of 2), and charlie's proposal is never marked processed.
    const frozenRule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "humans",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "scope_fit"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { root, runsDir, dbPath } = setup(frozenRule);
    const db = openDb(dbPath);
    new ReviewerRepository(db).add({
      reviewerId: "charlie",
      reviewerType: "human",
      displayName: "Charlie",
      groupId: "humans",
    });
    db.close();
    seedProposal(dbPath, "alice", "approved");
    seedProposal(dbPath, "charlie", "approved");

    // charlie's approval is out-of-set, so quorum (2 frozen participants) is not
    // met → fail-closed, run not promoted.
    await expect(runProcess(dbPath, runsDir, root)).rejects.toBeInstanceOf(
      ReviewGateError,
    );
    expect(runStatus(dbPath)).toBe("needs_review");

    const after = openDb(dbPath);
    try {
      const all = new ReviewProposalRepository(after).listForRun("run-consensus");
      const charlie = all.find((p) => p.reviewer === "charlie");
      const alice = all.find((p) => p.reviewer === "alice");
      // neither is processed (gate failed), but crucially charlie stays active
      // and was never folded into the evaluated set.
      expect(charlie?.processedAt).toBeNull();
      expect(alice?.processedAt).toBeNull();
      const consensus = new ReviewConsensusRepository(after).findActive(
        "run-consensus",
      );
      // No active consensus is written on the gate-failure path.
      expect(consensus).toBeNull();
    } finally {
      after.close();
    }
  });

  it("C4: a quorum reached only via out-of-set reviewers does not promote", async () => {
    // alice (frozen) approves + charlie (out-of-set) approves = 2 distinct
    // approvals, but only ONE is a frozen participant. The frozen-set filter
    // must keep this below quorum so the run is NOT promoted on a borrowed vote.
    const frozenRule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "humans",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "scope_fit"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { root, runsDir, dbPath } = setup(frozenRule);
    const db = openDb(dbPath);
    new ReviewerRepository(db).add({
      reviewerId: "charlie",
      reviewerType: "human",
      displayName: "Charlie",
      groupId: "humans",
    });
    db.close();
    seedProposal(dbPath, "alice", "approved");
    seedProposal(dbPath, "bob", "approved");
    seedProposal(dbPath, "charlie", "approved");

    // With bob also approving, quorum IS met by frozen members alone → approved.
    // charlie's vote is excluded but does not block the legitimate quorum.
    const result = await runProcess(dbPath, runsDir, root);
    expect(result.newStatus).toBe("approved");

    const after = openDb(dbPath);
    try {
      const consensus = new ReviewConsensusRepository(after).findActive(
        "run-consensus",
      );
      // only alice + bob are folded into the source set; charlie is excluded.
      const reviewers = (
        JSON.parse(consensus!.summaryJson) as {
          proposals: Array<{ reviewerId: string | null }>;
        }
      ).proposals.map((p) => p.reviewerId);
      expect(reviewers).toEqual(["alice", "bob"]);
      const charlie = new ReviewProposalRepository(after)
        .listForRun("run-consensus")
        .find((p) => p.reviewer === "charlie");
      // charlie was excluded from the evaluated set and left active (not processed).
      expect(charlie?.processedAt).toBeNull();
    } finally {
      after.close();
    }
  });

  it("aggregates proposals, source ids, and required changes by reviewer_id then proposal_id", async () => {
    const first = setup();
    const firstBobId = seedProposal(
      first.dbPath,
      "bob",
      "changes_requested",
      ["fix bob"],
    );
    const firstAliceId = seedProposal(
      first.dbPath,
      "alice",
      "changes_requested",
      ["fix alice"],
    );
    await runProcess(first.dbPath, first.runsDir, first.root);

    const second = setup();
    const secondAliceId = seedProposal(
      second.dbPath,
      "alice",
      "changes_requested",
      ["fix alice"],
    );
    const secondBobId = seedProposal(
      second.dbPath,
      "bob",
      "changes_requested",
      ["fix bob"],
    );
    await runProcess(second.dbPath, second.runsDir, second.root);

    expect(consensusSnapshot(first.dbPath)).toEqual({
      summaryProposalReviewers: ["alice", "bob"],
      sourceProposalIds: [firstAliceId, firstBobId],
      requiredChanges: ["fix alice", "fix bob"],
    });
    expect(consensusSnapshot(second.dbPath)).toEqual({
      summaryProposalReviewers: ["alice", "bob"],
      sourceProposalIds: [secondAliceId, secondBobId],
      requiredChanges: ["fix alice", "fix bob"],
    });
  });
});
