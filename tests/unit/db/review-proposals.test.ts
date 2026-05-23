import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  ReviewProposalRepository,
} from "../../../src/db/repositories/review-proposals.js";

/**
 * Phase 9-8 — review_proposals repository.
 */

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "harness-rp-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

const RUN_ID = "run-20260523-apps-web-rp1";

function baseProposal(over: Partial<Parameters<
  ReviewProposalRepository["insertProposal"]
>[0]> = {}) {
  return {
    runId: RUN_ID,
    reviewer: "codex-reviewer",
    decision: "approved" as const,
    requiredChanges: [],
    nonBlockingComments: [],
    outOfScopeSuggestions: [],
    reviewedAt: "2026-05-23T10:00:00Z",
    sourceYaml: "decision: approved\n",
    sourceSha256: "deadbeef",
    createdAt: "2026-05-23T10:00:00Z",
    ...over,
  };
}

describe("ReviewProposalRepository", () => {
  it("inserts a proposal and reads it back as the active latest", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    const { proposalId } = repo.insertProposal(baseProposal());
    expect(proposalId).toBeGreaterThan(0);
    const got = repo.getLatestActiveProposal(RUN_ID);
    expect(got?.proposalId).toBe(proposalId);
    expect(got?.decision).toBe("approved");
    expect(got?.supersededAt).toBeNull();
    expect(got?.processedAt).toBeNull();
    db.close();
  });

  it("supersedes the previous active proposal when the same reviewer re-reviews", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    const a = repo.insertProposal(baseProposal());
    const b = repo.insertProposal(
      baseProposal({
        decision: "changes_requested",
        reviewedAt: "2026-05-23T11:00:00Z",
        createdAt: "2026-05-23T11:00:00Z",
        requiredChanges: ["fix it"],
      }),
    );
    expect(b.proposalId).toBeGreaterThan(a.proposalId);
    const got = repo.getLatestActiveProposal(RUN_ID);
    expect(got?.proposalId).toBe(b.proposalId);
    expect(got?.decision).toBe("changes_requested");
    // the prior active row is marked superseded
    const all = db
      .prepare("SELECT superseded_at FROM review_proposals WHERE proposal_id = ?")
      .get(a.proposalId) as { superseded_at: string | null };
    expect(all.superseded_at).not.toBeNull();
    db.close();
  });

  it("--reviewer scopes the active query", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    repo.insertProposal(baseProposal({ reviewer: "codex-reviewer" }));
    repo.insertProposal(
      baseProposal({
        reviewer: "human-reviewer",
        decision: "approved",
        reviewedAt: "2026-05-23T12:00:00Z",
        createdAt: "2026-05-23T12:00:00Z",
      }),
    );
    expect(
      repo.getLatestActiveProposal(RUN_ID, "codex-reviewer")?.reviewer,
    ).toBe("codex-reviewer");
    expect(
      repo.getLatestActiveProposal(RUN_ID, "human-reviewer")?.reviewer,
    ).toBe("human-reviewer");
    db.close();
  });

  it("markProcessed records processed_at + review_decision_id", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    const { proposalId } = repo.insertProposal(baseProposal());
    repo.markProcessed(proposalId, RUN_ID, "2026-05-23T13:00:00Z");
    const row = repo.getLatestActiveProposal(RUN_ID);
    expect(row?.processedAt).toBe("2026-05-23T13:00:00Z");
    expect(row?.reviewDecisionId).toBe(RUN_ID);
    db.close();
  });

  it("active partial unique index allows only one active per (run, reviewer)", () => {
    const db = freshDb();
    // direct INSERT — bypassing the repo's supersede-then-insert — must
    // fail when two active rows would coexist.
    db.prepare(
      `INSERT INTO review_proposals (run_id, reviewer, decision, reviewed_at,
         source_yaml, source_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(RUN_ID, "rv", "pending", "t", "y", "s", "t");
    expect(() =>
      db
        .prepare(
          `INSERT INTO review_proposals (run_id, reviewer, decision, reviewed_at,
             source_yaml, source_sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(RUN_ID, "rv", "approved", "t", "y", "s", "t"),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});
