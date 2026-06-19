import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { processReviewDecision } from "../../../src/core/review-processor.js";
import type { ReviewRule } from "../../../src/core/review-rule.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewProposalRepository } from "../../../src/db/repositories/review-proposals.js";
import { ReviewRulesRepository } from "../../../src/db/repositories/review-rules.js";
import { ReviewerRepository } from "../../../src/db/repositories/reviewers.js";
import {
  latestHitchAttemptForRun,
  recordHitchAttemptForOperationResult,
} from "../../../src/hitch/operation-integration.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import {
  importReviewProposalToHitch,
  selectProcessedProposalForReviewImport,
} from "../../../src/hitch/review-integration.js";

const DEFAULT_RUN_ID = "run-review";

function fresh(): {
  db: ReturnType<typeof openDb>;
  goals: HitchRepository;
  proposals: ReviewProposalRepository;
} {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-review-integration-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, source_mode, db_revision, export_status, updated_at, meta_json)
     VALUES (?, 'repo', 'apps/web', 'domain-coding', 'main',
       'needs_review', 'db-first', 1, 'disabled',
       '2026-05-26T00:00:00.000Z', '{}')`,
  ).run(DEFAULT_RUN_ID);
  return {
    db,
    goals: new HitchRepository(db),
    proposals: new ReviewProposalRepository(db),
  };
}

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

function freshConsensus(): {
  root: string;
  runsDir: string;
  dbPath: string;
  db: ReturnType<typeof openDb>;
  goals: HitchRepository;
  proposals: ReviewProposalRepository;
} {
  const root = mkdtempSync(join(tmpdir(), "harness-goal-review-consensus-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, source_mode, db_revision, export_status, started_at,
       updated_at, meta_json)
     VALUES ('run-consensus-e2e', 'repo', 'apps/web', 'domain-coding', 'main',
       'needs_review', 'db-first', 1, 'disabled',
       '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z', '{}')`,
  ).run();
  const reviewers = new ReviewerRepository(db);
  reviewers.add({
    reviewerId: "alice",
    reviewerType: "human",
    displayName: "Alice",
    groupId: "humans",
  });
  reviewers.add({
    reviewerId: "bob",
    reviewerType: "human",
    displayName: "Bob",
    groupId: "humans",
  });
  const rules = new ReviewRulesRepository(db);
  const template = rules.upsertRuleTemplate({
    source: "manual",
    rule: consensusRule(),
  });
  rules.snapshotForRun({ runId: "run-consensus-e2e", template });
  return {
    root,
    runsDir,
    dbPath,
    db,
    goals: new HitchRepository(db),
    proposals: new ReviewProposalRepository(db),
  };
}

function createProposal(
  proposals: ReviewProposalRepository,
  input: {
    runId?: string;
    reviewer?: string;
    decision: "approved" | "changes_requested" | "rejected";
    requiredChanges?: string[];
    nonBlockingComments?: string[];
    outOfScopeSuggestions?: string[];
  },
) {
  const sourceYaml = [
    "decision: " + input.decision,
    "required_changes: []",
    "non_blocking_comments: []",
    "out_of_scope_suggestions: []",
    "",
  ].join("\n");
  const inserted = proposals.insertProposal({
    runId: input.runId ?? DEFAULT_RUN_ID,
    reviewer: input.reviewer ?? "codex-review",
    decision: input.decision,
    requiredChanges: input.requiredChanges ?? [],
    nonBlockingComments: input.nonBlockingComments ?? [],
    outOfScopeSuggestions: input.outOfScopeSuggestions ?? [],
    reviewedAt: "2026-05-26T00:00:00.000Z",
    sourceYaml,
    sourceSha256: createHash("sha256").update(sourceYaml).digest("hex"),
    createdAt: "2026-05-26T00:00:00.000Z",
  });
  return proposals.getById(inserted.proposalId)!;
}

function markProcessed(
  proposals: ReviewProposalRepository,
  proposalId: number,
  reviewDecisionId: string,
  processedAt = "2026-05-26T00:01:00.000Z",
): void {
  expect(proposals.markProcessed(proposalId, reviewDecisionId, processedAt)).toBe(
    true,
  );
}

function insertReviewDecision(
  db: ReturnType<typeof openDb>,
  input: {
    runId?: string;
    decision: "approved" | "changes_requested" | "rejected";
    reviewedAt?: string;
    requiredChanges?: string[];
  },
): string {
  const runId = input.runId ?? DEFAULT_RUN_ID;
  const requiredChanges = input.requiredChanges ?? [];
  const sourceYaml = [
    "decision: " + input.decision,
    `required_changes: ${JSON.stringify(requiredChanges)}`,
    "non_blocking_comments: []",
    "out_of_scope_suggestions: []",
    "",
  ].join("\n");
  const sourceSha256 = createHash("sha256").update(sourceYaml).digest("hex");
  db.prepare(
    `INSERT INTO review_decisions (run_id, decision, reviewer, summary,
       reviewed_at, source_yaml, source_sha256)
     VALUES (?, ?, 'consensus', 'aggregate decision', ?, ?, ?)`,
  ).run(
    runId,
    input.decision,
    input.reviewedAt ?? "2026-05-26T00:01:00.000Z",
    sourceYaml,
    sourceSha256,
  );
  const stmt = db.prepare(
    `INSERT INTO review_required_changes (run_id, idx, change_text)
     VALUES (?, ?, ?)`,
  );
  requiredChanges.forEach((change, index) => {
    stmt.run(runId, index, change);
  });
  return sourceSha256;
}

describe("goal review integration", () => {
  it("imports review proposal findings into a completed review cycle", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-review",
        title: "Goal review",
        projectId: "demo",
        domain: "goal",
        scope: {
          targetSummary: "goal convergence controller",
          targetFiles: ["src/goal/**"],
        },
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "changes_requested",
        requiredChanges: [
          "Goal convergence controller should persist operation metadata",
        ],
        nonBlockingComments: ["Future cleanup can simplify CLI wording"],
        outOfScopeSuggestions: ["Add dashboard charts in a later phase"],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-review",
        proposal,
        createdBy: "test",
      });

      expect(imported.cycle.findingsSeen).toBe(3);
      expect(imported.cycle.findingsNew).toBe(3);
      expect(imported.convergenceDecision.cycleId).toBe(imported.cycle.cycleId);
      const findings = goals.listFindings({ hitchId: "goal-review" });
      const required = findings.find((f) => f.category === "review-required-change");
      expect(required).toMatchObject({
        severity: "P1",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        sourceCycleId: imported.cycle.cycleId,
      });
      expect(required?.sourceRef).toBe(
        `review_proposal:${proposal.proposalId}:required_change:0`,
      );
      const followUp = findings.find(
        (f) => f.category === "review-out-of-scope-suggestion",
      );
      expect(followUp).toMatchObject({
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
      });
    } finally {
      db.close();
    }
  });

  it("imports DB-canonical aggregate required changes for non-approved consensus", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-review-aggregate",
        title: "Goal review aggregate",
        projectId: "demo",
        domain: "goal",
        scope: {
          targetSummary: "goal convergence controller",
          targetFiles: ["src/goal/**"],
        },
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "changes_requested",
        requiredChanges: ["Only reviewer A local blocker"],
      });
      insertReviewDecision(db, {
        decision: "changes_requested",
        requiredChanges: [
          "Reviewer A canonical blocker",
          "Reviewer B canonical blocker",
        ],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-review-aggregate",
        proposal,
        processResult: {
          runId: "run-review",
          previousStatus: "needs_review",
          newStatus: "changes_requested",
          reviewer: "consensus",
          reviewedAt: "2026-05-26T00:01:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });

      expect(imported.cycle.findingsSeen).toBe(2);
      const required = goals
        .listFindings({ hitchId: "goal-review-aggregate" })
        .filter((f) => f.category === "review-required-change")
        .map((f) => f.summary)
        .sort();
      expect(required).toEqual([
        "Reviewer A canonical blocker",
        "Reviewer B canonical blocker",
      ]);
    } finally {
      db.close();
    }
  });

  it("imports all consensus-mode aggregate required changes after review processing", async () => {
    const { root, runsDir, dbPath, db, goals, proposals } = freshConsensus();
    try {
      goals.createSession({
        hitchId: "goal-review-consensus-e2e",
        title: "Goal review consensus e2e",
        projectId: "demo",
        domain: "goal",
        scope: {
          targetSummary: "goal convergence controller",
          targetFiles: ["src/goal/**"],
        },
        createdBy: "test",
        createdSource: "cli",
      });
      createProposal(proposals, {
        runId: "run-consensus-e2e",
        reviewer: "alice",
        decision: "changes_requested",
        requiredChanges: ["Alice canonical blocker"],
      });
      createProposal(proposals, {
        runId: "run-consensus-e2e",
        reviewer: "bob",
        decision: "changes_requested",
        requiredChanges: ["Bob canonical blocker"],
      });

      const processResult = await processReviewDecision({
        runsDir,
        runId: "run-consensus-e2e",
        locksDir: join(root, "locks"),
        dbPath,
        now: new Date("2026-05-26T00:01:00.000Z"),
      });

      expect(processResult.newStatus).toBe("changes_requested");
      expect(
        db
          .prepare(
            `SELECT change_text FROM review_required_changes
             WHERE run_id = 'run-consensus-e2e'
             ORDER BY idx ASC`,
          )
          .all()
          .map((row) => (row as { change_text: string }).change_text)
          .sort(),
      ).toEqual(["Alice canonical blocker", "Bob canonical blocker"]);

      const proposal = selectProcessedProposalForReviewImport({
        db,
        runId: "run-consensus-e2e",
      });
      expect(proposal?.processedAt).not.toBeNull();

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-review-consensus-e2e",
        proposal: proposal!,
        processResult,
        createdBy: "test",
      });

      expect(imported.cycle.findingsSeen).toBe(2);
      expect(
        goals
          .listFindings({ hitchId: "goal-review-consensus-e2e" })
          .filter((f) => f.category === "review-required-change")
          .map((f) => f.summary)
          .sort(),
      ).toEqual(["Alice canonical blocker", "Bob canonical blocker"]);
    } finally {
      db.close();
    }
  });

  it("records review_consensus close checks from processed review results", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-close-review",
        title: "Goal close review",
        closeConditions: [
          {
            id: "review-consensus",
            kind: "review_consensus",
            required: true,
          },
        ],
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, { decision: "approved" });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-close-review",
        proposal,
        processResult: {
          runId: "run-review",
          previousStatus: "needs_review",
          newStatus: "approved",
          reviewer: "codex-review",
          reviewedAt: "2026-05-26T00:01:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });

      expect(imported.closeChecks[0]).toMatchObject({
        conditionId: "review-consensus",
        status: "passed",
      });
      expect(imported.convergenceDecision.decision).toBe("close_ready");
      expect(imported.hitchStatus?.status).toBe("close_ready");
      expect(goals.requireSession("goal-close-review").status).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("records canonical decision source hash for consensus close checks", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-consensus-canonical-source",
        title: "Goal consensus canonical source",
        closeConditions: [
          {
            id: "review-consensus",
            kind: "review_consensus",
            required: true,
          },
        ],
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const canonicalSourceSha256 = insertReviewDecision(db, {
        decision: "approved",
        requiredChanges: ["canonical aggregate provenance marker"],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-consensus-canonical-source",
        proposal,
        processResult: {
          runId: "run-review",
          previousStatus: "needs_review",
          newStatus: "approved",
          reviewer: "consensus",
          reviewedAt: "2026-05-26T00:01:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });

      expect(canonicalSourceSha256).not.toBe(proposal.sourceSha256);
      expect(imported.closeChecks[0]?.evidence).toMatchObject({
        decision: "approved",
        processStatus: "approved",
        proposalId: proposal.proposalId,
        sourceSha256: canonicalSourceSha256,
      });
    } finally {
      db.close();
    }
  });

  it("suppresses blocking member findings when the process result canonical decision is approved", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-consensus-approved-process",
        title: "Goal consensus approved process",
        closeConditions: [
          {
            id: "review-consensus",
            kind: "review_consensus",
            required: true,
          },
        ],
        createdBy: "test",
        createdSource: "cli",
      });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const nonApprovingLatest = createProposal(proposals, {
        reviewer: "reviewer-b",
        decision: "changes_requested",
        requiredChanges: [
          "Member B requested a change that the aggregate consensus overruled.",
        ],
        nonBlockingComments: ["Keep an eye on follow-up cleanup."],
        outOfScopeSuggestions: ["Track dashboard polish separately."],
      });
      markProcessed(proposals, approved.proposalId, "decision-approved");
      markProcessed(
        proposals,
        nonApprovingLatest.proposalId,
        "decision-member-b",
      );
      expect(proposals.getLatestProcessedProposal("run-review")?.proposalId).toBe(
        nonApprovingLatest.proposalId,
      );

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-consensus-approved-process",
        proposal: nonApprovingLatest,
        processResult: {
          runId: "run-review",
          previousStatus: "needs_review",
          newStatus: "approved",
          reviewer: "consensus",
          reviewedAt: "2026-05-26T00:01:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });

      expect(imported.findings.map((f) => f.finding.category)).toEqual([
        "review-non-blocking-comment",
        "review-out-of-scope-suggestion",
      ]);
      expect(
        goals
          .listFindings({
            hitchId: "goal-consensus-approved-process",
            scopeStatus: "in_scope",
          })
          .filter(
            (f) =>
              f.severity === "P1" &&
              (f.lifecycleStatus === "open" ||
                f.lifecycleStatus === "reopened"),
          )
          .map((f) => f.category),
      ).toEqual([]);
      expect(imported.closeChecks[0]).toMatchObject({
        conditionId: "review-consensus",
        status: "passed",
        evidence: {
          decision: "approved",
          processStatus: "approved",
          proposalId: nonApprovingLatest.proposalId,
        },
      });
      expect(imported.closeChecks[0]?.evidence).not.toHaveProperty(
        "reviewDecisionId",
      );
      expect(imported.closeChecks[0]?.evidence).not.toHaveProperty(
        "sourceSha256",
      );
      expect(new ConvergenceService(goals).evaluate(
        "goal-consensus-approved-process",
      ).metrics.openInScopeP1).toBe(0);
    } finally {
      db.close();
    }
  });

  it("suppresses blocking member findings from review_decisions when processResult is absent", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-consensus-approved-db",
        title: "Goal consensus approved db",
        closeConditions: [
          {
            id: "review-consensus",
            kind: "review_consensus",
            required: true,
          },
        ],
        createdBy: "test",
        createdSource: "cli",
      });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const rejectedLatest = createProposal(proposals, {
        reviewer: "reviewer-b",
        decision: "rejected",
        requiredChanges: [],
      });
      markProcessed(proposals, approved.proposalId, "decision-approved");
      markProcessed(proposals, rejectedLatest.proposalId, "decision-rejected");
      insertReviewDecision(db, { decision: "approved" });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-consensus-approved-db",
        proposal: rejectedLatest,
        createdBy: "test",
      });

      expect(imported.findings).toEqual([]);
      expect(
        goals.listFindings({ hitchId: "goal-consensus-approved-db" }),
      ).toEqual([]);
      expect(imported.closeChecks).toEqual([]);
      expect(goals.listCloseChecks("goal-consensus-approved-db")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("fails closed when the canonical decision is undeterminable", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-consensus-undeterminable",
        title: "Goal consensus undeterminable",
        scope: {
          allowedFindingCategories: ["review-required-change"],
        },
        closeConditions: [
          {
            id: "review-consensus",
            kind: "review_consensus",
            required: true,
          },
        ],
        createdBy: "test",
        createdSource: "cli",
      });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const nonApprovingLatest = createProposal(proposals, {
        reviewer: "reviewer-b",
        decision: "changes_requested",
        requiredChanges: [
          "Without a canonical aggregate, the member blocker must remain.",
        ],
      });
      markProcessed(proposals, approved.proposalId, "decision-approved");
      markProcessed(
        proposals,
        nonApprovingLatest.proposalId,
        "decision-member-b",
      );

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-consensus-undeterminable",
        proposal: nonApprovingLatest,
        createdBy: "test",
      });

      expect(imported.findings).toHaveLength(1);
      expect(imported.findings[0].finding).toMatchObject({
        category: "review-required-change",
        severity: "P1",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
      });
      expect(imported.closeChecks).toEqual([]);
      expect(goals.listCloseChecks("goal-consensus-undeterminable")).toEqual([]);
      expect(imported.convergenceDecision.decision).toBe("needs_fix");
    } finally {
      db.close();
    }
  });

  it("syncs goal status when review import detects divergence", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-review-diverging",
        title: "Goal review diverging",
        maxTotalNewFindings: 0,
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "changes_requested",
        requiredChanges: ["New blocker exceeds the finding budget"],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-review-diverging",
        proposal,
        createdBy: "test",
      });

      expect(imported.convergenceDecision.decision).toBe("diverging");
      expect(imported.hitchStatus?.status).toBe("diverging");
      expect(goals.requireSession("goal-review-diverging").status).toBe(
        "diverging",
      );
    } finally {
      db.close();
    }
  });

  it("syncs goal status when review import exhausts the review budget", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-review-budget",
        title: "Goal review budget",
        maxReviewCycles: 0,
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, { decision: "approved" });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-review-budget",
        proposal,
        createdBy: "test",
      });

      expect(imported.convergenceDecision.decision).toBe("budget_exhausted");
      expect(imported.hitchStatus?.status).toBe("budget_exhausted");
      expect(goals.requireSession("goal-review-budget").status).toBe(
        "budget_exhausted",
      );
    } finally {
      db.close();
    }
  });

  it("creates a blocking finding for negative reviews without required changes", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-empty-negative-review",
        title: "Goal empty negative review",
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "rejected",
        requiredChanges: [],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-empty-negative-review",
        proposal,
        processResult: {
          runId: "run-review",
          previousStatus: "needs_review",
          newStatus: "rejected",
          reviewer: "codex-review",
          reviewedAt: "2026-05-26T00:02:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });

      expect(imported.findings).toHaveLength(1);
      expect(imported.findings[0].finding).toMatchObject({
        severity: "P1",
        category: "review-negative-decision",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
      });
      expect(imported.convergenceDecision.decision).toBe("needs_fix");
    } finally {
      db.close();
    }
  });

  it("surfaces environment meta notes without importing goal findings", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-environment-note",
        title: "Goal environment note",
        closeConditions: [
          {
            id: "review-consensus",
            kind: "review_consensus",
            required: true,
          },
        ],
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "approved",
        nonBlockingComments: [
          "No command logs were present, so I could not verify tests ran.",
        ],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-environment-note",
        proposal,
        processResult: {
          runId: "run-review",
          previousStatus: "needs_review",
          newStatus: "approved",
          reviewer: "codex-review",
          reviewedAt: "2026-05-26T00:03:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });

      expect(imported.reviewAdvisories).toEqual([
        {
          source: "non_blocking_comment",
          index: 0,
          category: "test-execution-unverified",
          text: "No command logs were present, so I could not verify tests ran.",
        },
      ]);
      expect(imported.findings).toHaveLength(0);
      expect(imported.cycle.findingsSeen).toBe(0);
      expect(imported.cycle.summary).toMatch(/reviewer advisory/);
      expect(goals.listFindings({ hitchId: "goal-environment-note" })).toEqual(
        [],
      );
      expect(proposal.nonBlockingComments).toEqual([
        "No command logs were present, so I could not verify tests ran.",
      ]);
      expect(imported.closeChecks[0]?.message).toMatch(/static pass/);
      expect(imported.closeChecks[0]?.message).toMatch(/tests not executed/);
      expect(imported.closeChecks[0]?.evidence).toMatchObject({
        reviewConsensusSemantics: {
          approvalKind: "static_review",
          testsExecutedByConsensus: false,
        },
        reviewerAdvisories: [
          {
            source: "non_blocking_comment",
            index: 0,
            category: "test-execution-unverified",
            text: "No command logs were present, so I could not verify tests ran.",
          },
        ],
      });
      expect(imported.convergenceDecision.decision).toBe("close_ready");
      expect(imported.hitchStatus?.status).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("keeps real required changes blocking when an environment meta note is present", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-required-with-environment-note",
        title: "Goal required with environment note",
        scope: {
          targetSummary: "review integration",
        },
        closeConditions: [
          {
            id: "review-consensus",
            kind: "review_consensus",
            required: true,
          },
        ],
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "changes_requested",
        requiredChanges: ["Review integration must preserve required changes."],
        nonBlockingComments: ["Tests were not run in this environment."],
      });
      insertReviewDecision(db, {
        decision: "changes_requested",
        requiredChanges: ["Review integration must preserve required changes."],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-required-with-environment-note",
        proposal,
        processResult: {
          runId: "run-review",
          previousStatus: "needs_review",
          newStatus: "changes_requested",
          reviewer: "codex-review",
          reviewedAt: "2026-05-26T00:04:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });

      expect(imported.findings).toHaveLength(1);
      expect(imported.cycle.findingsSeen).toBe(1);
      expect(imported.findings[0].finding).toMatchObject({
        severity: "P1",
        category: "review-required-change",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
      });
      expect(imported.convergenceDecision.decision).toBe("needs_fix");
      expect(imported.hitchStatus).toBeNull();
      expect(
        goals.requireSession("goal-required-with-environment-note").status,
      ).toBe("open");
    } finally {
      db.close();
    }
  });

  it("does not count retained paraphrase duplicates as new review findings", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-paraphrase-duplicate",
        title: "Goal paraphrase duplicate",
        scope: {
          allowedFindingCategories: ["review-required-change"],
        },
        createdBy: "test",
        createdSource: "cli",
      });
      const first = createProposal(proposals, {
        decision: "changes_requested",
        requiredChanges: [
          "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle",
        ],
      });
      importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-paraphrase-duplicate",
        proposal: first,
        createdBy: "test",
      });

      const second = createProposal(proposals, {
        decision: "changes_requested",
        requiredChanges: [
          "Review import uses only summary text for finding identity; paraphrased reviewer findings create new findings each cycle",
        ],
      });
      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-paraphrase-duplicate",
        proposal: second,
        createdBy: "test",
      });

      expect(imported.findings).toHaveLength(1);
      expect(imported.findings[0]).toMatchObject({
        created: true,
        finding: {
          scopeStatus: "duplicate",
          lifecycleStatus: "duplicate",
        },
      });
      expect(imported.cycle.findingsSeen).toBe(1);
      expect(imported.cycle.findingsNew).toBe(0);
    } finally {
      db.close();
    }
  });

  it("suppresses command-evidence non-blocking advisories across cycles", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-command-evidence-note",
        title: "Goal command evidence note",
        createdBy: "test",
        createdSource: "cli",
      });

      const first = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-command-evidence-note",
        proposal: createProposal(proposals, {
          decision: "approved",
          nonBlockingComments: [
            "No commands directory was present, so test execution is evidenced only by the run summary.",
          ],
        }),
        createdBy: "test",
      });
      const second = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-command-evidence-note",
        proposal: createProposal(proposals, {
          decision: "approved",
          nonBlockingComments: [
            "The commands dir is absent, so the test run evidence is limited to the run summary.",
          ],
        }),
        createdBy: "test",
      });

      expect(first.reviewAdvisories).toHaveLength(1);
      expect(second.reviewAdvisories).toHaveLength(1);
      expect(first.findings).toHaveLength(0);
      expect(second.findings).toHaveLength(0);
      expect(second.cycle.findingsSeen).toBe(0);
      expect(second.cycle.findingsNew).toBe(0);
      expect(goals.listFindings({ hitchId: "goal-command-evidence-note" }))
        .toEqual([]);
    } finally {
      db.close();
    }
  });

  it("suppresses successful command/test non-blocking advisories", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-successful-command-note",
        title: "Goal successful command note",
        createdBy: "test",
        createdSource: "cli",
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-successful-command-note",
        proposal: createProposal(proposals, {
          decision: "approved",
          nonBlockingComments: [
            "Command logs show npm run typecheck and npx vitest run completed successfully.",
            "typecheck passed and vitest passed.",
            "typecheck passed with no errors.",
            "vitest passed with no failures.",
          ],
        }),
        createdBy: "test",
      });

      expect(imported.reviewAdvisories).toHaveLength(4);
      expect(imported.findings).toHaveLength(0);
      expect(imported.cycle.findingsSeen).toBe(0);
      expect(imported.cycle.findingsNew).toBe(0);
      expect(imported.convergenceDecision.decision).not.toBe(
        "needs_classification",
      );
      expect(goals.listFindings({ hitchId: "goal-successful-command-note" }))
        .toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps command evidence defects as non-blocking findings", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-command-evidence-defect",
        title: "Goal command evidence defect",
        createdBy: "test",
        createdSource: "cli",
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-command-evidence-defect",
        proposal: createProposal(proposals, {
          decision: "approved",
          nonBlockingComments: [
            "The commands array is unverified and can omit required validation.",
          ],
        }),
        createdBy: "test",
      });

      expect(imported.reviewAdvisories).toEqual([]);
      expect(imported.findings).toHaveLength(1);
      expect(imported.findings[0].finding).toMatchObject({
        category: "review-non-blocking-comment",
        severity: "P2",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
      });
      expect(imported.convergenceDecision.decision).not.toBe(
        "needs_classification",
      );
      expect(imported.convergenceDecision.decision).not.toBe("escalate");
    } finally {
      db.close();
    }
  });

  it("never suppresses required changes that match command-evidence advisory text", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-command-evidence-required",
        title: "Goal command evidence required",
        scope: {
          allowedFindingCategories: ["review-required-change"],
        },
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "changes_requested",
        requiredChanges: [
          "No commands directory was present, so test execution is evidenced only by the run summary.",
        ],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-command-evidence-required",
        proposal,
        createdBy: "test",
      });

      expect(imported.reviewAdvisories).toEqual([]);
      expect(imported.findings).toHaveLength(1);
      expect(imported.cycle.findingsSeen).toBe(1);
      expect(imported.cycle.findingsNew).toBe(1);
      expect(imported.findings[0].finding).toMatchObject({
        category: "review-required-change",
        severity: "P1",
        lifecycleStatus: "open",
        summary:
          "No commands directory was present, so test execution is evidenced only by the run summary.",
      });
    } finally {
      db.close();
    }
  });

  it("never suppresses required changes that match successful command advisory text", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-successful-command-required",
        title: "Goal successful command required",
        scope: {
          allowedFindingCategories: ["review-required-change"],
        },
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "changes_requested",
        requiredChanges: [
          "Command logs show npm run typecheck and npx vitest run completed successfully.",
        ],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-successful-command-required",
        proposal,
        createdBy: "test",
      });

      expect(imported.reviewAdvisories).toEqual([]);
      expect(imported.findings).toHaveLength(1);
      expect(imported.findings[0].finding).toMatchObject({
        category: "review-required-change",
        severity: "P1",
        lifecycleStatus: "open",
        summary:
          "Command logs show npm run typecheck and npx vitest run completed successfully.",
      });
    } finally {
      db.close();
    }
  });

  it.each([
    "typecheck passed, but vitest failed.",
    "Tests were not run because vitest failed.",
    "No commands directory was present; no tests passed.",
    "No tests passed.",
    "vitest failed.",
    "2 failures were reported by vitest.",
  ])("imports mixed success/failure test notes as findings: %s", (comment) => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-mixed-command-failure",
        title: "Goal mixed command failure",
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "approved",
        nonBlockingComments: [comment],
      });

      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId: "goal-mixed-command-failure",
        proposal,
        createdBy: "test",
      });

      expect(imported.reviewAdvisories).toEqual([]);
      expect(imported.findings).toHaveLength(1);
      expect(imported.findings[0].finding).toMatchObject({
        category: "review-non-blocking-comment",
        severity: "P2",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
        summary: comment,
      });
    } finally {
      db.close();
    }
  });

  it("records operation and run ids on rerun goal attempts", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-rerun",
        title: "Goal rerun",
        createdBy: "test",
        createdSource: "cli",
      });
      const parent = recordHitchAttemptForOperationResult(db, {
        hitchId: "goal-rerun",
        attemptType: "implement",
        operationId: "op-parent",
        runId: "run-parent",
        runStatus: "needs_review",
      });
      const child = recordHitchAttemptForOperationResult(db, {
        hitchId: "goal-rerun",
        attemptType: "rerun",
        operationId: "op-rerun",
        runId: "run-child",
        runStatus: "needs_review",
        parentAttemptId: parent.attemptId,
      });

      expect(child).toMatchObject({
        hitchId: "goal-rerun",
        attemptType: "rerun",
        operationId: "op-rerun",
        runId: "run-child",
        parentAttemptId: parent.attemptId,
        status: "succeeded",
      });
      expect(latestHitchAttemptForRun(db, "goal-rerun", "run-child")?.attemptId).toBe(
        child.attemptId,
      );
    } finally {
      db.close();
    }
  });

  it("keeps review-only attempts in the related coding iteration", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        hitchId: "goal-review-attempt",
        title: "Goal review attempt",
        maxIterations: 1,
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "cli",
      });
      goals.recordCloseCheck({
        hitchId: "goal-review-attempt",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
      const runAttempt = recordHitchAttemptForOperationResult(db, {
        hitchId: "goal-review-attempt",
        attemptType: "implement",
        operationId: "op-run",
        runId: "run-review-attempt",
        runStatus: "needs_review",
      });
      const reviewAttempt = recordHitchAttemptForOperationResult(db, {
        hitchId: "goal-review-attempt",
        attemptType: "fix-review",
        operationId: "op-review",
        runId: "run-review-attempt",
        iteration: runAttempt.iteration,
        parentAttemptId: runAttempt.attemptId,
        runStatus: "approved",
      });
      goals.recordCloseCheck({
        hitchId: "goal-review-attempt",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });

      expect(reviewAttempt.iteration).toBe(runAttempt.iteration);
      expect(
        new ConvergenceService(goals).evaluate("goal-review-attempt").decision,
      ).toBe("close_ready");
    } finally {
      db.close();
    }
  });
});

describe("#278: later approve auto-resolves superseded review blockers", () => {
  function createSessionForAutoResolve(goals: HitchRepository, hitchId: string) {
    goals.createSession({
      hitchId,
      title: "Goal autoresolve",
      // review-blocking categories classify in_scope so the openInScopeP1 close
      // gate engages (mirrors the orchestrate review loop's in-scope P1 blockers).
      scope: {
        allowedFindingCategories: [
          "review-required-change",
          "review-negative-decision",
          "correctness",
        ],
      },
      closeConditions: [
        {
          id: "review-consensus",
          kind: "review_consensus",
          required: true,
        },
      ],
      createdBy: "test",
      createdSource: "cli",
    });
  }

  // (A) HAPPY PATH + (B) AUDIT: a later approving cycle auto-resolves the prior
  // changes_requested cycle's open in-scope P1 review-required-change finding,
  // and convergence stops routing needs_fix on openInScopeP1.
  it("auto-resolves a prior cycle review-required-change on approve and clears the openInScopeP1 close gate", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-happy";
      createSessionForAutoResolve(goals, hitchId);
      // An implementation attempt exists (close gate requires iterationsUsed>0).
      // Its runId is the hitch's current review target; the approve below reviews
      // this same run (satisfies the current-review-target guard).
      goals.createAttempt({
        hitchId,
        attemptType: "implement",
        status: "succeeded",
        runId: "run-review",
      });

      // Cycle 1: changes_requested with a required change -> open P1 blocker.
      const cr = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "changes_requested",
        requiredChanges: ["Fix the convergence gate ordering"],
      });
      const cycle1 = importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: cr,
        createdBy: "test",
      });
      const blocker = goals
        .listFindings({ hitchId, scopeStatus: "in_scope", severity: "P1" })
        .find((f) => f.category === "review-required-change");
      expect(blocker).toBeDefined();
      expect(blocker?.lifecycleStatus).toBe("open");
      expect(blocker?.sourceCycleId).toBe(cycle1.cycle.cycleId);
      expect(
        new ConvergenceService(goals).evaluate(hitchId).metrics.openInScopeP1,
      ).toBe(1);
      expect(new ConvergenceService(goals).evaluate(hitchId).decision).toBe(
        "needs_fix",
      );

      // Cycle 2: a fresh review of the latest run APPROVES (canonical decision
      // approved via DB review_decisions, processed into an approved result so the
      // review_consensus close check passes). The prior blocker is superseded.
      insertReviewDecision(db, { decision: "approved" });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const cycle2 = importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        processResult: {
          runId: "run-review",
          previousStatus: "needs_review",
          newStatus: "approved",
          reviewer: "consensus",
          reviewedAt: "2026-05-26T00:01:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });

      // (A) the prior blocker is now lifecycle 'fixed'.
      const resolved = goals.requireFinding(blocker!.findingId);
      expect(resolved.lifecycleStatus).toBe("fixed");
      expect(resolved.fixedAt).not.toBeNull();
      // (B) AUDIT: deterministic resolution_note records the superseding run.
      expect(resolved.resolutionNote).toContain("auto-resolved");
      expect(resolved.resolutionNote).toContain(cycle2.cycle.cycleId);

      // (A) convergence no longer routes needs_fix / diverging / budget_exhausted
      // on the (now retired) openInScopeP1 blocker; close gate is clear.
      const conv = new ConvergenceService(goals).evaluate(hitchId);
      expect(conv.metrics.openInScopeP1).toBe(0);
      expect(conv.decision).not.toBe("needs_fix");
      expect(conv.decision).not.toBe("diverging");
      expect(conv.decision).not.toBe("budget_exhausted");
      // approving cycle recorded a passed review_consensus close check, so the
      // hitch is close_ready.
      expect(conv.decision).toBe("close_ready");

      // (B) AUDIT: the approving cycle's findingsFixed/findingsInScopeOpen counts
      // reflect the resolution (computed AFTER auto-resolve, before completeCycle).
      expect(cycle2.cycle.findingsFixed).toBe(1);
      expect(cycle2.cycle.findingsInScopeOpen).toBe(0);
      expect(cycle2.autoResolvedFindings).toBeDefined();
      expect(cycle2.autoResolvedFindings?.map((f) => f.findingId)).toEqual([
        blocker!.findingId,
      ]);
    } finally {
      db.close();
    }
  });

  // (A') DB-CANONICAL trigger (no processResult): the approve trigger is the
  // persisted review_decisions row, NOT an LLM self-report. Auto-resolve fires off
  // the same harness-computed `canonical.decision === "approved"` signal that
  // drives suppressBlockingFindings, whether sourced from processResult.newStatus
  // (harness review-processor verdict) or the DB review_decisions row.
  it("auto-resolves off the persisted review_decisions approve (no processResult)", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-dbcanonical";
      createSessionForAutoResolve(goals, hitchId);
      goals.createAttempt({
        hitchId,
        attemptType: "implement",
        status: "succeeded",
        runId: "run-review",
      });

      const cr = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "changes_requested",
        requiredChanges: ["Earlier blocker to be superseded"],
      });
      importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: cr,
        createdBy: "test",
      });
      const blocker = goals
        .listFindings({ hitchId, scopeStatus: "in_scope", severity: "P1" })
        .find((f) => f.category === "review-required-change");
      expect(blocker?.lifecycleStatus).toBe("open");

      // The persisted DB canonical decision is the approve trigger.
      insertReviewDecision(db, { decision: "approved" });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const cycle2 = importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        createdBy: "test",
      });

      expect(goals.requireFinding(blocker!.findingId).lifecycleStatus).toBe(
        "fixed",
      );
      expect(cycle2.autoResolvedFindings?.map((f) => f.findingId)).toEqual([
        blocker!.findingId,
      ]);
    } finally {
      db.close();
    }
  });

  // (G2) FAIL-CLOSED INVARIANT: an approved processResult whose runId does NOT
  // match the proposal's runId must NOT auto-resolve prior blockers (the result
  // must belong to the proposal's run).
  it("does NOT auto-resolve when processResult.runId mismatches the proposal runId", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-runmismatch";
      createSessionForAutoResolve(goals, hitchId);
      // A second, unrelated run exists.
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at, meta_json)
         VALUES ('run-other', 'repo', 'apps/web', 'domain-coding', 'main',
           'needs_review', 'db-first', 1, 'disabled',
           '2026-05-26T00:00:00.000Z', '{}')`,
      ).run();

      const cr = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "changes_requested",
        requiredChanges: ["Earlier blocker"],
      });
      importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: cr,
        createdBy: "test",
      });
      const blocker = goals
        .listFindings({ hitchId, scopeStatus: "in_scope", severity: "P1" })
        .find((f) => f.category === "review-required-change");
      expect(blocker?.lifecycleStatus).toBe("open");

      // The proposal is on run-review, but the processResult claims an approve for
      // an UNRELATED run (run-other). The fail-closed invariant must skip auto-resolve.
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        processResult: {
          runId: "run-other",
          previousStatus: "needs_review",
          newStatus: "approved",
          reviewer: "consensus",
          reviewedAt: "2026-05-26T00:01:00.000Z",
          warnings: [],
        },
        createdBy: "test",
      });
      expect(imported.autoResolvedFindings).toBeUndefined();
      expect(goals.requireFinding(blocker!.findingId).lifecycleStatus).toBe(
        "open",
      );
    } finally {
      db.close();
    }
  });

  // (G3) CURRENT-REVIEW-TARGET INVARIANT: a stale/non-current run's approve must
  // NOT auto-resolve blockers raised against a DIFFERENT, NEWER run. The hitch's
  // current target is its latest coding run; an approve for an OLDER run is skipped
  // (fail-closed). Mirrors the MCP review.process path accepting any linked
  // needs_review run.
  it("does NOT auto-resolve when the approving run is NOT the hitch's current review target (stale run)", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-staletarget";
      createSessionForAutoResolve(goals, hitchId);
      // The hitch's CURRENT review target is a newer coding run (run-new).
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at, meta_json)
         VALUES ('run-new', 'repo', 'apps/web', 'domain-coding', 'main',
           'needs_review', 'db-first', 1, 'disabled',
           '2026-05-26T00:05:00.000Z', '{}')`,
      ).run();
      // run-review is the OLDER coding run; run-new is the LATEST (current target).
      goals.createAttempt({
        hitchId,
        attemptType: "implement",
        status: "succeeded",
        runId: "run-review",
        iteration: 1,
      });
      goals.createAttempt({
        hitchId,
        attemptType: "rerun",
        status: "succeeded",
        runId: "run-new",
        iteration: 2,
      });

      // cycle1: a blocker raised reviewing the OLD run (run-review).
      const cr = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "changes_requested",
        requiredChanges: ["Old-run blocker that a stale approve must not retire"],
      });
      importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: cr,
        createdBy: "test",
      });
      const blocker = goals
        .listFindings({ hitchId, scopeStatus: "in_scope", severity: "P1" })
        .find((f) => f.category === "review-required-change");
      expect(blocker?.lifecycleStatus).toBe("open");

      // A STALE approve is processed for the OLD run (run-review), which is no
      // longer the hitch's current review target (run-new is). It must NOT retire
      // the blocker.
      insertReviewDecision(db, { decision: "approved" });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        createdBy: "test",
      });
      expect(imported.autoResolvedFindings).toBeUndefined();
      expect(goals.requireFinding(blocker!.findingId).lifecycleStatus).toBe(
        "open",
      );
    } finally {
      db.close();
    }
  });

  // (C) NEGATIVE / FAIL-CLOSED: a genuine operator (human) in-scope P1 finding is
  // NOT auto-resolved by an approving review cycle.
  it("does NOT auto-resolve a human-origin operator P1 finding", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-human";
      createSessionForAutoResolve(goals, hitchId);
      const human = goals.upsertFinding({
        hitchId,
        source: "human",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "Operator-found blocker that the approve must not silence",
      }).finding;
      expect(human.lifecycleStatus).toBe("open");

      insertReviewDecision(db, { decision: "approved" });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        createdBy: "test",
      });

      expect(goals.requireFinding(human.findingId).lifecycleStatus).toBe("open");
    } finally {
      db.close();
    }
  });

  // (D) NEGATIVE: an out_of_scope review finding is NOT auto-resolved.
  it("does NOT auto-resolve an out_of_scope review finding", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-oos";
      createSessionForAutoResolve(goals, hitchId);
      const oos = goals.upsertFinding({
        hitchId,
        source: "review",
        severity: "P1",
        category: "review-required-change",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
        summary: "An out-of-scope review item",
      }).finding;
      expect(oos.scopeStatus).toBe("out_of_scope");

      insertReviewDecision(db, { decision: "approved" });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        createdBy: "test",
      });

      const after = goals.requireFinding(oos.findingId);
      expect(after.lifecycleStatus).toBe("out_of_scope");
    } finally {
      db.close();
    }
  });

  // (E) NEGATIVE: a non-blocking review category (P2 comment) is NOT auto-resolved.
  it("does NOT auto-resolve a non-blocking review-non-blocking-comment finding", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-nonblocking";
      createSessionForAutoResolve(goals, hitchId);
      const comment = goals.upsertFinding({
        hitchId,
        source: "review",
        severity: "P2",
        category: "review-non-blocking-comment",
        scopeStatus: "in_scope",
        summary: "A non-blocking advisory comment",
      }).finding;
      expect(comment.lifecycleStatus).toBe("open");

      insertReviewDecision(db, { decision: "approved" });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        createdBy: "test",
      });

      expect(goals.requireFinding(comment.findingId).lifecycleStatus).toBe(
        "open",
      );
    } finally {
      db.close();
    }
  });

  // (F) NEGATIVE / SAME-CYCLE GUARD: a blocker stamped with the approving cycle's
  // OWN cycle id is never auto-resolved by that same cycle.
  it("does NOT auto-resolve a finding stamped with the superseding cycle id", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-samecycle";
      createSessionForAutoResolve(goals, hitchId);

      insertReviewDecision(db, { decision: "approved" });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      const imported = importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        createdBy: "test",
      });

      // Stamp a blocker with the just-completed (superseding) cycle id and re-run
      // a second approve cycle: the first cycle's own row must NOT be resolved by
      // the cycle that created it (the same-cycle guard).
      const sameCycleBlocker = goals.upsertFinding({
        hitchId,
        source: "review",
        sourceCycleId: imported.cycle.cycleId,
        severity: "P1",
        category: "review-required-change",
        scopeStatus: "in_scope",
        summary: "Blocker stamped with the current cycle id",
      }).finding;

      // Auto-resolve is gated on canonical approve, so directly exercise the
      // repo method with the SAME cycle id it was stamped with.
      const resolvedSame = goals.resolveSupersededReviewFindings({
        hitchId,
        supersedingCycleId: imported.cycle.cycleId,
        categories: ["review-required-change", "review-negative-decision"],
        decisionRunId: "run-review",
      });
      expect(resolvedSame).toEqual([]);
      expect(
        goals.requireFinding(sameCycleBlocker.findingId).lifecycleStatus,
      ).toBe("open");
    } finally {
      db.close();
    }
  });

  // (G) FAIL-CLOSED: when the canonical decision is NOT approved, prior open
  // review blockers stay open (no auto-resolution on non-approve).
  it("does NOT auto-resolve when the canonical decision is changes_requested", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-nonapprove";
      createSessionForAutoResolve(goals, hitchId);

      const cr1 = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "changes_requested",
        requiredChanges: ["First blocker"],
      });
      const cycle1 = importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: cr1,
        createdBy: "test",
      });
      const blocker = goals
        .listFindings({ hitchId, scopeStatus: "in_scope", severity: "P1" })
        .find((f) => f.category === "review-required-change");
      expect(blocker?.lifecycleStatus).toBe("open");
      expect(blocker?.sourceCycleId).toBe(cycle1.cycle.cycleId);

      // Cycle 2: STILL changes_requested (different blocker). No auto-resolve.
      const cr2 = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "changes_requested",
        requiredChanges: ["Second blocker"],
      });
      const cycle2 = importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: cr2,
        createdBy: "test",
      });
      expect(cycle2.autoResolvedFindings).toBeUndefined();
      expect(goals.requireFinding(blocker!.findingId).lifecycleStatus).toBe(
        "open",
      );
    } finally {
      db.close();
    }
  });

  // (H) NEGATIVE: a blocker from a DIFFERENT hitch is never touched.
  it("does NOT auto-resolve a review blocker belonging to a different hitch", () => {
    const { db, goals, proposals } = fresh();
    try {
      const hitchId = "goal-278-thishitch";
      const otherHitchId = "goal-278-otherhitch";
      createSessionForAutoResolve(goals, hitchId);
      createSessionForAutoResolve(goals, otherHitchId);
      const otherBlocker = goals.upsertFinding({
        hitchId: otherHitchId,
        source: "review",
        severity: "P1",
        category: "review-required-change",
        scopeStatus: "in_scope",
        summary: "Blocker on a different hitch",
      }).finding;

      insertReviewDecision(db, { decision: "approved" });
      const approved = createProposal(proposals, {
        reviewer: "reviewer-a",
        decision: "approved",
      });
      importReviewProposalToHitch({
        repository: goals,
        hitchId,
        proposal: approved,
        createdBy: "test",
      });

      expect(
        goals.requireFinding(otherBlocker.findingId).lifecycleStatus,
      ).toBe("open");
    } finally {
      db.close();
    }
  });
});
