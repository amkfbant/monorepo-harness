import { describe, it, expect } from "vitest";
import { buildReviewRequest } from "../../../src/reporter/review-request.js";

const BASE = {
  runId: "run-20260520-apps-user-xyz",
  domain: "apps/user",
  goal: "add validation",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  runBranch: "harness/run-20260520-apps-user-xyz/apps-user",
  worktreePath: "/tmp/wt",
  codexExitCode: 0,
  codexTimedOut: false,
  codexStdoutTail: "applied 1 file",
  finalDiffPath: "/tmp/runs/x/final-diff.patch",
  summaryPath: "/tmp/runs/x/summary.md",
  knowledgeCandidatesPath: "/tmp/runs/x/knowledge-candidates.yaml",
  reviewDecisionPath: "/tmp/runs/x/review-decision.yaml",
} as const;

describe("buildReviewRequest", () => {
  it("renders metadata, tracked/untracked lists, and the review checklist", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "needs_review",
      changedPaths: ["apps/user/profile.ts"],
      untrackedPaths: ["apps/user/profile.test.ts"],
      violations: [],
    });
    expect(md).toMatch(/# Review request: run-20260520/);
    expect(md).toMatch(/Status: \*\*needs_review\*\*/);
    expect(md).toMatch(/Base commit: `0123456789/);
    expect(md).toMatch(/apps\/user\/profile\.ts/);
    expect(md).toMatch(/apps\/user\/profile\.test\.ts/);
    expect(md).toMatch(/Review checklist/);
    expect(md).toMatch(/applied 1 file/);
  });

  it("lists violations when status is failed-policy-violation", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "failed-policy-violation",
      changedPaths: ["package.json"],
      untrackedPaths: [],
      violations: [{ path: "package.json", reason: "deny_write" }],
    });
    expect(md).toMatch(/failed-policy-violation/);
    expect(md).toMatch(/`package\.json` — deny_write/);
  });

  it("annotates timeouts", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "failed-codex-timeout",
      changedPaths: [],
      untrackedPaths: [],
      violations: [],
      codexExitCode: -1,
      codexTimedOut: true,
    });
    expect(md).toMatch(/TIMEOUT/);
  });
});
