import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewProposalRepository } from "../../../src/db/repositories/review-proposals.js";
import {
  latestGoalAttemptForRun,
  recordGoalAttemptForOperationResult,
} from "../../../src/goal/operation-integration.js";
import { ConvergenceService } from "../../../src/goal/convergence.js";
import { GoalRepository } from "../../../src/goal/repository.js";
import { importReviewProposalToGoal } from "../../../src/goal/review-integration.js";

function fresh(): {
  db: ReturnType<typeof openDb>;
  goals: GoalRepository;
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
    goals: new GoalRepository(db),
    proposals: new ReviewProposalRepository(db),
  };
}

function createProposal(
  proposals: ReviewProposalRepository,
  input: {
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
    reviewer: "codex-review",
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

describe("goal review integration", () => {
  it("imports review proposal findings into a completed review cycle", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        goalId: "goal-review",
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

      const imported = importReviewProposalToGoal({
        repository: goals,
        goalId: "goal-review",
        proposal,
        createdBy: "test",
      });

      expect(imported.cycle.findingsSeen).toBe(3);
      expect(imported.cycle.findingsNew).toBe(3);
      expect(imported.convergenceDecision.cycleId).toBe(imported.cycle.cycleId);
      const findings = goals.listFindings({ goalId: "goal-review" });
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
        goalId: "goal-close-review",
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

      const imported = importReviewProposalToGoal({
        repository: goals,
        goalId: "goal-close-review",
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
      expect(imported.goalStatus?.status).toBe("close_ready");
      expect(goals.requireSession("goal-close-review").status).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("syncs goal status when review import detects divergence", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        goalId: "goal-review-diverging",
        title: "Goal review diverging",
        maxTotalNewFindings: 0,
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "changes_requested",
        requiredChanges: ["New blocker exceeds the finding budget"],
      });

      const imported = importReviewProposalToGoal({
        repository: goals,
        goalId: "goal-review-diverging",
        proposal,
        createdBy: "test",
      });

      expect(imported.convergenceDecision.decision).toBe("diverging");
      expect(imported.goalStatus?.status).toBe("diverging");
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
        goalId: "goal-review-budget",
        title: "Goal review budget",
        maxReviewCycles: 0,
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, { decision: "approved" });

      const imported = importReviewProposalToGoal({
        repository: goals,
        goalId: "goal-review-budget",
        proposal,
        createdBy: "test",
      });

      expect(imported.convergenceDecision.decision).toBe("budget_exhausted");
      expect(imported.goalStatus?.status).toBe("budget_exhausted");
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
        goalId: "goal-empty-negative-review",
        title: "Goal empty negative review",
        createdBy: "test",
        createdSource: "cli",
      });
      const proposal = createProposal(proposals, {
        decision: "rejected",
        requiredChanges: [],
      });

      const imported = importReviewProposalToGoal({
        repository: goals,
        goalId: "goal-empty-negative-review",
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
        goalId: "goal-environment-note",
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
        nonBlockingComments: ["Tests were not run in this environment."],
      });

      const imported = importReviewProposalToGoal({
        repository: goals,
        goalId: "goal-environment-note",
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

      expect(imported.findings).toHaveLength(0);
      expect(imported.cycle.findingsSeen).toBe(0);
      expect(goals.listFindings({ goalId: "goal-environment-note" })).toEqual(
        [],
      );
      expect(proposal.nonBlockingComments).toEqual([
        "Tests were not run in this environment.",
      ]);
      expect(imported.convergenceDecision.decision).toBe("close_ready");
      expect(imported.goalStatus?.status).toBe("close_ready");
    } finally {
      db.close();
    }
  });

  it("keeps real required changes blocking when an environment meta note is present", () => {
    const { db, goals, proposals } = fresh();
    try {
      goals.createSession({
        goalId: "goal-required-with-environment-note",
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

      const imported = importReviewProposalToGoal({
        repository: goals,
        goalId: "goal-required-with-environment-note",
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
      expect(imported.goalStatus).toBeNull();
      expect(
        goals.requireSession("goal-required-with-environment-note").status,
      ).toBe("open");
    } finally {
      db.close();
    }
  });

  it("records operation and run ids on rerun goal attempts", () => {
    const { db, goals } = fresh();
    try {
      goals.createSession({
        goalId: "goal-rerun",
        title: "Goal rerun",
        createdBy: "test",
        createdSource: "cli",
      });
      const parent = recordGoalAttemptForOperationResult(db, {
        goalId: "goal-rerun",
        attemptType: "implement",
        operationId: "op-parent",
        runId: "run-parent",
        runStatus: "needs_review",
      });
      const child = recordGoalAttemptForOperationResult(db, {
        goalId: "goal-rerun",
        attemptType: "rerun",
        operationId: "op-rerun",
        runId: "run-child",
        runStatus: "needs_review",
        parentAttemptId: parent.attemptId,
      });

      expect(child).toMatchObject({
        goalId: "goal-rerun",
        attemptType: "rerun",
        operationId: "op-rerun",
        runId: "run-child",
        parentAttemptId: parent.attemptId,
        status: "succeeded",
      });
      expect(latestGoalAttemptForRun(db, "goal-rerun", "run-child")?.attemptId).toBe(
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
        goalId: "goal-review-attempt",
        title: "Goal review attempt",
        maxIterations: 1,
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "cli",
      });
      goals.recordCloseCheck({
        goalId: "goal-review-attempt",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
      const runAttempt = recordGoalAttemptForOperationResult(db, {
        goalId: "goal-review-attempt",
        attemptType: "implement",
        operationId: "op-run",
        runId: "run-review-attempt",
        runStatus: "needs_review",
      });
      const reviewAttempt = recordGoalAttemptForOperationResult(db, {
        goalId: "goal-review-attempt",
        attemptType: "fix-review",
        operationId: "op-review",
        runId: "run-review-attempt",
        iteration: runAttempt.iteration,
        parentAttemptId: runAttempt.attemptId,
        runStatus: "approved",
      });
      goals.recordCloseCheck({
        goalId: "goal-review-attempt",
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
