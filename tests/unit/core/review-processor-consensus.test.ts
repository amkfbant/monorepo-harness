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
) {
  const db = openDb(dbPath);
  const sourceYaml = `decision: ${decision}\n`;
  new ReviewProposalRepository(db).insertProposal({
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
  });
  db.close();
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
});
