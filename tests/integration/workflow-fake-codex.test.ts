import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { parse as parseYaml } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDomainCoding } from "../../src/core/workflow-runner.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";
import type { CodexExecRunner } from "../../src/codex/codex-exec-runner.js";
import { readArtifactBlob } from "../../src/db/artifact-blobs.js";
import { openDb } from "../../src/db/connection.js";
import { SCHEMA_VERSION } from "../../src/db/schema.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version: string };

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-target-"));
  const g = (a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(
    join(repo, "apps/user/src/profile.ts"),
    "export const x = 0;\n",
  );
  // a tracked file in the repo root — outside any domain write scope.
  // Used to test that a post-command modification of a tracked file
  // outside scope is caught.
  writeFileSync(join(repo, "README.md"), "# target repo\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return repo;
}

function setupHarness(opts?: { ignoreUntracked?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "harness-root-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  const ignoreBlock =
    opts?.ignoreUntracked && opts.ignoreUntracked.length > 0
      ? `ignore_untracked:\n${opts.ignoreUntracked.map((p) => `  - ${p}`).join("\n")}\n`
      : "";
  writeFileSync(
    join(root, "policies/global.yaml"),
    `always_deny_write:\n  - .git/**\n  - package.json\n${ignoreBlock}`,
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

type WorkflowEvent = { type: string; [key: string]: unknown };

function parseEvents(runDir: string): WorkflowEvent[] {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as WorkflowEvent);
}

function expectNonNegativeNumber(value: unknown): void {
  expect(typeof value).toBe("number");
  expect(value).toBeGreaterThanOrEqual(0);
}

function secretEventsRunner(secret: string): CodexExecRunner {
  return {
    async run(input) {
      writeFileSync(
        join(input.worktreePath, "apps/user/src/profile.ts"),
        "export const x = 4;\n",
      );
      writeFileSync(input.logPaths.stdout, "done\n", "utf8");
      writeFileSync(input.logPaths.stderr, "", "utf8");
      writeFileSync(
        input.logPaths.events,
        [
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "command_execution",
              aggregated_output: `leaked ${secret}\n`,
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          }),
          "",
        ].join("\n"),
        "utf8",
      );
      return { exitCode: 0, timedOut: false, durationMs: 10 };
    },
  };
}

function dbArtifactText(
  dbPath: string,
  runId: string,
  relativePath: string,
): string | null {
  const db = openDb(dbPath);
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

describe("runDomainCoding (fake codex)", () => {
  let repoPath: string;
  let harness: string;
  beforeEach(() => {
    repoPath = setupRepo();
    harness = setupHarness();
  });

  it("ends a healthy run at needs_review + safetyStatus=allowed with full artifact set", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1; // edited\n",
        );
        writeFileSync(
          join(cwd, "apps/user/src/new.ts"),
          "export const n = 1;\n",
        );
      },
      stdout: "applied 2 files\n",
      stderr: "warning: nothing\n",
      durationMs: 1234,
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: runner,
      codexBinaryVersion: "fake-codex 0.0.25",
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");
    const runDir = join(harness, "runs", r.runId);
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    expect(existsSync(join(runDir, "final-diff.patch"))).toBe(true);
    expect(existsSync(join(runDir, "untracked-files.patch"))).toBe(true);
    expect(existsSync(join(runDir, "untracked-files.txt"))).toBe(true);
    expect(existsSync(join(runDir, "knowledge-candidates.yaml"))).toBe(true);
    expect(existsSync(join(runDir, "review-request.md"))).toBe(true);
    expect(existsSync(join(runDir, "review-decision.yaml"))).toBe(true);
    expect(readFileSync(join(runDir, "final-diff.patch"), "utf8")).toMatch(
      /\+export const x = 1;/,
    );
    expect(readFileSync(join(runDir, "untracked-files.patch"), "utf8")).toMatch(
      /\+export const n = 1;/,
    );
    const summary = readFileSync(join(runDir, "summary.md"), "utf8");
    expect(summary).toMatch(/applied 2 files/);
    expect(summary).toMatch(/warning: nothing/);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.safetyStatus).toBe("allowed");
    const events = parseEvents(runDir);
    const codexCompleted = events.find(
      (event) => event.type === "codex_exec_completed",
    );
    expect(codexCompleted).toBeDefined();
    expect(codexCompleted?.durationMs).toBe(1234);
    const validationCompleted = events.find(
      (event) => event.type === "policy_validation_completed",
    );
    expect(validationCompleted).toBeDefined();
    expectNonNegativeNumber(validationCompleted?.durationMs);
    const diffCollected = events.find(
      (event) => event.type === "diff_collected",
    );
    expect(diffCollected).toBeDefined();
    expectNonNegativeNumber(diffCollected?.durationMs);
    const artifactsIngested = events.find(
      (event) => event.type === "artifacts_ingested",
    );
    const artifactsIngestedIndex = events.findIndex(
      (event) => event.type === "artifacts_ingested",
    );
    const runCompletedIndex = events.findIndex(
      (event) => event.type === "run_completed",
    );
    expect(artifactsIngested).toBeDefined();
    expect(artifactsIngestedIndex).toBeGreaterThanOrEqual(0);
    expect(runCompletedIndex).toBeGreaterThan(artifactsIngestedIndex);
    expect(typeof artifactsIngested?.count).toBe("number");
    expect(artifactsIngested?.count).toBeGreaterThanOrEqual(1);
    expect(typeof artifactsIngested?.totalBytes).toBe("number");
    expect(artifactsIngested?.totalBytes).toBeGreaterThan(0);
    expectNonNegativeNumber(artifactsIngested?.durationMs);
    const runCompleted = events.find((event) => event.type === "run_completed");
    expect(runCompleted).toBeDefined();
    expectNonNegativeNumber(runCompleted?.runElapsedMs);
    expect(existsSync(join(harness, "workspaces", r.runId, "repo"))).toBe(true);

    const prompt = readFileSync(join(runDir, "codex-prompt.md"), "utf8");
    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const row = db
        .prepare(
          `SELECT harness_version, schema_version_at_run, codex_model,
                  codex_binary_version, prompt_sha256
             FROM runs WHERE run_id = ?`,
        )
        .get(r.runId) as {
        harness_version: string | null;
        schema_version_at_run: number | null;
        codex_model: string | null;
        codex_binary_version: string | null;
        prompt_sha256: string | null;
      };
      expect(row.harness_version).toBe(packageJson.version);
      expect(row.schema_version_at_run).toBe(SCHEMA_VERSION);
      expect(row.codex_model).toBeNull();
      expect(row.codex_binary_version).toBe("fake-codex 0.0.25");
      expect(row.prompt_sha256).toBe(
        createHash("sha256").update(prompt).digest("hex"),
      );
    } finally {
      db.close();
    }
  });

  it("redacts codex JSONL command output before artifact ingest", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const runner: CodexExecRunner = {
      async run(input) {
        expect(input.logPaths.events.endsWith(".codex-events.raw.jsonl")).toBe(
          true,
        );
        writeFileSync(
          join(input.worktreePath, "apps/user/src/profile.ts"),
          "export const x = 1;\n",
        );
        writeFileSync(input.logPaths.stdout, "done\n", "utf8");
        writeFileSync(input.logPaths.stderr, "", "utf8");
        writeFileSync(
          input.logPaths.events,
          [
            JSON.stringify({ type: "thread.started" }),
            "{broken-json",
            JSON.stringify({
              type: "item.completed",
              item: {
                type: "command_execution",
                aggregated_output: `leaked ${secret}\n`,
              },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            }),
            "",
          ].join("\n"),
          "utf8",
        );
        return { exitCode: 0, timedOut: false, durationMs: 10 };
      },
    };

    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "redact events",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    const runDir = join(harness, "runs", r.runId);
    const codexEvents = readFileSync(
      join(runDir, "codex-events.jsonl"),
      "utf8",
    );
    const runEvents = parseEvents(runDir);

    expect(existsSync(join(runDir, ".codex-events.raw.jsonl"))).toBe(false);
    expect(codexEvents).not.toContain(secret);
    expect(codexEvents).toContain("redaction.dropped_line");
    expect(codexEvents).toContain(
      "[redacted: secret-suspect (content:aws-access-key-id)]",
    );
    expect(runEvents).toContainEqual({
      type: "codex_events_redacted",
      redactedCount: 1,
      droppedCount: 1,
    });

    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const artifact = db
        .prepare(
          `SELECT blob_sha256 FROM artifacts
           WHERE run_id = ? AND relative_path = 'codex-events.jsonl'`,
        )
        .get(r.runId) as { blob_sha256: string | null };
      expect(artifact.blob_sha256).not.toBeNull();
      const blob = readArtifactBlob(db, artifact.blob_sha256 ?? "");
      expect(blob?.toString("utf8")).toBe(codexEvents);
      expect(blob?.toString("utf8")).not.toContain(secret);
      const rawArtifact = db
        .prepare(
          `SELECT count(*) AS n FROM artifacts
           WHERE run_id = ? AND relative_path = '.codex-events.raw.jsonl'`,
        )
        .get(r.runId) as { n: number };
      expect(rawArtifact.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("publishes a fail-closed sentinel when redaction publish fails", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const runner = secretEventsRunner(secret);

    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "redaction publish fails",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
      codexEventsIo: {
        async rename(): Promise<void> {
          throw new Error("simulated rename failure");
        },
      },
    });

    expect(r.status).toBe("needs_review");
    const runDir = join(harness, "runs", r.runId);
    const official = readFileSync(join(runDir, "codex-events.jsonl"), "utf8");
    expect(official).toBe(
      `${JSON.stringify({
        type: "redaction.failed",
        reason: "rename_failed",
      })}\n`,
    );
    expect(official).not.toContain(secret);
    expect(existsSync(join(runDir, ".codex-events.raw.jsonl"))).toBe(false);
    expect(existsSync(join(runDir, ".codex-events.redacted.tmp"))).toBe(false);

    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const usage = db
        .prepare(
          `SELECT input_tokens, cached_input_tokens, output_tokens,
                  reasoning_output_tokens, total_tokens, usage_source
             FROM run_usage WHERE run_id = ?`,
        )
        .get(r.runId) as {
        input_tokens: number | null;
        cached_input_tokens: number | null;
        output_tokens: number | null;
        reasoning_output_tokens: number | null;
        total_tokens: number | null;
        usage_source: string;
      };
      expect(usage).toEqual({
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        reasoning_output_tokens: null,
        total_tokens: null,
        usage_source: "unavailable",
      });
      const rawArtifact = db
        .prepare(
          `SELECT count(*) AS n FROM artifacts
           WHERE run_id = ? AND relative_path = '.codex-events.raw.jsonl'`,
        )
        .get(r.runId) as { n: number };
      expect(rawArtifact.n).toBe(0);
      const blob = dbArtifactText(
        join(harness, ".harness", "harness.sqlite"),
        r.runId,
        "codex-events.jsonl",
      );
      expect(blob).toBe(official);
      expect(blob).not.toContain(secret);
    } finally {
      db.close();
    }
  });

  it("keeps raw bytes out of DB blobs when redaction tmp write fails", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "redaction tmp write fails",
      baseBranch: "main",
      codexRunner: secretEventsRunner(secret),
      now: new Date("2026-05-20T00:00:00Z"),
      codexEventsIo: {
        async writeFile(path, content): Promise<void> {
          if (path.endsWith(".codex-events.redacted.tmp")) {
            throw new Error("simulated tmp failure");
          }
          writeFileSync(path, content);
        },
      },
    });

    const official = readFileSync(
      join(harness, "runs", r.runId, "codex-events.jsonl"),
      "utf8",
    );
    expect(official).toBe(
      `${JSON.stringify({
        type: "redaction.failed",
        reason: "write_failed",
      })}\n`,
    );
    expect(official).not.toContain(secret);
    const blob = dbArtifactText(
      join(harness, ".harness", "harness.sqlite"),
      r.runId,
      "codex-events.jsonl",
    );
    expect(blob).toBe(official);
    expect(blob).not.toContain(secret);
  });

  it("leaves no official codex-events artifact when sentinel write fails", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "redaction sentinel write fails",
      baseBranch: "main",
      codexRunner: secretEventsRunner(secret),
      now: new Date("2026-05-20T00:00:00Z"),
      codexEventsIo: {
        async writeFile(): Promise<void> {
          throw new Error("simulated write failure");
        },
      },
    });

    const runDir = join(harness, "runs", r.runId);
    expect(existsSync(join(runDir, "codex-events.jsonl"))).toBe(false);
    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const rows = db
        .prepare(
          `SELECT relative_path FROM artifacts
           WHERE run_id = ?
             AND relative_path IN ('codex-events.jsonl', '.codex-events.raw.jsonl')`,
        )
        .all(r.runId) as { relative_path: string }[];
      expect(rows).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("warns but does not ingest raw bytes when redaction cleanup fails", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let warnings = "";
    let runId = "";
    try {
      const r = await runDomainCoding({
        harnessRoot: harness,
        repoPath,
        repoId: "t",
        domain: "apps/user",
        goal: "redaction cleanup fails",
        baseBranch: "main",
        codexRunner: secretEventsRunner(secret),
        now: new Date("2026-05-20T00:00:00Z"),
        codexEventsIo: {
          async writeFile(path, content): Promise<void> {
            if (path.endsWith(".codex-events.redacted.tmp")) {
              throw new Error("simulated tmp failure");
            }
            writeFileSync(path, content);
          },
          async rm(): Promise<void> {
            throw new Error("simulated cleanup failure");
          },
        },
      });
      runId = r.runId;
      warnings = stderr.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      stderr.mockRestore();
    }

    expect(warnings).toContain(`warning: run ${runId}:`);
    expect(warnings).toContain("could not remove quarantined codex events");
    const official = readFileSync(
      join(harness, "runs", runId, "codex-events.jsonl"),
      "utf8",
    );
    expect(official).not.toContain(secret);
    const blob = dbArtifactText(
      join(harness, ".harness", "harness.sqlite"),
      runId,
      "codex-events.jsonl",
    );
    expect(blob).toBe(official);
    expect(blob).not.toContain(secret);
    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const rawArtifact = db
        .prepare(
          `SELECT count(*) AS n FROM artifacts
           WHERE run_id = ? AND relative_path = '.codex-events.raw.jsonl'`,
        )
        .get(runId) as { n: number };
      expect(rawArtifact.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("records exact codex token usage from codex-events.jsonl", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 2;\n",
        );
      },
      usage: {
        inputTokens: 120,
        cachedInputTokens: 40,
        outputTokens: 35,
        reasoningOutputTokens: 9,
      },
    });

    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "record usage",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });

    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const row = db
        .prepare(
          `SELECT model, input_tokens, cached_input_tokens, output_tokens,
                  reasoning_output_tokens, total_tokens, usage_source
             FROM run_usage WHERE run_id = ?`,
        )
        .get(r.runId) as {
        model: string | null;
        input_tokens: number | null;
        cached_input_tokens: number | null;
        output_tokens: number | null;
        reasoning_output_tokens: number | null;
        total_tokens: number | null;
        usage_source: string;
      };
      expect(row).toEqual({
        model: null,
        input_tokens: 120,
        cached_input_tokens: 40,
        output_tokens: 35,
        reasoning_output_tokens: 9,
        total_tokens: 155,
        usage_source: "exact",
      });
    } finally {
      db.close();
    }
  });

  it("records unavailable usage when the codex events file is missing", async () => {
    const runner: CodexExecRunner = {
      async run(input) {
        writeFileSync(
          join(input.worktreePath, "apps/user/src/profile.ts"),
          "export const x = 3;\n",
        );
        writeFileSync(input.logPaths.stdout, "done\n", "utf8");
        writeFileSync(input.logPaths.stderr, "", "utf8");
        return { exitCode: 0, timedOut: false, durationMs: 10 };
      },
    };

    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "record unavailable usage",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });

    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const row = db
        .prepare(
          `SELECT input_tokens, cached_input_tokens, output_tokens,
                  reasoning_output_tokens, total_tokens, usage_source
             FROM run_usage WHERE run_id = ?`,
        )
        .get(r.runId) as {
        input_tokens: number | null;
        cached_input_tokens: number | null;
        output_tokens: number | null;
        reasoning_output_tokens: number | null;
        total_tokens: number | null;
        usage_source: string;
      };
      expect(row).toEqual({
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        reasoning_output_tokens: null,
        total_tokens: null,
        usage_source: "unavailable",
      });
    } finally {
      db.close();
    }
  });

  it("rejects untracked writes outside the write scope", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, "package.json"), "{}\n");
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-policy-violation");
    expect(r.safetyStatus).toBe("denied");
    const runDir = join(harness, "runs", r.runId);
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /package\.json.*deny_write/,
    );
    expect(existsSync(join(harness, "workspaces", r.runId, "repo"))).toBe(true);
    // Phase 7-4: the violation is recorded in the DB read model
    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const viol = db
        .prepare(
          "SELECT path, rule FROM policy_violations WHERE run_id = ?",
        )
        .all(r.runId) as { path: string; rule: string }[];
      expect(viol).toContainEqual({ path: "package.json", rule: "deny_write" });
    } finally {
      db.close();
    }
  });

  it("Phase 7-3/7-4: a run populates the DB read model", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1;\n",
        );
        writeFileSync(join(cwd, "apps/user/src/new.ts"), "export const n = 1;\n");
      },
      stdout: "ok\n",
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const row = db
        .prepare("SELECT status, source_mode FROM runs WHERE run_id = ?")
        .get(r.runId) as { status: string; source_mode: string };
      expect(row).toEqual({ status: "needs_review", source_mode: "db-first" });

      const events = (
        db
          .prepare("SELECT count(*) AS n FROM run_events WHERE run_id = ?")
          .get(r.runId) as { n: number }
      ).n;
      expect(events).toBeGreaterThan(0);

      const changed = (
        db
          .prepare("SELECT path FROM run_changed_files WHERE run_id = ?")
          .all(r.runId) as { path: string }[]
      ).map((c) => c.path);
      expect(changed).toContain("apps/user/src/new.ts");

      // a healthy, in-scope run has no policy violations
      expect(
        (
          db
            .prepare(
              "SELECT count(*) AS n FROM policy_violations WHERE run_id = ?",
            )
            .get(r.runId) as { n: number }
        ).n,
      ).toBe(0);

      const artifacts = (
        db
          .prepare("SELECT relative_path, kind FROM artifacts WHERE run_id = ?")
          .all(r.runId) as { relative_path: string; kind: string }[]
      );
      expect(artifacts.map((a) => a.relative_path)).toContain("meta.json");
      expect(artifacts.map((a) => a.relative_path)).toContain("summary.md");
      expect(artifacts).toContainEqual({
        relative_path: "codex-events.jsonl",
        kind: "codex-events",
      });

      // Phase 8 (external review P1-2): artifacts are ingested BEFORE the
      // final export, so the artifact bodies are recorded in
      // `exported_files` — `check-consistency` can then detect drift on
      // them, not just on meta.json / events.jsonl.
      const exported = (
        db
          .prepare(
            "SELECT relative_path FROM exported_files WHERE scope_type = 'run' AND scope_id = ?",
          )
          .all(r.runId) as { relative_path: string }[]
      ).map((e) => e.relative_path);
      expect(exported).toContain("summary.md");
    } finally {
      db.close();
    }
  });

  it("ignore_untracked filters .gitignore'd output without making it invisible", async () => {
    harness = setupHarness({ ignoreUntracked: ["dist/**"] });
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        // legit in-scope edit
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 2;\n",
        );
        // throwaway build output: not in scope, but explicitly ignored.
        mkdirSync(join(cwd, "dist"), { recursive: true });
        writeFileSync(join(cwd, "dist/out.js"), "compiled\n");
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    // Without ignore_untracked filter, dist/out.js would be 'not_in_write_scope'
    // and fail the run. With filter, it surfaces in the summary but does NOT
    // block validation.
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");
    expect(r.ignoredUntrackedCount).toBe(1);
    const runDir = join(harness, "runs", r.runId);
    const summary = readFileSync(join(runDir, "summary.md"), "utf8");
    expect(summary).toMatch(/Ignored by ignore_untracked/);
    expect(summary).toMatch(/dist\/out\.js/);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.ignoredUntrackedCount).toBe(1);
  });

  it("captures .gitignored output as a violation when not in ignore_untracked", async () => {
    // ensure target repo has a .gitignore covering dist/
    writeFileSync(join(repoPath, ".gitignore"), "dist/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: repoPath });
    execFileSync("git", ["commit", "-qm", "ignore"], { cwd: repoPath });

    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        mkdirSync(join(cwd, "dist"), { recursive: true });
        writeFileSync(join(cwd, "dist/out.js"), "compiled\n");
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-policy-violation");
    expect(r.safetyStatus).toBe("denied");
  });

  it("flags codex timeout as failed-codex-timeout but still records policy denied (orthogonal)", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        // touch a deny_write path AND timeout — both should surface
        writeFileSync(join(cwd, "package.json"), "{}\n");
      },
      timedOut: true,
      exitCode: -1,
      stdout: "partial work\n",
      stderr: "killed by SIGKILL\n",
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-codex-timeout");
    expect(r.safetyStatus).toBe("denied");
    const runDir = join(harness, "runs", r.runId);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("failed-codex-timeout");
    expect(meta.safetyStatus).toBe("denied");
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(/TIMEOUT/);
    expect(readFileSync(join(runDir, "review-request.md"), "utf8")).toMatch(
      /killed by SIGKILL/,
    );
  });

  it("never writes denied untracked content into artifacts (security boundary)", async () => {
    // Codex drops a .env-like file at the repo root. This is out of scope
    // (apps/user/** is the write scope) AND likely contains secrets.
    // The path should appear in violations + untracked-denied.txt but the
    // content (SECRET=hunter2) must never land in any artifact.
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, ".env"), "SECRET=hunter2\n");
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-policy-violation");
    expect(r.safetyStatus).toBe("denied");
    const runDir = join(harness, "runs", r.runId);
    // untracked-files.patch should NOT exist (no allowed untracked) OR
    // must not contain the secret.
    const utPatchPath = join(runDir, "untracked-files.patch");
    if (existsSync(utPatchPath)) {
      expect(readFileSync(utPatchPath, "utf8")).not.toMatch(/hunter2/);
    }
    // untracked-denied.txt should exist and reference the path with sha256
    // but NOT include the bytes.
    const deniedPath = join(runDir, "untracked-denied.txt");
    expect(existsSync(deniedPath)).toBe(true);
    const denied = readFileSync(deniedPath, "utf8");
    expect(denied).not.toMatch(/hunter2/);
    expect(denied).toMatch(/\.env\s+size=\d+\s+sha256=[0-9a-f]{64}/);
    // summary still surfaces the violation
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /\.env.*not_in_write_scope/,
    );
  });

  it("never follows symlinks when generating untracked artifacts", async () => {
    const outside = mkdtempSync(join(tmpdir(), "harness-secret-"));
    writeFileSync(join(outside, "secret"), "SUPERSECRET\n");
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        // in-scope path that symlinks out of the repo entirely
        symlinkSync(join(outside, "secret"), join(cwd, "apps/user/leak.ts"));
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    // Path is in scope, so policy allows it — but content must NOT have
    // been read across the symlink.
    expect(r.safetyStatus).toBe("allowed");
    const runDir = join(harness, "runs", r.runId);
    const utPatch = readFileSync(
      join(runDir, "untracked-files.patch"),
      "utf8",
    );
    expect(utPatch).not.toMatch(/SUPERSECRET/);
    expect(utPatch).toMatch(/@@ symlink @@/);
  });

  it("writes resolved-policy.yaml as actual YAML", async () => {
    const runner = createFakeCodexRunner({ edit: async () => {} });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    const runDir = join(harness, "runs", r.runId);
    const raw = readFileSync(join(runDir, "resolved-policy.yaml"), "utf8");
    expect(raw.trimStart().startsWith("{")).toBe(false);
    const parsed = parseYaml(raw) as { domain: string; codex: { sandbox: string } };
    expect(parsed.domain).toBe("apps/user");
    expect(parsed.codex.sandbox).toBe("workspace-write");
  });

  it("redacts secret-shaped untracked files even when path policy allows them", async () => {
    // apps/user/** is the allowed write scope, so policy alone would let
    // .env.local through. The secret scanner must keep its content out
    // of artifacts anyway, and surface the count.
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1;\n",
        );
        writeFileSync(
          join(cwd, "apps/user/.env.local"),
          "DB_URL=postgres://user:hunter2@host/db\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");
    expect(r.secretSuspectCount).toBe(1);
    const runDir = join(harness, "runs", r.runId);
    const untrackedPatch = readFileSync(
      join(runDir, "untracked-files.patch"),
      "utf8",
    );
    expect(untrackedPatch).not.toMatch(/hunter2/);
    expect(untrackedPatch).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(untrackedPatch).toMatch(/@@ secret-suspect/);
    // Index artifact lists the suspect with its trigger reasons.
    const secretsList = readFileSync(
      join(runDir, "untracked-secrets.txt"),
      "utf8",
    );
    expect(secretsList).toMatch(/apps\/user\/\.env\.local/);
    expect(secretsList).toMatch(/filename:\.env/);
    expect(secretsList).toMatch(/content:aws-access-key-id/);
    // Review surfaces flag it prominently.
    expect(readFileSync(join(runDir, "review-request.md"), "utf8")).toMatch(
      /Secret-shaped files/,
    );
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.secretSuspectCount).toBe(1);
  });

  it("finalizes meta as failed-internal-error when codex runner throws after createRunLog", async () => {
    // simulate an unexpected runner-level crash (not a normal non-zero exit).
    const exploder = {
      async run(): Promise<never> {
        throw new Error("runner exploded");
      },
    };
    await expect(
      runDomainCoding({
        harnessRoot: harness,
        repoPath,
        repoId: "t",
        domain: "apps/user",
        goal: "x",
        baseBranch: "main",
        codexRunner: exploder,
        now: new Date("2026-05-20T00:00:00Z"),
      }),
    ).rejects.toThrow(/runner exploded/);
    // find the orphaned run dir (createRunLog succeeded before the throw)
    const { readdirSync } = await import("node:fs");
    const runDirs = readdirSync(join(harness, "runs"));
    expect(runDirs.length).toBe(1);
    const meta = JSON.parse(
      readFileSync(join(harness, "runs", runDirs[0]!, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("failed-internal-error");
    expect(meta.safetyStatus).toBe("skipped");
    expect(meta.finishedAt).toBeDefined();
  });

  it("runs allowedCommands on a clean diff and stays needs_review if they pass", async () => {
    // override harness with a policy that runs `true` after the diff
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write:\n  - package.json\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        '        - "true"',
        '        - "echo ok"',
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 9;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    expect(r.commandResults).toHaveLength(2);
    expect(r.commandResults.every((c) => c.exitCode === 0)).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(root, "runs", r.runId, "meta.json"), "utf8"),
    );
    expect(meta.commandResults).toHaveLength(2);
  });

  it("re-validates after commands: a command that writes outside scope → failed-policy-violation", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write:\n  - apps/orders/**\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        '        - "mkdir -p apps/orders/src && echo bad > apps/orders/src/leak.ts"',
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 7;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    // The malicious command exits 0 but writes outside scope. Post-validation
    // catches it.
    expect(r.status).toBe("failed-policy-violation");
    expect(r.safetyStatus).toBe("denied");
  });

  it("flips to failed-command when an allowed command fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        '        - "false"',
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 8;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-command");
    expect(r.commandResults[0]?.exitCode).not.toBe(0);
  });

  it("T1: post-command ignored untracked is counted (F8 extension)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      'always_deny_write: []\nignore_untracked:\n  - "**/cache/**"\n',
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
        "    commands:",
        "      allow:",
        '        - "mkdir -p apps/user/cache && echo x > apps/user/cache/file.tmp"',
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-21T00:00:00Z"),
    });
    // command created cache/file.tmp AFTER codex; ignore_untracked filter
    // catches it on the post-command re-collect.
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");
    expect(r.ignoredUntrackedCount).toBe(1);
    const meta = JSON.parse(
      readFileSync(join(root, "runs", r.runId, "meta.json"), "utf8"),
    );
    expect(meta.ignoredUntrackedCount).toBe(1);
  });

  it("T2: post-command secret-shaped file is detected (F8 extension)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        '        - "echo API_TOKEN=sk-test-abc > apps/user/.env.local"',
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 2;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-21T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");
    expect(r.secretSuspectCount).toBe(1);
    const runDir = join(root, "runs", r.runId);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.secretSuspectCount).toBe(1);
    const patch = readFileSync(join(runDir, "untracked-files.patch"), "utf8");
    expect(patch).not.toMatch(/sk-test-abc/);
    expect(patch).toMatch(/@@ secret-suspect/);
  });

  it("T3: post-command symlink is not followed (F8 extension)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "harness-secret-"));
    writeFileSync(join(outside, "secret.txt"), "EXTERNAL_VALUE\n");
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        `        - "ln -s ${outside}/secret.txt apps/user/src/link.ts"`,
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 3;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-21T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");
    const runDir = join(root, "runs", r.runId);
    const patch = readFileSync(join(runDir, "untracked-files.patch"), "utf8");
    expect(patch).toMatch(/@@ symlink @@/);
    expect(patch).not.toMatch(/EXTERNAL_VALUE/);
  });

  it("T4: post-command huge untracked file → content omitted + sha256", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        // 300 KB file — over the 256 KB MAX_FILE_BYTES limit
        // 300 KB of 'a' (no newlines), generated via node for a
        // deterministic, environment-independent size.
        `        - id: make-huge
          cmd: node
          args: ["-e", "require('fs').writeFileSync('apps/user/src/big.txt','a'.repeat(307200))"]`,
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 4;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-21T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    const patch = readFileSync(
      join(root, "runs", r.runId, "untracked-files.patch"),
      "utf8",
    );
    expect(patch).toMatch(
      /@@ omitted \(size=307200 bytes, sha256=[0-9a-f]{64}\) @@/,
    );
    // the 300 KB of content must not be inlined — the whole patch stays small
    expect(patch.length).toBeLessThan(4000);
  });

  it("T5: post-command binary untracked file → content omitted (binary)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        // write NUL bytes via node — unambiguous binary, environment-independent
        `        - id: make-binary
          cmd: node
          args: ["-e", "require('fs').writeFileSync('apps/user/src/blob.bin',Buffer.from([80,78,71,0,1,2,3,4,5]))"]`,
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 5;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-21T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    const patch = readFileSync(
      join(root, "runs", r.runId, "untracked-files.patch"),
      "utf8",
    );
    expect(patch).toMatch(/@@ omitted \(binary,/);
  });

  it("T6: events.jsonl carries stage=post-command after commands run", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        '        - "true"',
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 6;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-21T00:00:00Z"),
    });
    const events = readFileSync(
      join(root, "runs", r.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // post-codex validation, then post-command validation
    const validations = events.filter(
      (e) => e.type === "policy_validation_completed",
    );
    expect(validations.map((e) => e.stage)).toEqual([
      "post-codex",
      "post-command",
    ]);
    // the final diff_collected reflects the post-command worktree
    const diffCollected = events.find((e) => e.type === "diff_collected");
    expect(diffCollected?.stage).toBe("post-command");
  });

  it("T7: post-command modification of a TRACKED file outside scope → failed-policy-violation", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    mkdirSync(join(root, "policies/repos"), { recursive: true });
    writeFileSync(
      join(root, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
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
        "    commands:",
        "      allow:",
        // mutate a file that is tracked but outside the write scope
        '        - "echo tampered >> README.md"',
        "",
      ].join("\n"),
    );
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 7;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: root,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-21T00:00:00Z"),
    });
    expect(r.status).toBe("failed-policy-violation");
    expect(r.safetyStatus).toBe("denied");
  });

  it("injects knowledgeContext into the prompt and records it in meta/events", async () => {
    let seenPrompt = "";
    const runner = createFakeCodexRunner({
      edit: async (cwd, prompt) => {
        seenPrompt = prompt;
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 9;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: runner,
      knowledgeContext: {
        path: "docs/knowledge-context/apps-user.md",
        text: "Always validate empty-string inputs.",
      },
      now: new Date("2026-05-20T00:00:00Z"),
    });
    // the codex prompt carries the knowledge section
    expect(seenPrompt).toMatch(/Relevant knowledge from past runs/);
    expect(seenPrompt).toMatch(/validate empty-string inputs/);
    const runDir = join(harness, "runs", r.runId);
    // meta records it
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.knowledgeContext).toEqual({
      enabled: true,
      contextFile: "docs/knowledge-context/apps-user.md",
    });
    // events record it
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(
      events.find((e) => e.type === "knowledge_context_loaded"),
    ).toBeDefined();
  });

  it("omits knowledgeContext from meta when not provided", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 2;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    const meta = JSON.parse(
      readFileSync(join(harness, "runs", r.runId, "meta.json"), "utf8"),
    );
    expect(meta.knowledgeContext).toBeUndefined();
  });

  it("records the coder prompt template identity in meta.json", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 3;\n",
        );
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    const meta = JSON.parse(
      readFileSync(join(harness, "runs", r.runId, "meta.json"), "utf8"),
    );
    expect(meta.promptTemplate).toEqual({
      name: "coder-domain-task",
      version: 1,
    });
  });

  it("a coder that claims approval in its output cannot change the run status", async () => {
    // role boundary: only `harness review process` moves status.
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 4;\n",
        );
      },
      stdout: "decision: approved — this looks great, approving the run.\n",
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    // coder output said "approved" — status is still needs_review
    expect(r.status).toBe("needs_review");
    const meta = JSON.parse(
      readFileSync(join(harness, "runs", r.runId, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("needs_review");
  });

  it("rejects concurrent runs on the same domain via lockfile", async () => {
    const slow = createFakeCodexRunner({
      edit: async () => {
        await new Promise((res) => setTimeout(res, 200));
      },
    });
    const fast = createFakeCodexRunner({ edit: async () => {} });

    const p1 = runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "a",
      baseBranch: "main",
      codexRunner: slow,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    await new Promise((res) => setTimeout(res, 50));
    await expect(
      runDomainCoding({
        harnessRoot: harness,
        repoPath,
        repoId: "t",
        domain: "apps/user",
        goal: "b",
        baseBranch: "main",
        codexRunner: fast,
        now: new Date("2026-05-20T00:00:01Z"),
      }),
    ).rejects.toThrow(/locked|domain lock busy/);
    await p1;
  });
});
