import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  canAutoFixFinding,
  classifyFindingForGoal,
  isEnvironmentMetaNote,
  isTestNotRunAdvisory,
} from "../../../src/goal/classification.js";
import { ConvergenceService } from "../../../src/goal/convergence.js";
import { GoalRepository } from "../../../src/goal/repository.js";
import { DEFAULT_GOAL_POLICY, type GoalSession } from "../../../src/goal/types.js";

function session(): GoalSession {
  return {
    goalId: "goal-classify",
    title: "Fix MCP confirmation safety",
    description: null,
    projectId: "monorepo-harness",
    repoId: null,
    domain: "mcp",
    backlogItemId: null,
    status: "open",
    scope: {
      targetFiles: ["src/mcp/**", "docs/specs/mcp.md"],
      targetOperations: ["operation-audit"],
      allowedFindingCategories: ["correctness", "security", "test-failure"],
      excludedCategories: ["future-feature", "unrelated-refactor"],
      targetSummary: "MCP confirmation safety",
    },
    closeConditions: [],
    policy: DEFAULT_GOAL_POLICY,
    maxIterations: 3,
    maxReviewCycles: 3,
    maxReruns: 2,
    maxTotalNewFindings: 12,
    currentIteration: 0,
    currentReviewCycle: 0,
    createdBy: "test",
    createdSource: "cli",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    closedAt: null,
    closeSummary: null,
    escalationReason: null,
  };
}

function freshRepo(): { db: ReturnType<typeof openDb>; repo: GoalRepository } {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-classify-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, repo: new GoalRepository(db) };
}

describe("goal finding classification", () => {
  it("detects reviewer environment meta notes deterministically", () => {
    expect(
      isEnvironmentMetaNote("Tests were not run in this environment."),
    ).toBe(true);
    expect(
      isEnvironmentMetaNote("I could not run the tests in this sandbox."),
    ).toBe(true);
    expect(isEnvironmentMetaNote("No tests were run locally.")).toBe(true);
  });

  it("does not treat real test findings as environment meta notes", () => {
    expect(
      isEnvironmentMetaNote("Add regression tests for the review integration."),
    ).toBe(false);
    expect(
      isEnvironmentMetaNote("The test suite fails in CI after this change."),
    ).toBe(false);
  });

  it("does not auto-dismiss required changes that look like environment notes", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "review",
      severity: "P1",
      category: "review-required-change",
      summary: "Tests were not run in this environment.",
    });
    expect(classified.scopeStatus).toBe("unknown");
  });

  it("classifies file paths inside targetFiles as in scope", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "review",
      severity: "P1",
      category: "docs",
      summary: "MCP confirmation wording is stale",
      filePath: "docs/specs/mcp.md",
    });
    expect(classified.scopeStatus).toBe("in_scope");
    expect(classified.reason).toMatch(/targetFiles/);
  });

  it("keeps target-file cleanup findings in scope", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "review",
      severity: "P1",
      category: "correctness",
      summary: "Cleanup MCP confirmation retry handling",
      filePath: "src/mcp/server.ts",
    });
    expect(classified.scopeStatus).toBe("in_scope");
    expect(classified.reason).toMatch(/targetFiles/);
  });

  it("keeps allowed-category refactor findings in scope", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "review",
      severity: "P1",
      category: "security",
      summary: "Refactor confirmation token validation",
    });
    expect(classified.scopeStatus).toBe("in_scope");
    expect(classified.reason).toMatch(/category/);
  });

  it("classifies file paths outside targetFiles as out of scope", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "review",
      severity: "P2",
      category: "correctness",
      summary: "Dashboard refresh can flicker",
      filePath: "src/dashboard/view.ts",
    });
    expect(classified.scopeStatus).toBe("out_of_scope");
    expect(classified.reason).toMatch(/outside/);
  });

  it("classifies excluded categories as out of scope", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "review",
      severity: "P3",
      category: "future-feature",
      summary: "Add dashboard controls",
    });
    expect(classified.scopeStatus).toBe("out_of_scope");
  });

  it("classifies close-check failures as in scope", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "close_check_failure",
      severity: "P1",
      category: "validation",
      summary: "typecheck failed",
      sourceRef: "close-check:typecheck",
    });
    expect(classified.scopeStatus).toBe("in_scope");
    expect(classified.reason).toMatch(/close-check/);
  });

  it("keeps ambiguous findings unknown", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "human",
      severity: "P2",
      category: "quality",
      summary: "Improve launch handoff",
    });
    expect(classified.scopeStatus).toBe("unknown");
  });

  it("does not classify generic goal-title words as in scope", () => {
    const classified = classifyFindingForGoal(session(), {
      source: "review",
      severity: "P2",
      category: "quality",
      summary: "Fix launch handoff typo",
    });
    expect(classified.scopeStatus).toBe("unknown");
  });

  it("allows manual classification to override heuristic scope", () => {
    const { db, repo } = freshRepo();
    try {
      const goal = repo.createSession({
        goalId: "goal-classify",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        scope: session().scope,
        createdBy: "test",
        createdSource: "cli",
      });
      const finding = repo.upsertFinding({
        goalId: goal.goalId,
        source: "review",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary: "Dashboard refresh can flicker",
        filePath: "src/dashboard/view.ts",
      }).finding;

      const manual = repo.classifyFinding({
        findingId: finding.findingId,
        scopeStatus: "in_scope",
        reason: "manual owner decision: required for current MCP release",
      });
      expect(manual.scopeStatus).toBe("in_scope");
      expect(manual.lifecycleStatus).toBe("open");
      expect(manual.classificationReason).toMatch(/manual owner/);
    } finally {
      db.close();
    }
  });

  it("reopens a deferred finding when manual classification brings it in scope", () => {
    const { db, repo } = freshRepo();
    try {
      const goal = repo.createSession({
        goalId: "goal-classify",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        scope: session().scope,
        createdBy: "test",
        createdSource: "cli",
      });
      const deferred = repo.deferFinding({
        findingId: repo.upsertFinding({
          goalId: goal.goalId,
          source: "review",
          severity: "P1",
          category: "future-feature",
          scopeStatus: "out_of_scope",
          summary: "Add dashboard controls",
        }).finding.findingId,
        backlogItemId: "item-20260526-001",
        note: "future UI",
      });
      expect(deferred.lifecycleStatus).toBe("deferred");

      const manual = repo.classifyFinding({
        findingId: deferred.findingId,
        scopeStatus: "in_scope",
        reason: "manual owner decision: blocks the current release",
      });
      expect(manual.scopeStatus).toBe("in_scope");
      expect(manual.lifecycleStatus).toBe("open");
      expect(manual.deferredBacklogItemId).toBeNull();
      expect(manual.deferredAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("reopens a hidden deferred finding when manual classification becomes unknown", () => {
    const { db, repo } = freshRepo();
    try {
      repo.createSession({
        goalId: "goal-classify",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        closeConditions: [
          {
            id: "typecheck",
            kind: "command",
            required: true,
          },
        ],
        createdBy: "test",
        createdSource: "cli",
      });
      repo.recordCloseCheck({
        goalId: "goal-classify",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
      const deferred = repo.deferFinding({
        findingId: repo.upsertFinding({
          goalId: "goal-classify",
          source: "review",
          severity: "P2",
          category: "future-feature",
          scopeStatus: "out_of_scope",
          summary: "Add dashboard controls",
        }).finding.findingId,
        backlogItemId: "item-20260526-001",
        note: "future UI",
      });

      const unknown = repo.classifyFinding({
        findingId: deferred.findingId,
        scopeStatus: "unknown",
        reason: "manual owner is unsure",
      });
      expect(unknown.scopeStatus).toBe("unknown");
      expect(unknown.lifecycleStatus).toBe("open");
      expect(unknown.deferredBacklogItemId).toBeNull();
      expect(new ConvergenceService(repo).evaluate("goal-classify").decision).toBe(
        "needs_classification",
      );
    } finally {
      db.close();
    }
  });

  it("does not allow unknown scope findings to be auto-fixed by default", () => {
    expect(
      canAutoFixFinding(session(), {
        severity: "P1",
        scopeStatus: "unknown",
        lifecycleStatus: "open",
      }),
    ).toBe(false);
    expect(
      canAutoFixFinding(session(), {
        severity: "P1",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
      }),
    ).toBe(true);
  });
});

describe("isTestNotRunAdvisory", () => {
  it("treats plain test-not-run notes as advisories without requiring context", () => {
    expect(isTestNotRunAdvisory("Tests were not run.")).toBe(true);
    expect(isTestNotRunAdvisory("No tests were run.")).toBe(true);
    // isEnvironmentMetaNote is narrower: a plain note with no environment /
    // reviewer context is not an environment meta note, but it is still a
    // reviewer advisory when it appears as a non_blocking comment.
    expect(isEnvironmentMetaNote("Tests were not run.")).toBe(false);
  });

  it("does not treat real test-related findings as advisories", () => {
    expect(isTestNotRunAdvisory("Add regression tests for the parser.")).toBe(
      false,
    );
    expect(
      isTestNotRunAdvisory("The test suite fails after this change."),
    ).toBe(false);
  });
});
