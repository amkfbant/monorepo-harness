import { describe, expect, it } from "vitest";
import {
  formatHitchOrchestrateResultLine,
  formatHitchStatusLine,
} from "../../../src/cli/hitch.js";

describe("hitch CLI formatting", () => {
  it("prints draft state as a separate field without changing outcome", () => {
    const line = formatHitchOrchestrateResultLine(
      "g-draft",
      {
        hitchId: "g-draft",
        outcome: "pr_created",
        draft: true,
        prUrl: "https://example.test/pr/1",
        steps: [],
        finalDecision: "close_ready",
      },
      { linked: false },
    );

    expect(line).toContain("outcome=pr_created draft=true");
    expect(line).toContain("pr=https://example.test/pr/1");
    expect(line).not.toContain("pr_created(draft)");
  });

  it("labels passed review_consensus checks as static-only approval", () => {
    const line = formatHitchStatusLine({
      session: {
        hitchId: "g-static",
        status: "close_ready",
        closeConditions: [
          { id: "review-ok", kind: "review_consensus", required: true },
        ],
      },
      convergence: {
        decision: "close_ready",
        metrics: {
          openInScopeP1: 0,
          openUnknownScope: 0,
        },
      },
      closeChecks: [
        {
          conditionId: "review-ok",
          status: "passed",
          evidence: {
            reviewerAdvisories: [
              {
                source: "non_blocking_comment",
                index: 0,
                category: "test-execution-unverified",
                text: "No command logs were present.",
              },
            ],
          },
        },
      ],
    });

    expect(line).toContain("review_consensus=static_pass");
    expect(line).toContain("tests=not_run_by_consensus");
    expect(line).toContain("review_advisories=1");
  });

  it("shows the latest adopted PR before the superseded run PR", () => {
    const line = formatHitchStatusLine({
      session: {
        hitchId: "g-adopted",
        status: "close_ready",
        closeConditions: [],
      },
      convergence: {
        decision: "close_ready",
        metrics: {
          openInScopeP1: 0,
          openUnknownScope: 0,
        },
      },
      closeChecks: [],
      lifecycleEvents: [
        {
          event: "pr_adopted",
          createdAt: "2026-06-13T01:00:00.000Z",
          detail: {
            adoptedPr: {
              url: "https://github.com/acme/app/pull/42",
              number: 42,
            },
            supersededPr: {
              url: "https://github.com/acme/app/pull/7",
              number: 7,
            },
            runId: "run-old",
          },
        },
      ],
    });

    expect(line).toContain("pr=https://github.com/acme/app/pull/42");
    expect(line).toContain("supersededPr=https://github.com/acme/app/pull/7");
    expect(line.indexOf("pr=https://github.com/acme/app/pull/42")).toBeLessThan(
      line.indexOf("supersededPr=https://github.com/acme/app/pull/7"),
    );
  });

  const baseStatus = {
    session: { hitchId: "g-tok", status: "open", closeConditions: [] },
    convergence: {
      decision: "continue",
      metrics: { openInScopeP1: 0, openUnknownScope: 0 },
    },
    closeChecks: [],
  };

  function totals(total: number) {
    return {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: total,
      runsWithUsage: total === 0 ? 0 : 1,
    };
  }

  it("appends a token-usage line with the kind split when usage is present", () => {
    const line = formatHitchStatusLine({
      ...baseStatus,
      tokenUsage: {
        inputTokens: 34,
        cachedInputTokens: 2,
        outputTokens: 16,
        reasoningOutputTokens: 4,
        totalTokens: 50,
        runsWithUsage: 2,
        byKind: {
          coder: totals(43),
          reviewer: totals(5),
          evaluator: totals(2),
        },
      },
    });
    expect(line).toContain("\ntokens total=50");
    expect(line).toContain("in=34 cached=2 out=16 reasoning=4");
    expect(line).toContain("runsWithUsage=2");
    expect(line).toContain("byKind[coder=43 reviewer=5 evaluator=2]");
  });

  it("omits the token-usage line when there is no usage", () => {
    const withZero = formatHitchStatusLine({
      ...baseStatus,
      tokenUsage: {
        ...totals(0),
        byKind: { coder: totals(0), reviewer: totals(0), evaluator: totals(0) },
      },
    });
    expect(withZero).not.toContain("tokens total=");
    const withUndefined = formatHitchStatusLine(baseStatus);
    expect(withUndefined).not.toContain("tokens total=");
  });

  it("appends evidence line(s) when evidence rows are present", () => {
    const line = formatHitchStatusLine({
      ...baseStatus,
      evidence: [
        {
          evidenceId: "ev-aabbccdd1122",
          hitchId: "g-tok",
          runId: null,
          conditionId: null,
          kind: "note",
          attester: "operator",
          attesterLabel: "operator",
          label: "manual check passed",
          command: null,
          exitCode: null,
          summaryMetrics: {},
          metricsSchema: 1,
          outputExcerpt: null,
          secretSuspect: false,
          redacted: false,
          createdAt: "2026-06-23T00:00:00.000Z",
        },
      ],
    });
    expect(line).toContain("ev-aabbccdd");
    expect(line).toContain("note");
    expect(line).toContain("operator");
    expect(line).toContain("manual check passed");
  });

  it("omits evidence section entirely when evidence list is empty or absent", () => {
    const withEmpty = formatHitchStatusLine({ ...baseStatus, evidence: [] });
    expect(withEmpty).not.toContain("ev-");
    expect(withEmpty).not.toContain("evidence");
    const withUndefined = formatHitchStatusLine(baseStatus);
    expect(withUndefined).not.toContain("ev-");
    expect(withUndefined).not.toContain("evidence");
  });
});
