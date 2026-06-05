import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewerAgentGateError } from "../../../src/core/reviewer-agent.js";
import {
  ReviewProposalRepository,
} from "../../../src/db/repositories/review-proposals.js";

/**
 * Phase 9-8 — review_proposals repository.
 */

const RUN_ID = "run-20260523-apps-web-rp1";

function seedDbFirstNeedsReviewRun(
  db: ReturnType<typeof openDb>,
  runId = RUN_ID,
) {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, source_mode, db_revision, export_status, updated_at, meta_json)
     VALUES (?, 't', 'apps/web', 'domain-coding', 'main', 'needs_review',
       'db-first', 1, 'disabled', '2026-05-23T00:00:00Z', '{}')`,
  ).run(runId);
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "harness-rp-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  seedDbFirstNeedsReviewRun(db);
  return db;
}

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
  it("rejects a promote-before-insert race for db-first runs", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    db.prepare(
      "UPDATE runs SET status = 'approved' WHERE run_id = ?",
    ).run(RUN_ID);

    expect(() => repo.insertProposal(baseProposal())).toThrow(
      ReviewerAgentGateError,
    );
    expect(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM review_proposals WHERE run_id = ?",
          )
          .get(RUN_ID) as { n: number }
      ).n,
    ).toBe(0);
    db.close();
  });

  it("allows the normal db-first needs_review review-auto insert path", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);

    const { proposalId } = repo.insertProposal(baseProposal());

    expect(proposalId).toBeGreaterThan(0);
    expect(repo.getLatestActiveProposal(RUN_ID)?.proposalId).toBe(proposalId);
    db.close();
  });

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
    // Phase 9 post-close P1 #1 fix — `getLatestActiveProposal` filters
    // out processed rows; `getLatestProcessedProposal` is what surfaces
    // them. The two are deliberately disjoint.
    const active = repo.getLatestActiveProposal(RUN_ID);
    expect(active).toBeNull();
    const processed = repo.getLatestProcessedProposal(RUN_ID);
    expect(processed?.proposalId).toBe(proposalId);
    expect(processed?.processedAt).toBe("2026-05-23T13:00:00Z");
    expect(processed?.reviewDecisionId).toBe(RUN_ID);
    db.close();
  });

  it("getLatestActiveProposal filters out processed proposals (P1 #1)", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    const { proposalId } = repo.insertProposal(baseProposal());
    expect(repo.getLatestActiveProposal(RUN_ID)?.proposalId).toBe(proposalId);
    repo.markProcessed(proposalId, RUN_ID, "2026-05-23T13:00:00Z");
    // a re-fetch must not return the processed row — otherwise a crash
    // between promotion and side effects would loop forever.
    expect(repo.getLatestActiveProposal(RUN_ID)).toBeNull();
    db.close();
  });

  it("markProcessed is idempotent — a second call does not overwrite (P1 #1)", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    const { proposalId } = repo.insertProposal(baseProposal());
    expect(repo.markProcessed(proposalId, RUN_ID, "2026-05-23T13:00:00Z")).toBe(
      true,
    );
    // A second call with a different timestamp / decision id must NOT
    // overwrite — the WHERE processed_at IS NULL guard makes the UPDATE
    // a no-op when already processed. The return value reports false.
    expect(repo.markProcessed(proposalId, "other", "2099-01-01T00:00:00Z")).toBe(
      false,
    );
    const processed = repo.getLatestProcessedProposal(RUN_ID);
    expect(processed?.processedAt).toBe("2026-05-23T13:00:00Z");
    expect(processed?.reviewDecisionId).toBe(RUN_ID);
    db.close();
  });

  it(
    "markProcessed rejects a superseded proposal (Phase 9 post-close second review P1-4)",
    () => {
      const db = freshDb();
      const repo = new ReviewProposalRepository(db);
      const first = repo.insertProposal(baseProposal());
      // a second insertProposal supersedes the first
      repo.insertProposal(
        baseProposal({
          decision: "changes_requested",
          reviewedAt: "2026-05-23T11:00:00Z",
          createdAt: "2026-05-23T11:00:00Z",
        }),
      );
      // first is now superseded — marking it processed must fail (returns false)
      expect(
        repo.markProcessed(first.proposalId, RUN_ID, "2026-05-23T13:00:00Z"),
      ).toBe(false);
      db.close();
    },
  );

  it(
    "markProcessed rejects when expectedSourceSha256 mismatches " +
      "(Phase 10-5 design §3.E E1)",
    () => {
      const db = freshDb();
      const repo = new ReviewProposalRepository(db);
      const { proposalId } = repo.insertProposal(baseProposal());
      // wrong sha → no-op (changes=0)
      expect(
        repo.markProcessed(
          proposalId,
          RUN_ID,
          "2026-05-23T13:00:00Z",
          "deadbeef".repeat(8),
        ),
      ).toBe(false);
      // matching sha → succeeds
      const r = db
        .prepare("SELECT source_sha256 FROM review_proposals WHERE proposal_id = ?")
        .get(proposalId) as { source_sha256: string };
      expect(
        repo.markProcessed(
          proposalId,
          RUN_ID,
          "2026-05-23T13:00:00Z",
          r.source_sha256,
        ),
      ).toBe(true);
      db.close();
    },
  );

  it(
    "Phase 11-7 lifecycle: insertProposal supersedes prior active row " +
      "→ lifecycle_status='superseded'; markProcessed → 'processed'",
    () => {
      const db = freshDb();
      const repo = new ReviewProposalRepository(db);
      const first = repo.insertProposal({
        ...baseProposal(),
        createdAt: "2026-05-24T10:00:00Z",
      });
      const r1 = db
        .prepare(
          "SELECT lifecycle_status FROM review_proposals WHERE proposal_id = ?",
        )
        .get(first.proposalId) as { lifecycle_status: string };
      expect(r1.lifecycle_status).toBe("active");

      repo.insertProposal({
        ...baseProposal(),
        createdAt: "2026-05-24T11:00:00Z",
      });
      const r2 = db
        .prepare(
          "SELECT lifecycle_status FROM review_proposals WHERE proposal_id = ?",
        )
        .get(first.proposalId) as { lifecycle_status: string };
      expect(r2.lifecycle_status).toBe("superseded");

      const latest = repo.getLatestActiveProposal(RUN_ID);
      expect(latest).not.toBeNull();
      repo.markProcessed(
        latest!.proposalId,
        RUN_ID,
        "2026-05-24T12:00:00Z",
      );
      const r3 = db
        .prepare(
          "SELECT lifecycle_status FROM review_proposals WHERE proposal_id = ?",
        )
        .get(latest!.proposalId) as { lifecycle_status: string };
      expect(r3.lifecycle_status).toBe("processed");
      db.close();
    },
  );

  it("Phase 11-7 vacuum: dry-run lists eligible / --apply archives them; active rows are never touched", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    const first = repo.insertProposal({
      ...baseProposal(),
      createdAt: "2026-05-01T00:00:00Z",
    });
    // supersede the first → lifecycle='superseded'
    repo.insertProposal({
      ...baseProposal(),
      createdAt: "2026-05-24T00:00:00Z",
    });
    const cutoff = new Date("2026-05-15T00:00:00Z");
    const dryIds = repo.vacuumOlderThan({ olderThan: cutoff });
    expect(dryIds).toContain(first.proposalId);
    // dry-run did not mutate
    expect(
      (
        db
          .prepare(
            "SELECT lifecycle_status FROM review_proposals WHERE proposal_id = ?",
          )
          .get(first.proposalId) as { lifecycle_status: string }
      ).lifecycle_status,
    ).toBe("superseded");
    // --apply archives
    const applyIds = repo.vacuumOlderThan({
      olderThan: cutoff,
      apply: true,
      now: new Date("2026-05-24T13:00:00Z"),
    });
    expect(applyIds).toContain(first.proposalId);
    const row = db
      .prepare(
        "SELECT lifecycle_status, archived_at FROM review_proposals WHERE proposal_id = ?",
      )
      .get(first.proposalId) as { lifecycle_status: string; archived_at: string };
    expect(row.lifecycle_status).toBe("archived");
    expect(row.archived_at).toBe("2026-05-24T13:00:00.000Z");
    // listForRun without --include-archived hides it
    const visible = repo.listForRun(RUN_ID);
    expect(visible.map((r) => r.proposalId)).not.toContain(first.proposalId);
    const all = repo.listForRun(RUN_ID, { includeArchived: true });
    expect(all.map((r) => r.proposalId)).toContain(first.proposalId);
    db.close();
  });

  it("getLatestProcessedProposal returns null when nothing was processed", () => {
    const db = freshDb();
    const repo = new ReviewProposalRepository(db);
    repo.insertProposal(baseProposal());
    expect(repo.getLatestProcessedProposal(RUN_ID)).toBeNull();
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
