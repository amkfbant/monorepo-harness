import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  canAutoFixFinding,
  classifyFindingForHitch,
  hasCommandFailureVeto,
  isEnvironmentMetaNote,
  isCommandEvidenceAdvisory,
  isSuccessfulCommandEvidenceAdvisory,
  isTestNotRunAdvisory,
} from "../../../src/hitch/classification.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { DEFAULT_HITCH_POLICY, type HitchSession } from "../../../src/hitch/types.js";

function session(): HitchSession {
  return {
    hitchId: "goal-classify",
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
    policy: DEFAULT_HITCH_POLICY,
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

function freshRepo(): { db: ReturnType<typeof openDb>; repo: HitchRepository } {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-classify-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, repo: new HitchRepository(db) };
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
    const classified = classifyFindingForHitch(session(), {
      source: "review",
      severity: "P1",
      category: "review-required-change",
      summary: "Tests were not run in this environment.",
    });
    expect(classified.scopeStatus).toBe("unknown");
  });

  it.each([
    "Tests passed with no errors.",
    "Checks passed without errors.",
    "error-handling tests passed with no failures.",
  ])("classifies review non-blocking comments as out of scope: %s", (summary) => {
    const classified = classifyFindingForHitch(session(), {
      source: "review",
      severity: "P2",
      category: "review-non-blocking-comment",
      summary,
    });

    expect(classified).toMatchObject({
      scopeStatus: "out_of_scope",
      reason: "review non-blocking comments are advisory",
    });
  });

  it("keeps review non-blocking comments from triggering classification convergence", () => {
    const { db, repo } = freshRepo();
    try {
      repo.createSession({
        hitchId: "goal-classify",
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
        hitchId: "goal-classify",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
      const classified = classifyFindingForHitch(session(), {
        source: "review",
        severity: "P2",
        category: "review-non-blocking-comment",
        summary: "Tests passed with no errors.",
      });
      repo.upsertFinding({
        hitchId: "goal-classify",
        source: "review",
        severity: "P2",
        category: "review-non-blocking-comment",
        scopeStatus: classified.scopeStatus,
        summary: "Tests passed with no errors.",
      });

      const decision = new ConvergenceService(repo).evaluate(
        "goal-classify",
      ).decision;
      expect(decision).not.toBe("needs_classification");
      expect(decision).not.toBe("escalate");
    } finally {
      db.close();
    }
  });

  it("classifies file paths inside targetFiles as in scope", () => {
    const classified = classifyFindingForHitch(session(), {
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
    const classified = classifyFindingForHitch(session(), {
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
    const classified = classifyFindingForHitch(session(), {
      source: "review",
      severity: "P1",
      category: "security",
      summary: "Refactor confirmation token validation",
    });
    expect(classified.scopeStatus).toBe("in_scope");
    expect(classified.reason).toMatch(/category/);
  });

  it("classifies file paths outside targetFiles as out of scope", () => {
    const classified = classifyFindingForHitch(session(), {
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
    const classified = classifyFindingForHitch(session(), {
      source: "review",
      severity: "P3",
      category: "future-feature",
      summary: "Add dashboard controls",
    });
    expect(classified.scopeStatus).toBe("out_of_scope");
  });

  it("classifies close-check failures as in scope", () => {
    const classified = classifyFindingForHitch(session(), {
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
    const classified = classifyFindingForHitch(session(), {
      source: "human",
      severity: "P2",
      category: "quality",
      summary: "Improve launch handoff",
    });
    expect(classified.scopeStatus).toBe("unknown");
  });

  it("does not classify generic goal-title words as in scope", () => {
    const classified = classifyFindingForHitch(session(), {
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
        hitchId: "goal-classify",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        scope: session().scope,
        createdBy: "test",
        createdSource: "cli",
      });
      const finding = repo.upsertFinding({
        hitchId: goal.hitchId,
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
        hitchId: "goal-classify",
        title: "Fix MCP confirmation safety",
        domain: "mcp",
        scope: session().scope,
        createdBy: "test",
        createdSource: "cli",
      });
      const deferred = repo.deferFinding({
        findingId: repo.upsertFinding({
          hitchId: goal.hitchId,
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
        hitchId: "goal-classify",
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
        hitchId: "goal-classify",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
      const deferred = repo.deferFinding({
        findingId: repo.upsertFinding({
          hitchId: "goal-classify",
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

describe("isCommandEvidenceAdvisory", () => {
  it.each([
    "No commands directory was present, so test execution is evidenced only by the run summary.",
    "No commands folder is present; test execution evidence comes only from the run summary.",
    "The commands dir is absent, so the test run evidence is limited to the run summary.",
    "Test run evidence is only the run summary because there is no commands directory.",
  ])("treats command-evidence notes as advisories: %s", (text) => {
    expect(isCommandEvidenceAdvisory(text)).toBe(true);
  });

  it("does not treat real blockers as command-evidence advisories", () => {
    expect(isCommandEvidenceAdvisory("missing null check in handler")).toBe(
      false,
    );
  });
});

describe("isSuccessfulCommandEvidenceAdvisory", () => {
  it.each([
    "Command logs show npm run typecheck and npx vitest run completed successfully.",
    "typecheck passed and vitest passed.",
    "typecheck passed with no errors.",
    "vitest passed with no failures.",
    "typecheck passed without errors.",
    "The test command ran successfully.",
    "npx vitest run completed successfully.",
  ])("treats successful command/test notes as advisories: %s", (text) => {
    expect(isSuccessfulCommandEvidenceAdvisory(text)).toBe(true);
  });

  it.each([
    "The commands array is unverified and can omit required validation.",
    "typecheck passed, but the commands array was not verified.",
    "Tests passed locally but command log evidence is missing.",
    "typecheck passed, but vitest failed.",
    "No tests passed.",
    "The test command did not pass.",
    "Tests were not run because vitest failed.",
    "2 failures were reported by vitest.",
  ])("does not suppress real command-evidence findings: %s", (text) => {
    expect(isSuccessfulCommandEvidenceAdvisory(text)).toBe(false);
  });
});

describe("hasCommandFailureVeto", () => {
  it.each([
    "typecheck passed with no errors.",
    "vitest passed with no failures.",
    "typecheck passed without errors.",
    "vitest passed without any failures.",
    "typecheck passed with 0 errors.",
    "vitest passed with zero test failures.",
    "vitest passed with no test failures.",
  ])("does not veto negated failure terms: %s", (text) => {
    expect(hasCommandFailureVeto(text)).toBe(false);
  });

  it.each([
    "vitest failed.",
    "2 failures were reported by vitest.",
    "The test command did not pass.",
    "No tests passed.",
    "Tests were not run because vitest failed.",
  ])("vetoes actual command/test failures: %s", (text) => {
    expect(hasCommandFailureVeto(text)).toBe(true);
  });
});
