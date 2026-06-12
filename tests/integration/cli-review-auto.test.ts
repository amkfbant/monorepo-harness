import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setupRun(decision = "pending"): { root: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-rauto-cli-"));
  const runId = "run-20260521-apps-user-rauto01";
  const runDir = join(root, "runs", runId);
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
        status: "needs_review",
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
  writeFileSync(join(runDir, "summary.md"), "# summary\nsome content\n");
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
  return { root, runId };
}

/**
 * A fake codex binary. The codex-cli-runner filters child env to a small
 * allowlist, so we can't pass the desired output via an env var — instead
 * the bin cats a fixed file. Each test writes that file before running.
 */
interface FakeCodex {
  bin: string;
  outputFile: string;
}

function writeFakeCodexBin(): FakeCodex {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-codex-"));
  const bin = join(dir, "codex");
  const outputFile = join(dir, "output.txt");
  writeFileSync(outputFile, "");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const { readFileSync, writeFileSync } = require('node:fs');",
      "const { resolve } = require('node:path');",
      "const args = process.argv.slice(2);",
      "const outputIndex = args.indexOf('-o');",
      "if (!args.includes('--json')) throw new Error('missing --json');",
      "if (outputIndex < 0) throw new Error('missing -o');",
      "const outputPath = resolve(args[outputIndex + 1]);",
      `const allowedTmpRoot = resolve(${JSON.stringify(tmpdir())});`,
      "if (!outputPath.startsWith(`${allowedTmpRoot}/`)) {",
      "  throw new Error(`output escaped tmp root: ${outputPath}`);",
      "}",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      `  const finalMessage = readFileSync(${JSON.stringify(outputFile)}, 'utf8');`,
      "  writeFileSync(outputPath, finalMessage, 'utf8');",
      "  const event = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };",
      "  process.stdout.write(`${JSON.stringify(event)}\\n`, () => process.exit(0));",
      "});",
    ].join("\n"),
  );
  execFileSync("chmod", ["+x", bin]);
  return { bin, outputFile };
}

function run(
  args: string[],
  harnessRoot: string,
  fakeOutput: string,
  fake: FakeCodex,
): { stdout: string; stderr: string; status: number } {
  writeFileSync(fake.outputFile, fakeOutput);
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    env: {
      ...process.env,
      HARNESS_ROOT: harnessRoot,
      HARNESS_CODEX_BIN: fake.bin,
    },
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

const VALID_YAML = [
  "```yaml",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "```",
].join("\n");

describe("harness review auto", () => {
  const fakeBin = writeFakeCodexBin();

  it("writes review-decision.yaml from valid codex output", () => {
    const { root, runId } = setupRun();
    const { stdout, status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      VALID_YAML,
      fakeBin,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/decision=approved/);
    const yaml = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/decision: approved/);
    expect(yaml).toMatch(/reviewer: codex-reviewer/);
  });

  it("--dry-run does not write review-decision.yaml", () => {
    const { root, runId } = setupRun();
    const before = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    const { stdout, status } = run(
      ["review", "auto", "--run-id", runId, "--dry-run"],
      root,
      VALID_YAML,
      fakeBin,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/NOT written/);
    const after = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("refuses a non-pending decision without --allow-overwrite (exit 1)", () => {
    const { root, runId } = setupRun("approved");
    const { stderr, status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      VALID_YAML,
      fakeBin,
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/--allow-overwrite/);
  });

  it("--allow-overwrite replaces a non-pending decision", () => {
    const { root, runId } = setupRun("changes_requested");
    const { status } = run(
      ["review", "auto", "--run-id", runId, "--allow-overwrite"],
      root,
      VALID_YAML,
      fakeBin,
    );
    expect(status).toBe(0);
    const yaml = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/decision: approved/);
  });

  it("invalid codex output → exit 1, review-auto-error.json written, decision intact", () => {
    const { root, runId } = setupRun();
    const before = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    const { status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      "```yaml\ndecision: maybe\nrequired_changes: []\nnon_blocking_comments: []\nout_of_scope_suggestions: []\n```",
      fakeBin,
    );
    expect(status).toBe(1);
    const errPath = join(root, "runs", runId, "review-auto-error.json");
    expect(existsSync(errPath)).toBe(true);
    const err = JSON.parse(readFileSync(errPath, "utf8"));
    expect(err.type).toBe("review-auto-error");
    const after = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("extracts the YAML block even when codex wraps it in prose", () => {
    const { root, runId } = setupRun();
    const prosey = [
      "Here is my review of the run.",
      "",
      "I looked at summary.md and the diff.",
      "",
      VALID_YAML,
      "",
      "Let me know if you need more detail.",
    ].join("\n");
    const { status } = run(
      ["review", "auto", "--run-id", runId],
      root,
      prosey,
      fakeBin,
    );
    expect(status).toBe(0);
    const yaml = readFileSync(
      join(root, "runs", runId, "review-decision.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/decision: approved/);
  });
});
