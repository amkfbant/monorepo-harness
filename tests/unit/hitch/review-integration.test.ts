import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewProposalRepository } from "../../../src/db/repositories/review-proposals.js";
import {
  latestHitchAttemptForRun,
  recordHitchAttemptForOperationResult,
} from "../../../src/hitch/operation-integration.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { importReviewProposalToHitch } from "../../../src/hitch/review-integration.js";

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
     VALUES ('run-review', 'repo', 'apps/web', 'domain-coding', 'main',
       'needs_review', 'db-first', 1, 'disabled',
       '2026-05-26T00:00:00.000Z', '{}')`,
  ).run();
  return {
    db,
    goals: new HitchRepository(db),
    proposals: new ReviewProposalRepository(db),
  };
}

function createProposal(
  proposals: ReviewProposalRepository,
  input: {
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
    runId: "run-review",
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
    decision: "approved" | "changes_requested" | "rejected";
    reviewedAt?: string;
  },
): void {
  const sourceYaml = [
    "decision: " + input.decision,
    "required_changes: []",
    "non_blocking_comments: []",
    "out_of_scope_suggestions: []",
    "",
  ].join("\n");
  db.prepare(
    `INSERT INTO review_decisions (run_id, decision, reviewer, summary,
       reviewed_at, source_yaml, source_sha256)
     VALUES ('run-review', ?, 'consensus', 'aggregate decision', ?, ?, ?)`,
  ).run(
    input.decision,
    input.reviewedAt ?? "2026-05-26T00:01:00.000Z",
    sourceYaml,
    createHash("sha256").update(sourceYaml).digest("hex"),
  );
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
