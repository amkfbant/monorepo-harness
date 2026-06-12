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
    },
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

  describe("mutation UI (Phase 4)", () => {
    it("is absent by default (read-only): no CSRF meta, no JS, no mutation controls", () => {
      const html = renderDashboardHtml(markupSnapshot());
      expect(html).not.toMatch(/harness-csrf-token/);
      expect(html).not.toMatch(/<script/);
      expect(html).not.toMatch(/harness-bearer/);
      expect(html).not.toMatch(/\/api\/runs\//);
    });

    it("is present when mutation is enabled: CSRF meta, bearer input, auth headers, POST paths", () => {
      const html = renderDashboardHtml(markupSnapshot(), {
        mutation: { csrfToken: "tok-123" },
      });
      // CSRF meta carries the token.
      expect(html).toMatch(/<meta name="harness-csrf-token" content="tok-123">/);
      // bearer input + dry-run toggle.
      expect(html).toMatch(/id="harness-bearer"/);
      expect(html).toMatch(/id="harness-dryrun"/);
      // the JS sends the required auth headers.
      expect(html).toMatch(/X-CSRF-Token/);
      expect(html).toMatch(/Authorization/);
      expect(html).toMatch(/Bearer/);
      expect(html).toMatch(/Idempotency-Key/);
      // each mutation endpoint is reachable from the UI.
      expect(html).toMatch(/\/review/);
      expect(html).toMatch(/\/cleanup/);
      expect(html).toMatch(/\/pr/);
      expect(html).toMatch(/\/rerun/);
      expect(html).toMatch(/\/api\/backlog\//);
      // destructive ops confirm; dry-run is the default.
      expect(html).toMatch(/confirm\(/);
      expect(html).toMatch(/id="harness-dryrun" checked/);
      // cleanup offers a scope selector (workspace/run/all).
      expect(html).toMatch(/class="mut-scope"/);
      expect(html).toMatch(/<option value="workspace">/);
      expect(html).toMatch(/<option value="run">/);
      expect(html).toMatch(/<option value="all">/);
      // review actions apply the clicked decision as an audited override on
      // non-dry-run (the backend ignores the body decision otherwise), and the
      // reason prompt serves as the confirmation.
      expect(html).toMatch(/body\.override=\{reason:reason\}/);
      expect(html).toMatch(/window\.prompt\(/);
      expect(html).toMatch(/decision:decision/);
    });

    it("escapes the CSRF token and run/backlog ids in the mutation UI", () => {
      const html = renderDashboardHtml(markupSnapshot(), {
        mutation: { csrfToken: '"><script>x</script>' },
      });
      // the token is escaped inside the meta attribute.
      expect(html).not.toMatch(/content="">/);
      expect(html).toMatch(/&quot;&gt;&lt;script&gt;/);
      // run id (which contains markup) is escaped in its data attribute.
      expect(html).not.toMatch(/data-run-id="run-<script>/);
      expect(html).toMatch(/run-&lt;script&gt;/);
      // backlog item id is escaped in its data attribute too.
      expect(html).not.toMatch(/data-item-id="item-<script>/);
      expect(html).toMatch(/item-&lt;script&gt;/);
    });
  });
});
