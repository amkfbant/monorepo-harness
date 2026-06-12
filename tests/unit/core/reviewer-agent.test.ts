import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ReviewProposalRepository } from "../../../src/db/repositories/review-proposals.js";
import {
  runReviewerAgent,
  extractYamlBlock,
  PROMPT_PREAMBLE,
  REVIEWER_PROMPT_TEMPLATE,
} from "../../../src/core/reviewer-agent.js";
import type { CodexExecRunner } from "../../../src/codex/codex-exec-runner.js";

describe("reviewer prompt template (tripwire)", () => {
  // Pins PROMPT_PREAMBLE to its declared version. If you change the
  // reviewer prompt this hash breaks — when you update it, ALSO bump
  // REVIEWER_PROMPT_TEMPLATE.version.
  it("PROMPT_PREAMBLE content matches its declared version", () => {
    const hash = createHash("sha256")
      .update(PROMPT_PREAMBLE)
      .digest("hex")
      .slice(0, 16);
    expect(REVIEWER_PROMPT_TEMPLATE.version).toBe(2);
    expect(hash).toBe("2fe7b149384d076d");
  });

  it("tells reviewers to surface missing test execution as non-blocking advisory", () => {
    expect(PROMPT_PREAMBLE).toMatch(/static review passed/i);
    expect(PROMPT_PREAMBLE).toMatch(/does not execute tests/i);
    expect(PROMPT_PREAMBLE).toMatch(/non_blocking_comments/);
    expect(PROMPT_PREAMBLE).toMatch(/command logs/i);
  });
});

interface SetupOpts {
  status?: string;
  missingDecisionFile?: boolean;
  /** decision value written into review-decision.yaml (default: pending) */
  decision?: string;
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
    const decision = opts.decision ?? "pending";
    const nonPending = decision !== "pending";
    writeFileSync(
      join(runDir, "review-decision.yaml"),
      [
        `runId: ${runId}`,
        "domain: apps/user",
        `decision: ${decision}`,
        decision === "changes_requested"
          ? 'required_changes:\n  - "fix it"'
          : "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        `reviewer: ${nonPending ? "knkn" : "null"}`,
        `reviewed_at: ${nonPending ? "2026-05-21T00:00:00Z" : "null"}`,
        "",
      ].join("\n"),
    );
  }
  return { runsDir, runId };
}

function setupReviewDb(runId: string): string {
  const dbPath = join(
    mkdtempSync(join(tmpdir(), "harness-reviewer-db-")),
    ".harness",
    "harness.sqlite",
  );
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at, meta_json)
       VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
         'db-first', 1, 'disabled', '2026-05-21T00:00:00Z', '{}')`,
    ).run(runId);
  } finally {
    db.close();
  }
  return dbPath;
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
        durationMs: 0,
      };
    },
  };
}

function capturingRunner(
  output: string,
  seen: { prompt?: string },
): CodexExecRunner {
  return {
    async run(input) {
      seen.prompt = input.prompt;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
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
    expect(yaml).toMatch(
      /approved means static review passed; review_consensus does not execute tests/,
    );
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

  it("rejects (does NOT silently coerce) when codex returns an unknown decision", async () => {
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
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/missing or unknown decision/);
  });

  it("rejects when decision is missing entirely", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput(
      [
        "```yaml",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "```",
      ].join("\n"),
    );
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/missing or unknown decision/);
  });

  it("rejects when decision=changes_requested but required_changes is empty", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput(
      [
        "```yaml",
        "decision: changes_requested",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "```",
      ].join("\n"),
    );
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/required_changes is empty/);
  });

  it("rejects when an array field contains non-string entries", async () => {
    const { runsDir, runId } = setup();
    const runner = fakeRunnerWithOutput(
      [
        "```yaml",
        "decision: approved",
        "required_changes: []",
        "non_blocking_comments:",
        "  - 42",
        "out_of_scope_suggestions: []",
        "```",
      ].join("\n"),
    );
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/non-string entries/);
  });

  it("rejects when the agent tampered with a non-allowlisted artifact (snapshot check)", async () => {
    const { runsDir, runId } = setup();
    // create an existing artifact the agent might want to mutate
    const summary = join(runsDir, runId, "summary.md");
    const { writeFileSync, utimesSync } = await import("node:fs");
    writeFileSync(summary, "original\n");
    const runner: typeof fakeRunnerWithOutput extends () => infer T
      ? T
      : never = {
      async run(input: {
        worktreePath: string;
        prompt: string;
        logPaths: { stdout: string; stderr: string };
      }): Promise<{ exitCode: number; timedOut: boolean }> {
        // mutate summary.md during codex execution (simulating sandbox escape)
        writeFileSync(summary, "tampered\n");
        // bump mtime ahead to ensure the snapshot detects the change even
        // when the filesystem mtime resolution is coarse.
        const now = new Date();
        utimesSync(summary, now, new Date(now.getTime() + 5000));
        const { writeFile } = await import("node:fs/promises");
        await writeFile(input.logPaths.stdout, APPROVED_OUTPUT, "utf8");
        await writeFile(input.logPaths.stderr, "", "utf8");
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      },
    };
    await expect(
      runReviewerAgent({ runsDir, runId, codexRunner: runner }),
    ).rejects.toThrow(/modified run artifact/);
  });

  // A runner that mutates `targetFile` mid-run, then returns the given
  // exit code / timeout. Used to prove tamper detection runs before the
  // exit-code / timeout gates.
  function tamperingRunner(
    targetFile: string,
    opts: { exitCode?: number; timedOut?: boolean } = {},
  ): CodexExecRunner {
    return {
      async run(input) {
        const { writeFileSync, utimesSync } = await import("node:fs");
        writeFileSync(targetFile, "tampered\n");
        const now = new Date();
        utimesSync(targetFile, now, new Date(now.getTime() + 5000));
        const { writeFile } = await import("node:fs/promises");
        await writeFile(input.logPaths.stdout, APPROVED_OUTPUT, "utf8");
        await writeFile(input.logPaths.stderr, "", "utf8");
        return {
          exitCode: opts.exitCode ?? 0,
          timedOut: opts.timedOut ?? false,
          durationMs: 0,
        };
      },
    };
  }

  it("detects tampering even when codex then exits non-zero", async () => {
    const { runsDir, runId } = setup();
    const summary = join(runsDir, runId, "summary.md");
    writeFileSync(summary, "original\n");
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        codexRunner: tamperingRunner(summary, { exitCode: 3 }),
      }),
    ).rejects.toThrow(/modified run artifact/);
  });

  it("detects tampering even when codex then times out", async () => {
    const { runsDir, runId } = setup();
    const summary = join(runsDir, runId, "summary.md");
    writeFileSync(summary, "original\n");
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        codexRunner: tamperingRunner(summary, {
          exitCode: -1,
          timedOut: true,
        }),
      }),
    ).rejects.toThrow(/modified run artifact/);
  });

  it("detects tampering of a file in a subdirectory (commands/)", async () => {
    const { runsDir, runId } = setup();
    const cmdDir = join(runsDir, runId, "commands");
    mkdirSync(cmdDir, { recursive: true });
    const cmdLog = join(cmdDir, "cmd-0.out.log");
    writeFileSync(cmdLog, "original command output\n");
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        codexRunner: tamperingRunner(cmdLog),
      }),
    ).rejects.toThrow(/modified run artifact: commands\/cmd-0\.out\.log/);
  });

  it("detects tampering of review-decision.yaml itself (codex must not write it)", async () => {
    const { runsDir, runId } = setup();
    const decisionFile = join(runsDir, runId, "review-decision.yaml");
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        codexRunner: tamperingRunner(decisionFile),
      }),
    ).rejects.toThrow(/modified run artifact: review-decision\.yaml/);
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

  it("rejects an already-decided run with a no-op message (#77 disambiguation)", async () => {
    const { runsDir, runId } = setup({ status: "approved" });
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
      }),
    ).rejects.toThrow(/no re-review is needed/i);
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

  it("result includes dryRun=false on a normal run", async () => {
    const { runsDir, runId } = setup();
    const r = await runReviewerAgent({
      runsDir,
      runId,
      codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
    });
    expect(r.dryRun).toBe(false);
  });

  it("stores the sha256 of the exact prompt sent to codex", async () => {
    const { runsDir, runId } = setup();
    const dbPath = setupReviewDb(runId);
    const seen: { prompt?: string } = {};

    await runReviewerAgent({
      runsDir,
      runId,
      dbPath,
      codexRunner: capturingRunner(APPROVED_OUTPUT, seen),
      now: new Date("2026-05-21T01:00:00.000Z"),
    });

    expect(seen.prompt).toBe(PROMPT_PREAMBLE);
    const expectedPromptSha = createHash("sha256")
      .update(seen.prompt ?? "")
      .digest("hex");
    const db = openDb(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT prompt_sha256, prompt_provenance_json
             FROM review_proposals WHERE run_id = ?`,
        )
        .get(runId) as {
        prompt_sha256: string | null;
        prompt_provenance_json: string | null;
      };
      expect(row.prompt_sha256).toBe(expectedPromptSha);
      expect(JSON.parse(row.prompt_provenance_json ?? "")).toEqual({
        template: REVIEWER_PROMPT_TEMPLATE,
        knowledge: [],
      });
    } finally {
      db.close();
    }
  });

  it("records an empty knowledge provenance list when no operational knowledge is injected", async () => {
    const { runsDir, runId } = setup();
    const dbPath = setupReviewDb(runId);

    await runReviewerAgent({
      runsDir,
      runId,
      dbPath,
      codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
      now: new Date("2026-05-21T01:00:00.000Z"),
    });

    const db = openDb(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT prompt_provenance_json
             FROM review_proposals WHERE run_id = ?`,
        )
        .get(runId) as { prompt_provenance_json: string | null };
      expect(JSON.parse(row.prompt_provenance_json ?? "")).toMatchObject({
        knowledge: [],
      });
    } finally {
      db.close();
    }
  });

  describe("--allow-overwrite gate", () => {
    it("refuses to overwrite a non-pending decision by default", async () => {
      const { runsDir, runId } = setup({ decision: "approved" });
      await expect(
        runReviewerAgent({
          runsDir,
          runId,
          codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
        }),
      ).rejects.toThrow(/already has decision="approved".*--allow-overwrite/s);
    });

    it("overwrites a non-pending decision when allowOverwrite is set", async () => {
      const { runsDir, runId } = setup({ decision: "changes_requested" });
      const r = await runReviewerAgent({
        runsDir,
        runId,
        allowOverwrite: true,
        codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
      });
      expect(r.decision).toBe("approved");
      const yaml = readFileSync(
        join(runsDir, runId, "review-decision.yaml"),
        "utf8",
      );
      expect(yaml).toMatch(/decision: approved/);
    });

    it("the overwrite gate runs BEFORE codex (no codex call when refused)", async () => {
      const { runsDir, runId } = setup({ decision: "rejected" });
      let codexCalled = false;
      const runner: CodexExecRunner = {
        async run(input) {
          codexCalled = true;
          const { writeFile } = await import("node:fs/promises");
          await writeFile(input.logPaths.stdout, APPROVED_OUTPUT, "utf8");
          await writeFile(input.logPaths.stderr, "", "utf8");
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      };
      await expect(
        runReviewerAgent({ runsDir, runId, codexRunner: runner }),
      ).rejects.toThrow(/--allow-overwrite/);
      expect(codexCalled).toBe(false);
    });

    it("a pending decision is overwritten without --allow-overwrite", async () => {
      const { runsDir, runId } = setup({ decision: "pending" });
      const r = await runReviewerAgent({
        runsDir,
        runId,
        codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
      });
      expect(r.decision).toBe("approved");
    });
  });

  describe("--dry-run", () => {
    it("validates output but does NOT write review-decision.yaml", async () => {
      const { runsDir, runId } = setup();
      const before = readFileSync(
        join(runsDir, runId, "review-decision.yaml"),
        "utf8",
      );
      const r = await runReviewerAgent({
        runsDir,
        runId,
        dryRun: true,
        codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
      });
      expect(r.dryRun).toBe(true);
      expect(r.decision).toBe("approved");
      const after = readFileSync(
        join(runsDir, runId, "review-decision.yaml"),
        "utf8",
      );
      expect(after).toBe(before); // unchanged
    });

    it("dry-run still rejects invalid output and writes NO error artifact", async () => {
      const { runsDir, runId } = setup();
      const runner = fakeRunnerWithOutput(
        "```yaml\ndecision: maybe\nrequired_changes: []\nnon_blocking_comments: []\nout_of_scope_suggestions: []\n```",
      );
      await expect(
        runReviewerAgent({ runsDir, runId, dryRun: true, codexRunner: runner }),
      ).rejects.toThrow(/decision/);
      expect(
        existsSync(join(runsDir, runId, "review-auto-error.json")),
      ).toBe(false);
    });
  });

  describe("review-auto-error.json artifact", () => {
    it("is written when an active DB proposal appears between probe and insert", async () => {
      const { runsDir, runId } = setup();
      const dbPath = setupReviewDb(runId);
      const runner: CodexExecRunner = {
        async run(input) {
          const db = openDb(dbPath);
          try {
            new ReviewProposalRepository(db).insertProposal({
              runId,
              reviewer: "codex-reviewer",
              decision: "approved",
              requiredChanges: [],
              nonBlockingComments: [],
              outOfScopeSuggestions: [],
              reviewedAt: "2026-05-21T00:30:00.000Z",
              sourceYaml: "decision: approved\n",
              sourceSha256: "conflict",
              createdAt: "2026-05-21T00:30:00.000Z",
            });
          } finally {
            db.close();
          }
          const { writeFile } = await import("node:fs/promises");
          await writeFile(input.logPaths.stdout, APPROVED_OUTPUT, "utf8");
          await writeFile(input.logPaths.stderr, "", "utf8");
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      };

      await expect(
        runReviewerAgent({
          runsDir,
          runId,
          dbPath,
          codexRunner: runner,
          now: new Date("2026-05-21T01:00:00.000Z"),
        }),
      ).rejects.toThrow(/active proposal|supersede|競合/);

      const errPath = join(runsDir, runId, "review-auto-error.json");
      expect(existsSync(errPath)).toBe(true);
      const err = JSON.parse(readFileSync(errPath, "utf8"));
      expect(err.type).toBe("review-auto-error");
      expect(err.runId).toBe(runId);
      expect(err.reason).toMatch(/active proposal|supersede|競合/);

      const db = openDb(dbPath);
      try {
        const active = new ReviewProposalRepository(db).getLatestActiveProposal(
          runId,
        );
        expect(active?.sourceSha256).toBe("conflict");
        expect(active?.supersededAt).toBeNull();
        expect(
          (
            db
              .prepare(
                "SELECT count(*) AS n FROM review_proposals WHERE run_id = ?",
              )
              .get(runId) as { n: number }
          ).n,
        ).toBe(1);
      } finally {
        db.close();
      }
    });

    it("is written when codex output cannot be parsed (invalid decision)", async () => {
      const { runsDir, runId } = setup();
      const runner = fakeRunnerWithOutput(
        "```yaml\ndecision: maybe\nrequired_changes: []\nnon_blocking_comments: []\nout_of_scope_suggestions: []\n```",
      );
      await expect(
        runReviewerAgent({ runsDir, runId, codexRunner: runner }),
      ).rejects.toThrow(/decision/);
      const errPath = join(runsDir, runId, "review-auto-error.json");
      expect(existsSync(errPath)).toBe(true);
      const err = JSON.parse(readFileSync(errPath, "utf8"));
      expect(err.type).toBe("review-auto-error");
      expect(err.runId).toBe(runId);
      expect(err.reason).toMatch(/decision/);
      expect(err.codexExitCode).toBe(0);
    });

    it("review-decision.yaml is left intact when output is invalid", async () => {
      const { runsDir, runId } = setup();
      const before = readFileSync(
        join(runsDir, runId, "review-decision.yaml"),
        "utf8",
      );
      const runner = fakeRunnerWithOutput("not yaml at all, just prose");
      await expect(
        runReviewerAgent({ runsDir, runId, codexRunner: runner }),
      ).rejects.toThrow();
      const after = readFileSync(
        join(runsDir, runId, "review-decision.yaml"),
        "utf8",
      );
      expect(after).toBe(before);
    });

    it("a stale error artifact is cleared on a subsequent successful run", async () => {
      const { runsDir, runId } = setup();
      const errPath = join(runsDir, runId, "review-auto-error.json");
      // first run: invalid output → error artifact written
      await expect(
        runReviewerAgent({
          runsDir,
          runId,
          codexRunner: fakeRunnerWithOutput("```yaml\ndecision: maybe\n```"),
        }),
      ).rejects.toThrow();
      expect(existsSync(errPath)).toBe(true);
      // second run: valid output → artifact cleared
      await runReviewerAgent({
        runsDir,
        runId,
        codexRunner: fakeRunnerWithOutput(APPROVED_OUTPUT),
      });
      expect(existsSync(errPath)).toBe(false);
    });
  });
});
