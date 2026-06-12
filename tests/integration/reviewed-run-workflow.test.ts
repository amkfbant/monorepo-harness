import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewedRunWorkflow } from "../../src/core/reviewed-run-workflow.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";
import { openDb } from "../../src/db/connection.js";
import { readArtifactBlob } from "../../src/db/artifact-blobs.js";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "../../src/codex/codex-exec-runner.js";

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-target-"));
  const g = (a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(join(repo, "apps/user/src/profile.ts"), "export const x = 0;\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return repo;
}

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-root-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  writeFileSync(
    join(root, "policies/global.yaml"),
    "always_deny_write:\n  - .git/**\n  - package.json\nignore_untracked: []\n",
  );
  writeFileSync(
    join(root, "policies/repos/t.yaml"),
    [
      "repo_id: t",
      "read: []",
      "domains:",
      "  apps/user:",
      "    read: [apps/user/**]",
      "    write: [apps/user/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );
  return root;
}

const APPROVED_YAML = [
  "```yaml",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "```",
].join("\n");

const CHANGES_YAML = [
  "```yaml",
  "decision: changes_requested",
  "required_changes:",
  '  - "tighten the validation"',
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "```",
].join("\n");

/** A reviewer runner that emits a different YAML block on each call. */
function sequencedReviewer(outputs: string[]): CodexExecRunner {
  let i = 0;
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      const out = outputs[Math.min(i, outputs.length - 1)] ?? APPROVED_YAML;
      i += 1;
      await writeFile(input.logPaths.stdout, out, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    },
  };
}

function tamperingReviewer(secret: string): CodexExecRunner {
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      await writeFile(input.logPaths.stdout, APPROVED_YAML, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      await writeFile(
        join(input.worktreePath, "summary.md"),
        "# summary\ntampered\n",
        "utf8",
      );
      await writeFile(
        join(input.worktreePath, "reviewer-agent.events.jsonl"),
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            aggregated_output: `leaked ${secret}\n`,
          },
        })}\n`,
        "utf8",
      );
      await writeFile(
        input.logPaths.events,
        '{"type":"turn.completed"}\n',
        "utf8",
      );
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    },
  };
}

interface RunWorkflowOpts {
  coderRunner: CodexExecRunner;
  reviewerRunner: CodexExecRunner;
  maxAttempts?: number;
  noAutoReview?: boolean;
  stopOnChangesRequested?: boolean;
}

function runWf(root: string, repoPath: string, o: RunWorkflowOpts) {
  return runReviewedRunWorkflow({
    harnessRoot: root,
    runsDir: join(root, "runs"),
    locksDir: join(root, "locks"),
    repoPath,
    repoId: "t",
    domain: "apps/user",
    goal: "add validation to the user profile",
    baseBranch: "main",
    coderRunner: o.coderRunner,
    reviewerRunner: o.reviewerRunner,
    maxAttempts: o.maxAttempts ?? 2,
    ...(o.noAutoReview !== undefined ? { noAutoReview: o.noAutoReview } : {}),
    ...(o.stopOnChangesRequested !== undefined
      ? { stopOnChangesRequested: o.stopOnChangesRequested }
      : {}),
  });
}

/** A coder runner that performs an in-scope edit. */
function inScopeCoder(seedValue = 1): CodexExecRunner {
  let v = seedValue;
  return createFakeCodexRunner({
    edit: async (cwd) => {
      writeFileSync(
        join(cwd, "apps/user/src/profile.ts"),
        `export const x = ${v++};\n`,
      );
    },
  });
}

function dbArtifactText(
  root: string,
  runId: string,
  relativePath: string,
): string | null {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    const row = db
      .prepare(
        `SELECT blob_sha256 FROM artifacts
         WHERE run_id = ? AND relative_path = ?`,
      )
      .get(runId, relativePath) as { blob_sha256: string | null } | undefined;
    if (row?.blob_sha256 === undefined || row.blob_sha256 === null) {
      return null;
    }
    return readArtifactBlob(db, row.blob_sha256)?.toString("utf8") ?? null;
  } finally {
    db.close();
  }
}

describe("runReviewedRunWorkflow", () => {
  it("E3-1-1: approved on the first attempt", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    const result = await runWf(root, repoPath, {
      coderRunner: inScopeCoder(),
      reviewerRunner: sequencedReviewer([APPROVED_YAML]),
    });
    expect(result.finalStatus).toBe("approved");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.status).toBe("approved");
    // workflow artifacts written under the root run dir
    const wfJson = JSON.parse(
      readFileSync(
        join(root, "runs", result.rootRunId, "workflow.json"),
        "utf8",
      ),
    );
    expect(wfJson.workflow).toBe("reviewed-run");
    expect(wfJson.finalStatus).toBe("approved");
    expect(
      existsSync(
        join(root, "runs", result.rootRunId, "workflow-summary.md"),
      ),
    ).toBe(true);
  });

  it("E3-1-2: changes_requested → rerun → approved", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    const result = await runWf(root, repoPath, {
      coderRunner: inScopeCoder(),
      reviewerRunner: sequencedReviewer([CHANGES_YAML, APPROVED_YAML]),
    });
    expect(result.finalStatus).toBe("approved");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.status).toBe("changes_requested");
    expect(result.attempts[1]?.status).toBe("approved");
    // the rerun child must carry the chain metadata
    const childMeta = JSON.parse(
      readFileSync(
        join(root, "runs", result.attempts[1]!.runId, "meta.json"),
        "utf8",
      ),
    );
    expect(childMeta.parentRunId).toBe(result.attempts[0]!.runId);
    expect(childMeta.rootRunId).toBe(result.rootRunId);
    expect(childMeta.rerunAttempt).toBe(1);
  });

  it("E3-1-3: not_converged when maxAttempts is exceeded", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    const result = await runWf(root, repoPath, {
      coderRunner: inScopeCoder(),
      reviewerRunner: sequencedReviewer([CHANGES_YAML]), // always cr
      maxAttempts: 1,
    });
    expect(result.finalStatus).toBe("not_converged");
    // attempt 0 (cr) → rerun → attempt 1 (cr) → stop
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.status === "changes_requested")).toBe(
      true,
    );
  });

  it("E3-1-4: stops on a failed-policy-violation run, no rerun", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    // coder writes outside the apps/user write scope
    const badCoder = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, "README.md"), "tampered\n");
      },
    });
    const result = await runWf(root, repoPath, {
      coderRunner: badCoder,
      reviewerRunner: sequencedReviewer([APPROVED_YAML]),
    });
    expect(result.finalStatus).toBe("failed-policy-violation");
    expect(result.attempts).toHaveLength(1);
  });

  it("E3-1-5: review-auto-failed on invalid reviewer output", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    const result = await runWf(root, repoPath, {
      coderRunner: inScopeCoder(),
      reviewerRunner: sequencedReviewer([
        "```yaml\ndecision: maybe\nrequired_changes: []\n" +
          "non_blocking_comments: []\nout_of_scope_suggestions: []\n```",
      ]),
    });
    expect(result.finalStatus).toBe("review-auto-failed");
    expect(
      existsSync(
        join(root, "runs", result.attempts[0]!.runId, "review-auto-error.json"),
      ),
    ).toBe(true);
  });

  it("quarantines reviewer artifacts after tamper before failed-attempt sync", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const root = setupHarness();
    const repoPath = setupRepo();
    const result = await runWf(root, repoPath, {
      coderRunner: inScopeCoder(),
      reviewerRunner: tamperingReviewer(secret),
    });
    const runId = result.attempts[0]!.runId;

    expect(result.finalStatus).toBe("review-auto-failed");
    expect(
      dbArtifactText(root, runId, "reviewer-agent.events.jsonl"),
    ).toBeNull();
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      const leaked = db
        .prepare(
          `SELECT count(*) AS n
             FROM artifact_blob_chunks
            WHERE instr(CAST(content AS TEXT), ?) > 0`,
        )
        .get(secret) as { n: number };
      expect(leaked.n).toBe(0);
      const event = db
        .prepare(
          `SELECT payload_json
             FROM run_events
            WHERE run_id = ? AND type = 'artifacts_quarantined'
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(runId) as { payload_json: string } | undefined;
      expect(event).toBeDefined();
      const payload = JSON.parse(event?.payload_json ?? "{}") as {
        paths?: string[];
      };
      expect(payload.paths).toContain("reviewer-agent.events.jsonl");
    } finally {
      db.close();
    }
  });

  it("--stop-on-changes-requested stops without rerunning", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    const result = await runWf(root, repoPath, {
      coderRunner: inScopeCoder(),
      reviewerRunner: sequencedReviewer([CHANGES_YAML]),
      stopOnChangesRequested: true,
    });
    expect(result.finalStatus).toBe("changes_requested");
    expect(result.attempts).toHaveLength(1);
  });

  it("--no-auto-review stops at needs_review", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    const result = await runWf(root, repoPath, {
      coderRunner: inScopeCoder(),
      reviewerRunner: sequencedReviewer([APPROVED_YAML]),
      noAutoReview: true,
    });
    expect(result.finalStatus).toBe("needs_review");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.status).toBe("needs_review");
  });

  it("records a failed-internal-error run and still writes workflow artifacts", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    // a coder runner that throws after the run dir exists — runDomainCoding
    // finalizes failed-internal-error and rethrows RunFinalizedError.
    const crashingCoder: CodexExecRunner = {
      async run(): Promise<CodexRunResult> {
        throw new Error("simulated codex crash");
      },
    };
    const result = await runWf(root, repoPath, {
      coderRunner: crashingCoder,
      reviewerRunner: sequencedReviewer([APPROVED_YAML]),
    });
    expect(result.finalStatus).toBe("failed-internal-error");
    expect(result.attempts).toHaveLength(1);
    expect(
      existsSync(join(root, "runs", result.rootRunId, "workflow.json")),
    ).toBe(true);
  });

  it("rejects a non-positive maxAttempts", async () => {
    const root = setupHarness();
    const repoPath = setupRepo();
    await expect(
      runWf(root, repoPath, {
        coderRunner: inScopeCoder(),
        reviewerRunner: sequencedReviewer([APPROVED_YAML]),
        maxAttempts: 0,
      }),
    ).rejects.toThrow(/maxAttempts must be a positive integer/);
  });
});
