import { describe, expect, it } from "vitest";
import { evaluateCloseConditions } from "../../../src/hitch/close-checks.js";
import type {
  HitchCloseCheck,
  HitchCloseCondition,
  HitchEvidence,
} from "../../../src/hitch/types.js";

const REVIEW_CONDITION: HitchCloseCondition = {
  id: "review-consensus",
  kind: "review_consensus",
  required: true,
};

function noFindingCounts() {
  return {
    openInScopeP0: 0,
    openInScopeP1: 0,
    openInScopeP2: 0,
    openUnknownScope: 0,
  };
}

function check(overrides: Partial<HitchCloseCheck>): HitchCloseCheck {
  return {
    checkId: "check-a",
    hitchId: "goal-a",
    conditionId: "review-consensus",
    status: "passed",
    checkedAt: "2026-05-26T00:00:00.000Z",
    checkedBy: "test",
    evidence: {},
    message: null,
    ...overrides,
  };
}

function evidence(overrides: Partial<HitchEvidence> = {}): HitchEvidence {
  return {
    evidenceId: "ev-a",
    hitchId: "goal-a",
    runId: null,
    conditionId: "review-consensus",
    kind: "transcript",
    attester: "operator",
    label: "codex review",
    command: null,
    exitCode: null,
    summaryMetrics: {},
    metricsSchema: 1,
    outputExcerpt: null,
    secretSuspect: false,
    redacted: false,
    createdAt: "2026-05-26T00:00:00.000Z",
    ...overrides,
  };
}

function evaluate(rows: HitchEvidence[], checks: HitchCloseCheck[] = []) {
  return evaluateCloseConditions({
    conditions: [REVIEW_CONDITION],
    checks,
    findingCounts: noFindingCounts(),
    evidenceRows: rows,
  });
}

describe("review_consensus attached evidence fallback", () => {
  it("accepts a GitHub Codex no-major-issues transcript", () => {
    const result = evaluate([
      evidence({
        outputExcerpt:
          "Codex Review: Didn't find any major issues. Hooray!\n\nReviewed commit: abc123",
      }),
    ]);

    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
    expect(result.conditions[0]?.check).toBeNull();
    expect(result.conditions[0]?.message).toMatch(/attached Codex review/i);
  });

  it("accepts metrics rows with zero in-scope P0/P1 findings", () => {
    const result = evaluate([
      evidence({
        kind: "metrics",
        summaryMetrics: { openInScopeP0: "0", openInScopeP1: 0 },
      }),
    ]);

    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("accepts ready_to_merge JSON with no blocking findings", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          verdict: "ready_to_merge",
          findings: [{ severity: "P2", scope_status: "out_of_scope" }],
        }),
      }),
    ]);

    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("rejects unsupported prose, stale evidence, and fresh recorded failures", () => {
    expect(evaluate([evidence({ outputExcerpt: "looks good" })]).requiredPending).toBe(
      1,
    );
    const stale = evaluateCloseConditions({
      conditions: [REVIEW_CONDITION],
      checks: [],
      findingCounts: noFindingCounts(),
      freshAfter: "2026-05-20T00:00:00.000Z",
      evidenceRows: [
        evidence({
          outputExcerpt: "Codex Review: Didn't find any major issues.",
          createdAt: "2026-05-01T00:00:00.000Z",
        }),
      ],
    });
    expect(stale.requiredPending).toBe(1);

    const failed = evaluate(
      [evidence({ outputExcerpt: "Codex Review: Didn't find any major issues." })],
      [check({ status: "failed" })],
    );
    expect(failed.requiredFailed).toBe(1);
  });

  it("lets fresh attached evidence refresh a stale recorded review_consensus check", () => {
    const result = evaluateCloseConditions({
      conditions: [REVIEW_CONDITION],
      checks: [check({ checkedAt: "2026-05-01T00:00:00.000Z" })],
      findingCounts: noFindingCounts(),
      freshAfter: "2026-05-20T00:00:00.000Z",
      evidenceRows: [
        evidence({ outputExcerpt: "Codex Review: Didn't find any major issues." }),
      ],
    });

    expect(result.requiredPassed).toBe(1);
    expect(result.allRequiredPassed).toBe(true);
  });

  it("binds accepted evidence shapes to their expected evidence kind", () => {
    const noteMetrics = evaluate([
      evidence({
        kind: "note",
        outputExcerpt: "Codex Review: Didn't find any major issues.",
        summaryMetrics: { p0: 0, p1: 0 },
      }),
    ]);
    const metricsTranscript = evaluate([
      evidence({
        kind: "metrics",
        outputExcerpt: "Codex Review: Didn't find any major issues.",
      }),
    ]);

    expect(noteMetrics.requiredPending).toBe(1);
    expect(metricsTranscript.requiredPending).toBe(1);
  });

  it("rejects ready_to_merge JSON when priority is only encoded in title", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          verdict: "ready_to_merge",
          findings: [{ title: "[P1] still broken" }],
        }),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("treats in-scope aliases and unknown scope spellings as blocking", () => {
    const inScopeAlias = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          verdict: "ready_to_merge",
          findings: [{ severity: "P1", scope_status: "in-scope" }],
        }),
      }),
    ]);
    const unknownScope = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          verdict: "ready_to_merge",
          findings: [{ severity: "P1", scope_status: "maybe-in-scope" }],
        }),
      }),
    ]);

    expect(inScopeAlias.requiredPending).toBe(1);
    expect(unknownScope.requiredPending).toBe(1);
  });

  it("evaluates contradictory JSON before accepting a no-major-issues phrase", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          verdict: "changes_requested",
          summary: "Didn't find any major issues in unrelated docs.",
          findings: [{ severity: "P1", scope_status: "in_scope" }],
        }),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("evaluates embedded fenced JSON before accepting a no-major-issues phrase", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: [
          "Codex Review: Didn't find any major issues in unrelated docs.",
          "```json",
          JSON.stringify({
            verdict: "ready_to_merge",
            findings: [{ title: "[P1] still broken" }],
          }),
          "```",
        ].join("\n"),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("rejects contradictory metric aliases", () => {
    const result = evaluate([
      evidence({
        kind: "metrics",
        summaryMetrics: { openInScopeP0: 0, openInScopeP1: 1, p1: 0 },
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("uses the newest review-shaped evidence instead of an older pass", () => {
    const result = evaluate([
      evidence({
        evidenceId: "ev-old",
        createdAt: "2026-05-26T00:00:00.000Z",
        outputExcerpt: "Codex Review: Didn't find any major issues.",
      }),
      evidence({
        evidenceId: "ev-new",
        createdAt: "2026-05-26T00:01:00.000Z",
        outputExcerpt: JSON.stringify({
          verdict: "changes_requested",
          findings: [{ severity: "P1", scope_status: "in_scope" }],
        }),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("rejects malformed embedded review JSON before accepting a no-major-issues phrase", () => {
    const result = evaluate([
      evidence({
        outputExcerpt:
          'Codex Review: Didn\'t find any major issues.\n{verdict: "changes_requested", findings: []}',
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("rejects invalid explicit severities instead of falling back to title", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          ready_to_merge: true,
          findings: [
            {
              severity: "major",
              title: "[P2] malformed severity should fail closed",
              scope_status: "in_scope",
            },
          ],
        }),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("scans every fenced review JSON block before passing", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: [
          "```json",
          JSON.stringify({ ready_to_merge: true, findings: [] }),
          "```",
          "```json",
          JSON.stringify({
            verdict: "changes_requested",
            findings: [{ severity: "P1", scope_status: "in_scope" }],
          }),
          "```",
        ].join("\n"),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("accepts multiple fenced review JSON blocks only when all are non-blocking", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: [
          "```json",
          JSON.stringify({ ready_to_merge: true, findings: [] }),
          "```",
          "```json",
          JSON.stringify({
            verdict: "ready_to_merge",
            findings: [{ severity: "P2", scope_status: "out_of_scope" }],
          }),
          "```",
        ].join("\n"),
      }),
    ]);

    expect(result.requiredPassed).toBe(1);
  });

  it("rejects transcript evidence at the excerpt cap", () => {
    const phrase = "Codex Review: Didn't find any major issues.";
    const outputExcerpt = `${"x".repeat(8192 - phrase.length)}${phrase}`;
    const result = evaluate([evidence({ outputExcerpt })]);

    expect(Buffer.byteLength(outputExcerpt, "utf8")).toBe(8192);
    expect(result.requiredPending).toBe(1);
  });

  it("rejects transcript evidence near the excerpt cap", () => {
    const phrase = "Codex Review: Didn't find any major issues.";
    const outputExcerpt = `${"x".repeat(8191 - phrase.length)}${phrase}`;
    const result = evaluate([evidence({ outputExcerpt })]);

    expect(Buffer.byteLength(outputExcerpt, "utf8")).toBe(8191);
    expect(result.requiredPending).toBe(1);
  });

  it("scans extractable review JSON even when fenced blocks exist", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: [
          "Codex Review: Didn't find any major issues.",
          "```ts",
          "const unrelated = true;",
          "```",
          JSON.stringify({
            verdict: "changes_requested",
            findings: [{ severity: "P1", scope_status: "in_scope" }],
          }),
        ].join("\n"),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("rejects unterminated embedded review JSON before accepting prose", () => {
    const result = evaluate([
      evidence({
        outputExcerpt:
          'Codex Review: Didn\'t find any major issues.\n{"verdict":"changes_requested","findings":[',
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("rejects contradictory scope aliases in findings", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          ready_to_merge: true,
          findings: [
            {
              severity: "P1",
              scopeStatus: "out_of_scope",
              scope_status: "in_scope",
            },
          ],
        }),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("rejects conflicting ready verdict aliases", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          ready_to_merge: true,
          verdict: "changes_requested",
          findings: [],
        }),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });

  it("inspects both findings and issues arrays", () => {
    const result = evaluate([
      evidence({
        outputExcerpt: JSON.stringify({
          ready_to_merge: true,
          findings: [],
          issues: [{ severity: "P1", scope_status: "in_scope" }],
        }),
      }),
    ]);

    expect(result.requiredPending).toBe(1);
  });
});
