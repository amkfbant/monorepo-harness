import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processReviewDecision } from "../../src/core/review-processor.js";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  ReviewProposalRepository,
} from "../../src/db/repositories/review-proposals.js";

/**
 * Phase 9 post-close P1 #1 fix — `review process` is idempotent on a
 * crash-survived retry.
 *
 * The codex external review pointed out that `applyReviewDecision`
 * (which moves run.status: needs_review → approved) and `markProcessed`
 * (which records that the proposal is consumed) were two separate writes,
 * so a crash between the two left an active-but-unprocessed proposal on
 * a run that was no longer in `needs_review`. A retry of `review process`
 * then failed the status gate.
 *
 * Post-close fix:
 *   1. `applyReviewDecision` takes an optional `markProposalProcessed`
 *      payload and runs it inside the same transaction.
 *   2. `getLatestActiveProposal` filters out `processed_at IS NOT NULL`.
 *   3. `review process` short-circuits on `getLatestProcessedProposal`
 *      when the run is already past `needs_review`.
 */

function setupRoot(): { root: string; runsDir: string; locksDir: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-rpidemp-"));
  const runsDir = join(root, "runs");
  const locksDir = join(root, "locks");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(locksDir, { recursive: true });
  return {
    root,
    runsDir,
    locksDir,
    dbPath: join(root, ".harness", "harness.sqlite"),
  };
}

const RUN_ID = "run-20260523-apps-user-rp1";
const RUN_BASE_META = {
  runId: RUN_ID,
  repoId: "t",
  repoPath: "/tmp/t",
  domain: "apps/user",
  workflow: "domain-coding",
  baseBranch: "main",
  baseSha: "abc",
  runBranch: "harness/x",
  status: "needs_review",
  safetyStatus: "allowed",
  startedAt: "2026-05-23T00:00:00Z",
} as const;

const APPROVED_YAML = [
  `runId: ${RUN_ID}`,
  "domain: apps/user",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "reviewer: codex-reviewer",
  "reviewed_at: 2026-05-23T10:00:00Z",
  "",
].join("\n");

/** Seed a db-first run in needs_review plus a matching active proposal. */
function seedDbFirstWithProposal(dbPath: string, runsDir: string): void {
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch, status,
         source_mode, db_revision, export_status, started_at, updated_at, meta_json)
       VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
         'db-first', 1, 'disabled', ?, ?, ?)`,
    ).run(
      RUN_ID,
      RUN_BASE_META.startedAt,
      RUN_BASE_META.startedAt,
      JSON.stringify(RUN_BASE_META, null, 2),
    );
    new ReviewProposalRepository(db).insertProposal({
      runId: RUN_ID,
      reviewer: "codex-reviewer",
      decision: "approved",
      requiredChanges: [],
      nonBlockingComments: [],
      outOfScopeSuggestions: [],
      reviewedAt: "2026-05-23T10:00:00Z",
      sourceYaml: APPROVED_YAML,
      sourceSha256: "deadbeef",
      createdAt: "2026-05-23T10:00:00Z",
    });
  } finally {
    db.close();
  }
  // a run dir exists with at least a meta.json so the lock key probe path
  // is happy on the legacy fallback (this run is db-first so the DB is the
  // canonical source, but processReviewDecision still computes runDir).
  const runDir = join(runsDir, RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(RUN_BASE_META, null, 2),
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
}

describe("review process — idempotent on retry (Phase 9 post-close P1 #1)", () => {
  it("a second call after a successful first is an idempotent no-op", async () => {
    const { runsDir, locksDir, dbPath } = setupRoot();
    seedDbFirstWithProposal(dbPath, runsDir);

    // first call promotes the run and marks the proposal processed in
    // one transaction.
    const r1 = await processReviewDecision({
      runsDir,
      locksDir,
      dbPath,
      runId: RUN_ID,
    });
    expect(r1.previousStatus).toBe("needs_review");
    expect(r1.newStatus).toBe("approved");

    // verify the in-DB state — proposal is processed, run is approved.
    {
      const db = openDb(dbPath);
      try {
        const run = db
          .prepare("SELECT status FROM runs WHERE run_id = ?")
          .get(RUN_ID) as { status: string };
        expect(run.status).toBe("approved");
        const repo = new ReviewProposalRepository(db);
        expect(repo.getLatestActiveProposal(RUN_ID)).toBeNull();
        const processed = repo.getLatestProcessedProposal(RUN_ID);
        expect(processed?.processedAt).toBe(r1.reviewedAt);
      } finally {
        db.close();
      }
    }

    // second call must NOT throw a ReviewGateError just because the run
    // is no longer in needs_review — it returns an idempotent no-op.
    const r2 = await processReviewDecision({
      runsDir,
      locksDir,
      dbPath,
      runId: RUN_ID,
    });
    expect(r2.previousStatus).toBe("approved");
    expect(r2.newStatus).toBe("approved");
    expect(r2.warnings.some((w) => /idempotent/i.test(w))).toBe(true);
  });

  it(
    "a crash between applyReviewDecision and markProcessed cannot leave " +
      "an active proposal — applyReviewDecision runs both in one transaction",
    async () => {
      const { runsDir, locksDir, dbPath } = setupRoot();
      seedDbFirstWithProposal(dbPath, runsDir);

      // we cannot fault-inject inside the transaction without rewriting
      // RunRepository, but we can verify the invariant: after a successful
      // applyReviewDecision, the proposal row is already processed without
      // any further call. Any partial state would surface as an active row
      // still pointing at the (now-approved) run.
      const before = (() => {
        const db = openDb(dbPath);
        try {
          return new ReviewProposalRepository(db).getLatestActiveProposal(RUN_ID);
        } finally {
          db.close();
        }
      })();
      expect(before).not.toBeNull();

      await processReviewDecision({
        runsDir,
        locksDir,
        dbPath,
        runId: RUN_ID,
      });

      const db = openDb(dbPath);
      try {
        const repo = new ReviewProposalRepository(db);
        // active is gone — the same transaction stamped processed_at
        expect(repo.getLatestActiveProposal(RUN_ID)).toBeNull();
        // and the processed row points at the run as its decision id
        const processed = repo.getLatestProcessedProposal(RUN_ID);
        expect(processed?.reviewDecisionId).toBe(RUN_ID);
        expect(processed?.processedAt).not.toBeNull();
      } finally {
        db.close();
      }
    },
  );
});
