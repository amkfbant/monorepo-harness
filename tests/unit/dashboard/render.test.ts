import { describe, it, expect } from "vitest";
import { renderDashboardHtml } from "../../../src/dashboard/render.js";
import type { DashboardSnapshot } from "../../../src/dashboard/snapshot.js";

/** A snapshot whose data fields all carry markup, to exercise escaping. */
function markupSnapshot(): DashboardSnapshot {
  return {
    generatedAt: "2026-05-22T00:00:00Z",
    dbPath: "/tmp/<x>/harness.sqlite",
    dbSchemaVersion: 1,
    importedRuns: 1,
    consistencyStatus: "ok",
    filters: {},
    projects: [
      {
        projectId: "demo",
        repoId: "demo",
        description: "<b>desc</b>",
        domainCount: 1,
        runCount: 1,
        hasGeneratedPolicy: false,
        consistency: "ok",
      },
    ],
    overview: {
      totalRuns: 1,
      byStatus: { needs_review: 1 },
      approved: 0,
      needsReview: 1,
      failed: 0,
      approvedRate: null,
      oneShotApprovalRate: null,
      policyViolationRate: null,
      secretSuspectRate: null,
      lockContentionCount: 0,
    },
    usage: {
      runsWithUsage: 1,
      totalInputTokens: 100,
      totalOutputTokens: 23,
      totalTokens: 123,
      bySource: { exact: 1 },
    },
    metricsTrend: [
      {
        createdAt: "2026-05-22T00:00:00Z",
        totalRuns: 1,
        approvedRate: 1,
        totalTokens: 123,
      },
    ],
    hitchMetrics: {
      totalSessions: 1,
      byStatus: { open: 1 },
      avgReviewCycles: null,
      avgRerunAttempts: null,
      findingsBySeverity: { P1: 1 },
      findingResolutionRate: null,
      reopenRate: null,
    },
    mcpConfirmations: {
      total: 1,
      byStatus: { pending: 1 },
      confirmationRate: null,
      expiredRate: null,
    },
    inbox: {
      needsReview: [],
      changesRequested: [],
      failed: [],
      knowledgeCandidateRuns: 0,
      operationalKnowledge: {
        total: 1,
        recent: [
          {
            entryId: "ops/<script>",
            title: "Ops <b>note</b>",
            kind: "ci",
            projectId: null,
            domain: null,
            updatedAt: "2026-06-08T00:00:00Z",
          },
        ],
      },
    },
    recentRuns: [
      {
        runId: "run-<script>x</script>",
        repoId: "demo",
        projectId: "demo",
        domain: "apps/<web>",
        status: "needs_review",
        safetyStatus: null,
        reviewer: null,
        startedAt: "2026-05-21T00:00:00Z",
        finishedAt: null,
        rerunAttempt: null,
        prUrl: null,
      },
    ],
    backlog: {
      items: [
        {
          itemId: "item-<script>i</script>",
          projectId: "demo",
          repoId: "demo",
          domain: "apps/web",
          title: "<script>alert(1)</script>",
          status: "open",
          priority: "high",
        },
      ],
      byStatus: { open: 1 },
    },
    knowledge: { candidateTotal: 0, byKind: {}, byStatus: {}, entryTotal: 0 },
    warnings: [{ level: "warn", message: "danger <img src=x onerror=y>" }],
  };
}

describe("renderDashboardHtml", () => {
  it("escapes markup in every interpolated snapshot value", () => {
    const html = renderDashboardHtml(markupSnapshot());
    // no unescaped data-derived markup leaks into the page
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).not.toMatch(/<script>x<\/script>/);
    expect(html).not.toMatch(/<img src=x onerror=y>/);
    expect(html).not.toMatch(/<b>desc<\/b>/);
    // the escaped forms ARE present
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    expect(html).toMatch(/apps\/&lt;web&gt;/);
    expect(html).toMatch(/&lt;img src=x onerror=y&gt;/);
  });

  it("renders a self-contained page (no external assets / JS)", () => {
    const html = renderDashboardHtml(markupSnapshot());
    expect(html).toMatch(/<!doctype html>/);
    expect(html).not.toMatch(/src=["']http/);
    expect(html).not.toMatch(/<script\s/);
  });

  describe("read-only dashboard HTML", () => {
    it("never emits CSRF meta, JS, or mutation controls", () => {
      const html = renderDashboardHtml(markupSnapshot());
      expect(html).not.toMatch(/harness-csrf-token/);
      expect(html).not.toMatch(/<script/);
      expect(html).not.toMatch(/harness-bearer/);
      expect(html).not.toMatch(/X-CSRF-Token/);
      expect(html).not.toMatch(/Idempotency-Key/);
      expect(html).not.toMatch(/data-act=/);
    });
  });
});
