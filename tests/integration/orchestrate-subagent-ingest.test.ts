/**
 * Integration tests verifying that the orchestrate-tail ingest wiring (#235)
 * fires after course/hitch orchestrate completes and does not gate the exit.
 *
 * Strategy: run course orchestrate via the real CLI, point
 * HARNESS_CLAUDE_PROJECTS_DIR at a temp dir containing a fixture transcript
 * (mtime backdated by 60 s so the settle-guard passes), then query the DB.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { CourseRepository } from "../../src/roadmap/course-repository.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import { PhaseRepository } from "../../src/roadmap/phase-repository.js";
import { subagentUsageSummary } from "../../src/db/repositories/subagent-usage.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

// Two assistant JSONL lines with deterministic token counts.
// NOTE: in-file agentId is "orch" (WITHOUT the agent- prefix) to match real
// Claude Code transcripts (filename agent-orch.jsonl → in-file agentId="orch").
// This ensures path-derived id ("orch") == content-derived id ("orch") so the
// idempotent skip-before-read check works correctly.
const TURN_LINE_A =
  '{"type":"assistant","sessionId":"sess-orch","agentId":"orch","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n';
const TURN_LINE_B =
  '{"type":"assistant","sessionId":"sess-orch","agentId":"orch","message":{"model":"claude-opus-4-8","usage":{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n';

function runCli(
  root: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: {
        ...process.env,
        HARNESS_ROOT: root,
        HARNESS_SUPPRESS_EXPORT_MODE_WARNING: "1",
        ...extraEnv,
      },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

function makeHarnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-orch-ingest-"));
  mkdirSync(root, { recursive: true });
  return root;
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-orch-repo-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.invalid"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(join(repo, "apps/user/src/x.ts"), "export const x = 0;\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "target" }));
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return repo;
}

function setupProjectHarness(root: string, repoPath: string): void {
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(
    join(root, "projects", "demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: t",
      `  path: ${repoPath}`,
      "  package_manager: npm",
      "policy:",
      "  template: strict-monorepo-v1",
      "domains:",
      "  - id: apps/user",
      "    root: apps/user",
      "    kind: app",
      "",
    ].join("\n"),
  );
}

function writeFakeCodexBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-orch-ingest-codex-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      "case \"$*\" in",
      "  *read-only*)",
      "    cat <<'YAML'",
      "decision: approved",
      "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "YAML",
      "    ;;",
      "  *)",
      "    echo 'export const x = 1;' > apps/user/src/x.ts",
      "    echo 'fake codex done'",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

/**
 * Create a temporary Claude project dir holding one fixture transcript.
 * The file mtime is backdated 60 s so the default settle-guard (30 s) passes.
 */
function makeFixtureClaudeProjectDir(): string {
  const cpd = mkdtempSync(join(tmpdir(), "harness-orch-cpd-"));
  const subagentDir = join(cpd, "sess-orch", "subagents");
  mkdirSync(subagentDir, { recursive: true });
  const jsonlPath = join(subagentDir, "agent-orch.jsonl");
  const metaPath = join(subagentDir, "agent-orch.meta.json");
  writeFileSync(jsonlPath, TURN_LINE_A + TURN_LINE_B);
  writeFileSync(metaPath, '{"agentType":"general-purpose"}');
  // Backdate mtime by 60 s so settle-guard (default 30 s) passes.
  const past = new Date(Date.now() - 60_000);
  utimesSync(jsonlPath, past, past);
  utimesSync(metaPath, past, past);
  return cpd;
}

function withDb<T>(root: string, fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function json<T>(result: { out: string; code: number }): T {
  expect(result.code, `expected exit 0, got:\n${result.out}`).toBe(0);
  return JSON.parse(result.out) as T;
}

describe("orchestrate-tail subagent ingest (#235 G6)", () => {
  it("course orchestrate tail ingests claude subagent usage from HARNESS_CLAUDE_PROJECTS_DIR", () => {
    const root = makeHarnessRoot();
    const repoPath = makeRepo();
    setupProjectHarness(root, repoPath);
    const fakeCodexBin = writeFakeCodexBin();
    const cpd = makeFixtureClaudeProjectDir();

    const course = json<{ courseId: string }>(
      runCli(root, [
        "course",
        "create",
        "--title",
        "Ingest Test Course",
        "--project",
        "demo",
        "--json",
      ]),
    );
    const phase = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        course.courseId,
        "--title",
        "Phase One",
        "--json",
      ]),
    );
    withDb(root, (db) => {
      const hitches = new HitchRepository(db);
      const phases = new PhaseRepository(db);
      hitches.createSession({
        hitchId: "h-ingest",
        title: "ingest hitch",
        projectId: "demo",
        domain: "apps/user",
        scope: {},
        closeConditions: [],
        createdBy: "test",
        createdSource: "cli",
      });
      hitches.upsertFinding({
        hitchId: "h-ingest",
        severity: "P1",
        source: "human",
        category: "correctness",
        summary: "fix needed",
        scopeStatus: "in_scope",
      });
      phases.linkHitch(phase.phaseId, "h-ingest");
    });

    const result = runCli(
      root,
      ["course", "orchestrate", course.courseId, "--max-driven-hitches", "1", "--json"],
      {
        HARNESS_CODEX_BIN: fakeCodexBin,
        HARNESS_CLAUDE_PROJECTS_DIR: cpd,
      },
    );
    expect(result.code).toBe(0);

    // The tail must have called ingestClaudeSubagentUsage — fixture transcript
    // rows must be present in agent_invocation + agent_usage_turn.
    withDb(root, (db) => {
      const summary = subagentUsageSummary(db);
      expect(summary.totals.invocations).toBeGreaterThan(0);
      expect(summary.totals.inputTokens).toBeGreaterThan(0);
    });
  });

  it("course orchestrate does not throw when HARNESS_CLAUDE_PROJECTS_DIR points at a non-existent dir", () => {
    const root = makeHarnessRoot();
    const repoPath = makeRepo();
    setupProjectHarness(root, repoPath);
    const fakeCodexBin = writeFakeCodexBin();

    const course = json<{ courseId: string }>(
      runCli(root, [
        "course",
        "create",
        "--title",
        "Broken Ingest Course",
        "--project",
        "demo",
        "--json",
      ]),
    );
    // No hitches → orchestrate returns immediately with stopReason=completed.
    const result = runCli(
      root,
      ["course", "orchestrate", course.courseId, "--json"],
      {
        HARNESS_CODEX_BIN: fakeCodexBin,
        // Non-existent dir: ingest should silently skip, not throw.
        HARNESS_CLAUDE_PROJECTS_DIR: join(tmpdir(), "no-such-claude-dir-xyzzy"),
      },
    );
    expect(result.code).toBe(0);
  });

  it("[P2] hitch orchestrate tail ingests claude subagent usage from HARNESS_CLAUDE_PROJECTS_DIR", () => {
    const root = makeHarnessRoot();
    const repoPath = makeRepo();
    setupProjectHarness(root, repoPath);
    const fakeCodexBin = writeFakeCodexBin();
    // Unique agent/session so rows don't collide with the course test.
    const cpd = mkdtempSync(join(tmpdir(), "harness-hitch-ingest-cpd-"));
    const subagentDir = join(cpd, "sess-hitch", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const jsonlPath = join(subagentDir, "agent-hitch.jsonl");
    const metaPath = join(subagentDir, "agent-hitch.meta.json");
    writeFileSync(
      jsonlPath,
      // in-file agentId without agent- prefix — matches real Claude transcripts
      // (filename agent-hitch.jsonl → path-derived id "hitch" == in-file "hitch")
      '{"type":"assistant","sessionId":"sess-hitch","agentId":"hitch","message":{"model":"claude-opus-4-8","usage":{"input_tokens":7,"output_tokens":14,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n',
    );
    writeFileSync(metaPath, '{"agentType":"general-purpose"}');
    // Backdate mtime 60 s so the default settle-guard (30 s) passes.
    const past = new Date(Date.now() - 60_000);
    utimesSync(jsonlPath, past, past);
    utimesSync(metaPath, past, past);

    // Create a hitch with an open P1 finding so orchestrate advances past
    // the early-exit check and reaches the ingest tail.
    withDb(root, (db) => {
      new HitchRepository(db).createSession({
        hitchId: "h-hitch-ingest",
        title: "hitch ingest test",
        projectId: "demo",
        domain: "apps/user",
        scope: {},
        closeConditions: [],
        createdBy: "test",
        createdSource: "cli",
      });
      new HitchRepository(db).upsertFinding({
        hitchId: "h-hitch-ingest",
        severity: "P1",
        source: "human",
        category: "correctness",
        summary: "fix needed for hitch ingest test",
        scopeStatus: "in_scope",
      });
    });

    // Run hitch orchestrate — exit code varies by run state (may be pr_created
    // or similar); what matters is that the ingest tail ran after the pass.
    const result = runCli(
      root,
      [
        "hitch",
        "orchestrate",
        "h-hitch-ingest",
        "--repo",
        repoPath,
        "--max-steps",
        "1",
      ],
      {
        HARNESS_CODEX_BIN: fakeCodexBin,
        HARNESS_CLAUDE_PROJECTS_DIR: cpd,
      },
    );

    // The fail-open ingest tail must not change the orchestrate exit code.
    // A non-zero exit here means the tail ingest tainted a succeeded run.
    expect(result.code, `hitch orchestrate exited ${result.code}: ${result.out}`).toBe(0);

    // The hitch tail must have called ingestClaudeSubagentUsage — fixture rows
    // must appear in agent_invocation + agent_usage_turn.
    withDb(root, (db) => {
      const summary = subagentUsageSummary(db);
      expect(
        summary.totals.invocations,
        `hitch orchestrate ingest tail did not run (exit=${result.code}): ${result.out}`,
      ).toBeGreaterThan(0);
      expect(summary.totals.inputTokens).toBeGreaterThan(0);
    });
  });
});
