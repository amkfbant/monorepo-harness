import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runReviewerAgent,
  extractYamlBlock,
} from "../../../src/core/reviewer-agent.js";
import type { CodexExecRunner } from "../../../src/codex/codex-exec-runner.js";

interface SetupOpts {
  status?: string;
  missingDecisionFile?: boolean;
}

function setup(
  opts: SetupOpts = {},
): { runsDir: string; runId: string } {
  const runsDir = mkdtempSync(join(tmpdir(), "harness-reviewer-"));
  const runId = "run-20260521-apps-user-rev1";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        runId,
        repoId: "t",
        repoPath: "/tmp/t",
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "abc",
        runBranch: "harness/x",
        status: opts.status ?? "needs_review",
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
  if (!opts.missingDecisionFile) {
    writeFileSync(
      join(runDir, "review-decision.yaml"),
      [
        `runId: ${runId}`,
        "domain: apps/user",
        "decision: pending",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: null",
        "reviewed_at: null",
        "",
      ].join("\n"),
    );
  }
  return { runsDir, runId };
}

function fakeRunnerWithOutput(
  output: string,
  opts: { exitCode?: number; timedOut?: boolean } = {},
): CodexExecRunner {
  return {
    async run(input) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      return {
        exitCode: opts.exitCode ?? 0,
        timedOut: opts.timedOut ?? false,
      };
    },
  };
}

const APPROVED_OUTPUT = [
  "Here is my review:",
  "",
  "```yaml",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments:",
  '  - "diff is scoped to apps/user, no surprises"',
  "out_of_scope_suggestions: []",
  "```",
].join("\n");

describe("extractYamlBlock", () => {
  it("returns the body inside a ```yaml fence", () => {
    const y = extractYamlBlock("hi\n```yaml\ndecision: approved\n```\nbye");
    expect(y).toBe("decision: approved");
  });

  it("returns the body inside a ```yml fence", () => {
    const y = extractYamlBlock("```yml\nfoo: bar\n```");
    expect(y).toBe("foo: bar");
  });

  it("falls back to the entire output when no fence is present", () => {
    expect(extractYamlBlock("decision: approved\n")).toBe(
      "decision: approved",
    );
  });
});

describe("runReviewerAgent", () => {
  it("writes the decision back to review-decision.yaml", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput(APPROVED_OUTPUT);
    const r = await runReviewerAgent({
      runsDir,
      runId,
      codexRunner: runner,
      now: new Date("2026-05-21T01:00:00Z"),
    });
    expect(r.decision).toBe("approved");
    expect(r.reviewer).toBe("codex-reviewer");
    expect(r.reviewedAt).toBe("2026-05-21T01:00:00.000Z");
    const yaml = readFileSync(
      join(runsDir, runId, "review-decision.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/decision: approved/);
    expect(yaml).toMatch(/reviewer: codex-reviewer/);
    expect(yaml).toMatch(/diff is scoped to apps\/user/);
  });

  it("honors a custom reviewerName", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput(APPROVED_OUTPUT);
    const r = await runReviewerAgent({
      runsDir,
      runId,
      reviewerName: "codex-reviewer-gpt-5.5",
      codexRunner: runner,
    });
    expect(r.reviewer).toBe("codex-reviewer-gpt-5.5");
  });

  it("defaults decision to changes_requested when codex returns an unknown decision", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput(
      [
        "```yaml",
        "decision: maybe",
        "required_changes:",
        '  - "fix something"',
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "```",
      ].join("\n"),
    );
    const r = await runReviewerAgent({
      runsDir,
      runId,
      codexRunner: runner,
    });
    expect(r.decision).toBe("changes_requested");
  });

  it("rejects an invalid runId (path traversal)", async () => {
    await expect(
      runReviewerAgent({
        runsDir: "/tmp",
        runId: "../escape",
        codexRunner: fakeRunnerWithOutput(""),
      }),
    ).rejects.toThrow(/invalid runId/);
  });

  it("rejects when status is not needs_review", async () => {
    const { runsDir, runId } = setup({ status: "approved" });
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
      }),
    ).rejects.toThrow(/only needs_review/);
  });

  it("rejects when codex exits non-zero", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput("oops", { exitCode: 17 });
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/exited 17/);
  });

  it("rejects when codex times out", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput("", {
      exitCode: -1,
      timedOut: true,
    });
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/timed out/);
  });

  it("rejects unparseable codex output (not yaml)", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput("```yaml\n[ not valid yaml\n```");
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/unparseable|not a YAML object/);
  });

  it("rejects when review-decision.yaml is missing", async () => {
    const { runsDir, runId } = setup({ missingDecisionFile: true });
    const runner = fakeRunnerWithOutput(APPROVED_OUTPUT);
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/not found/);
  });
});
