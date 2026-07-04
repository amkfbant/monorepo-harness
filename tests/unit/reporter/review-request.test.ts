import { describe, it, expect } from "vitest";
import { buildReviewRequest } from "../../../src/reporter/review-request.js";
import { COMMAND_LOG_LINE_WITHHELD } from "../../../src/reporter/secret-scan.js";

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
  codexStderrTail: "",
  finalDiffPath: "/tmp/runs/x/final-diff.patch",
  summaryPath: "/tmp/runs/x/summary.md",
  knowledgeCandidatesPath: "/tmp/runs/x/knowledge-candidates.yaml",
  reviewDecisionPath: "/tmp/runs/x/review-decision.yaml",
  ignoredUntrackedPaths: [] as string[],
  secretSuspectPaths: [] as string[],
} as const;

describe("buildReviewRequest", () => {
  it("renders metadata, tracked/untracked lists, and the review checklist", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "needs_review",
      safetyStatus: "allowed",
      changedPaths: ["apps/user/profile.ts"],
      untrackedPaths: ["apps/user/profile.test.ts"],
      violations: [],
    });
    expect(md).toMatch(/# Review request: run-20260520/);
    expect(md).toMatch(/Status: \*\*needs_review\*\*/);
    expect(md).toMatch(/Safety status: \*\*allowed\*\*/);
    expect(md).toMatch(/Base commit: `0123456789/);
    expect(md).toMatch(/apps\/user\/profile\.ts/);
    expect(md).toMatch(/apps\/user\/profile\.test\.ts/);
    expect(md).toMatch(/Review checklist/);
    expect(md).toMatch(/applied 1 file/);
  });

  it("renders violations and safety denied", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "failed-policy-violation",
      safetyStatus: "denied",
      changedPaths: ["package.json"],
      untrackedPaths: [],
      violations: [{ path: "package.json", reason: "deny_write" }],
    });
    expect(md).toMatch(/failed-policy-violation/);
    expect(md).toMatch(/Safety status: \*\*denied\*\*/);
    expect(md).toMatch(/`package\.json` — deny_write/);
  });

  it("includes stderr tail", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "failed-codex",
      safetyStatus: "allowed",
      changedPaths: [],
      untrackedPaths: [],
      violations: [],
      codexExitCode: 1,
      codexStderrTail: "error: model unavailable",
    });
    expect(md).toMatch(/Codex output \(stderr tail\)/);
    expect(md).toMatch(/error: model unavailable/);
  });

  it("redacts multi-line PEM blocks from Codex tails", () => {
    const body = "MIIEpAIBAAKCAQEAtailartifactsecretbody";
    const md = buildReviewRequest({
      ...BASE,
      status: "failed-codex",
      safetyStatus: "allowed",
      changedPaths: [],
      untrackedPaths: [],
      violations: [],
      codexExitCode: 1,
      codexStdoutTail: [
        "plain before",
        "-----BEGIN RSA PRIVATE KEY-----",
        body,
        "-----END RSA PRIVATE KEY-----",
        "plain after",
      ].join("\n"),
    });

    expect(md).toContain("plain before");
    expect(md).toContain("plain after");
    expect(md).toContain(COMMAND_LOG_LINE_WITHHELD);
    expect(md).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(md).not.toContain(body);
    expect(md).not.toContain("END RSA PRIVATE KEY");
  });

  it("annotates timeouts and diff collection failures", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "failed-codex-timeout",
      safetyStatus: "skipped",
      changedPaths: [],
      untrackedPaths: [],
      violations: [],
      codexExitCode: -1,
      codexTimedOut: true,
      diffCollectionError: "git diff failed (128)",
    });
    expect(md).toMatch(/TIMEOUT/);
    expect(md).toMatch(/Diff collection failed/);
    expect(md).toMatch(/Safety status: \*\*skipped\*\*/);
  });

  it("highlights secret-suspect files prominently", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "needs_review",
      safetyStatus: "allowed",
      changedPaths: [],
      untrackedPaths: ["apps/user/.env.local"],
      secretSuspectPaths: ["apps/user/.env.local"],
      violations: [],
    });
    expect(md).toMatch(/Secret-shaped files \(content REDACTED/);
    expect(md).toMatch(/apps\/user\/\.env\.local/);
  });

  it("links untracked-files patch when present", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "needs_review",
      safetyStatus: "allowed",
      changedPaths: [],
      untrackedPaths: ["apps/user/new.ts"],
      untrackedPatchPath: "/tmp/runs/x/untracked-files.patch",
      violations: [],
    });
    expect(md).toMatch(/untracked-files\.patch/);
  });

  it("summarizes advisory command failures for reviewers", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "needs_review",
      safetyStatus: "allowed",
      changedPaths: ["apps/user/profile.ts"],
      untrackedPaths: [],
      violations: [],
      commandResults: [
        { command: "npm test", exitCode: 0, durationMs: 1200, timedOut: false },
        { command: "npm run lint", exitCode: 2, durationMs: 34, timedOut: false },
      ],
    });

    expect(md).toMatch(/## Commands/);
    expect(md).toMatch(/Result: 1\/2 ok/);
    expect(md).toMatch(/`npm run lint`: exit 2, 34ms/);
  });

  it("describes enforce=false breaches as review backstop audit", () => {
    const md = buildReviewRequest({
      ...BASE,
      status: "needs_review",
      safetyStatus: "allowed",
      changedPaths: ["apps/user/profile.ts"],
      untrackedPaths: [],
      violations: [],
      diffStat: {
        filesChanged: 1,
        insertions: 0,
        deletions: 2,
        deletedFiles: 0,
      },
      changeBudget: {
        status: "exceeded-but-allowed",
        disabled: true,
        stage: "post-codex",
        budget: {
          maxDeletedLines: 1,
          maxTotalChangedLines: 10,
          maxDeletedFiles: 1,
          maxChangedFiles: 10,
          enforce: false,
        },
        breaches: [{ metric: "deleted_lines", actual: 2, limit: 1 }],
      },
    });

    expect(md).toMatch(/Change budget enforce=false/);
    expect(md).toMatch(/budget breach allowed to proceed to review/);
    expect(md).toMatch(/deleted_lines: actual 2 > limit 1/);
    expect(md).not.toMatch(/fail-open/i);
    expect(md).not.toMatch(/override/i);
  });
});
