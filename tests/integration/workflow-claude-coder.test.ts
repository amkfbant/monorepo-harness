import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runDomainCoding } from "../../src/core/workflow-runner.js";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "../../src/codex/codex-exec-runner.js";
import { openDb } from "../../src/db/connection.js";

// A high-entropy token that secret-scan flags; the codex redactor would pass it
// through (no `.item`), so its absence proves the claude redactor was wired.
const SECRET = "AKIAIOSFODNN7EXAMPLE";

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-claude-target-"));
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
  const root = mkdtempSync(join(tmpdir(), "harness-claude-root-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  writeFileSync(
    join(root, "policies/global.yaml"),
    "always_deny_write:\n  - .git/**\n  - package.json\n",
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

/**
 * Fake claude `-p` runner: writes the claude stream-json envelope to the events
 * file (incl. a secret in a tool_result), the final message to stdout, and
 * performs the worktree edit — satisfying CodexExecRunner like the real one.
 */
function createFakeClaudeRunner(): CodexExecRunner {
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      writeFileSync(
        join(input.worktreePath, "apps/user/src/profile.ts"),
        "export const x = 1; // edited by claude\n",
      );
      const events =
        [
          JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" }),
          JSON.stringify({
            type: "assistant",
            message: {
              id: "m1",
              model: "claude-opus-4-8",
              usage: {
                input_tokens: 5,
                output_tokens: 10,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 2,
              },
            },
          }),
          JSON.stringify({
            type: "user",
            message: {
              content: [
                { type: "tool_result", is_error: false, content: `leaked ${SECRET}` },
              ],
            },
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            result: "applied the edit",
            usage: { input_tokens: 5, output_tokens: 10 },
          }),
        ].join("\n") + "\n";
      await mkdir(dirname(input.logPaths.events), { recursive: true });
      await writeFile(input.logPaths.events, events);
      await writeFile(input.logPaths.stdout, "applied the edit");
      await writeFile(input.logPaths.stderr, "");
      return { exitCode: 0, timedOut: false, durationMs: 42 };
    },
  };
}

describe("runDomainCoding — claude coder backend (#191 wiring)", () => {
  let repoPath: string;
  let harness: string;
  beforeEach(() => {
    vi.stubEnv("HARNESS_CODER_BACKEND", "claude");
    vi.stubEnv("HARNESS_CLAUDE_MODEL", "");
    repoPath = setupRepo();
    harness = setupHarness();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records the coder usage as tool='claude', redacts the events with the claude redactor, and lands a healthy run", async () => {
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: createFakeClaudeRunner(),
      codexBinaryVersion: "fake-claude",
      now: new Date("2026-06-21T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");

    const runDir = join(harness, "runs", r.runId);
    // The claude redactor ran: the secret echoed in the tool_result is gone from
    // the PUBLISHED events (the codex redactor would have passed it through).
    const published = readFileSync(join(runDir, "codex-events.jsonl"), "utf8");
    expect(published).not.toContain(SECRET);
    expect(published).toContain("[redacted:");

    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const inv = db
        .prepare(
          "SELECT tool, role, usage_source FROM agent_invocation WHERE run_id = ?",
        )
        .get(r.runId) as { tool: string; role: string; usage_source: string };
      expect(inv.tool).toBe("claude");
      expect(inv.role).toBe("coder");
      expect(inv.usage_source).toBe("exact");
      const turn = db
        .prepare(
          `SELECT input_tokens, output_tokens, cache_read_input_tokens,
                  cached_input_tokens, reasoning_output_tokens
             FROM agent_usage_turn t
             JOIN agent_invocation i ON i.invocation_id = t.invocation_id
            WHERE i.run_id = ?`,
        )
        .get(r.runId) as {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cached_input_tokens: number | null;
        reasoning_output_tokens: number | null;
      };
      expect(turn.input_tokens).toBe(5);
      expect(turn.output_tokens).toBe(10);
      expect(turn.cache_read_input_tokens).toBe(3);
      // XOR CHECK: codex-only columns stay NULL on a claude row.
      expect(turn.cached_input_tokens).toBeNull();
      expect(turn.reasoning_output_tokens).toBeNull();
    } finally {
      db.close();
    }

    // No legacy run_usage row for a claude coder (run_usage stays codex-only).
    const db2 = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const n = (
        db2
          .prepare("SELECT COUNT(*) AS n FROM run_usage WHERE run_id = ?")
          .get(r.runId) as { n: number }
      ).n;
      expect(n).toBe(0);
    } finally {
      db2.close();
    }
  });
});
