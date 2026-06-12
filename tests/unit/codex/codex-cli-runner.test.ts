import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexCliRunner,
  filterEnv,
  DEFAULT_CODEX_ENV_ALLOWLIST,
} from "../../../src/codex/codex-cli-runner.js";

describe("filterEnv", () => {
  it("includes only allowlisted variables", () => {
    const out = filterEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        SECRET_KEY: "leak-me",
        OPENAI_API_KEY: "leak-me-too",
      } as NodeJS.ProcessEnv,
      ["PATH", "HOME"],
    );
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(out).not.toHaveProperty("SECRET_KEY");
    expect(out).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("default allowlist excludes secrets-like env vars", () => {
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).toContain("PATH");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).toContain("HOME");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).not.toContain("OPENAI_API_KEY");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).not.toContain("AWS_SECRET_ACCESS_KEY");
  });
});

function writeExecutableScript(dir: string, body: string): string {
  const path = join(dir, "fake-codex.js");
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("createCodexCliRunner", () => {
  it("returns durationMs for elapsed successful work", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-codex-cli-"));
    const codexBin = writeExecutableScript(
      wt,
      [
        "const { writeFileSync } = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('-o');",
        "if (outputIndex < 0) throw new Error('missing -o');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  setTimeout(() => {",
        "    writeFileSync(args[outputIndex + 1], 'ok\\n', 'utf8');",
        "    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n', () => process.exit(0));",
        "  }, 50);",
        "});",
      ].join("\n"),
    );
    const runner = createCodexCliRunner({
      codexBin,
      envAllowlist: ["PATH"],
    });

    const result = await runner.run({
      worktreePath: wt,
      prompt: "hello",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
        events: join(wt, "events.jsonl"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toEqual(expect.any(Number));
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
    expect(readFileSync(join(wt, "out.log"), "utf8")).toBe("ok\n");
  });

  it("runs codex exec as JSONL and preserves codex-output.log as the final message", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-codex-cli-json-"));
    const finalMessage = "final agent message\n";
    const codexBin = writeExecutableScript(
      wt,
      [
        "const { writeFileSync } = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('-o');",
        "if (!args.includes('--json')) throw new Error('missing --json');",
        "if (outputIndex < 0) throw new Error('missing -o');",
        "if (args[outputIndex + 1] !== process.env.EXPECTED_OUTPUT_PATH) {",
        "  throw new Error(`unexpected -o path: ${args[outputIndex + 1]}`);",
        "}",
        "writeFileSync(process.env.ARGS_PATH, JSON.stringify(args), 'utf8');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        `  writeFileSync(args[outputIndex + 1], ${JSON.stringify(finalMessage)}, 'utf8');`,
        "  const events = [",
        "    { type: 'thread.started', thread_id: 'thread-test' },",
        "    { type: 'turn.started' },",
        "    { type: 'item.started', item: { type: 'agent_message' } },",
        "    { type: 'item.completed', item: { type: 'agent_message', text: 'final agent message' } },",
        "    { type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 2, output_tokens: 7, reasoning_output_tokens: 3 } },",
        "  ];",
        "  process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n', () => process.exit(0));",
        "});",
      ].join("\n"),
    );
    const argsPath = join(wt, "args.json");
    const outputPath = join(wt, "codex-output.log");
    const eventsPath = join(wt, "codex-events.jsonl");
    const runner = createCodexCliRunner({
      codexBin,
      envAllowlist: ["PATH", "EXPECTED_OUTPUT_PATH", "ARGS_PATH"],
    });
    process.env.EXPECTED_OUTPUT_PATH = outputPath;
    process.env.ARGS_PATH = argsPath;

    const result = await runner.run({
      worktreePath: wt,
      prompt: "hello",
      logPaths: {
        stdout: outputPath,
        stderr: join(wt, "codex-error.log"),
        events: eventsPath,
      },
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const outputArgIndex = args.indexOf("-o");
    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });

    expect(result.exitCode).toBe(0);
    expect(args).toContain("--json");
    expect(outputArgIndex).toBeGreaterThanOrEqual(0);
    expect(args[outputArgIndex + 1]).toBe(outputPath);
    expect(readFileSync(outputPath, "utf8")).toBe(finalMessage);
    expect(events.map((event) => event.type)).toEqual([
      "thread.started",
      "turn.started",
      "item.started",
      "item.completed",
      "turn.completed",
    ]);
  });

  it("returns durationMs on timeout", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-codex-cli-timeout-"));
    const codexBin = writeExecutableScript(
      wt,
      [
        "process.stdin.resume();",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const runner = createCodexCliRunner({
      codexBin,
      envAllowlist: ["PATH"],
      timeoutMs: 60,
    });

    const result = await runner.run({
      worktreePath: wt,
      prompt: "hello",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
        events: join(wt, "events.jsonl"),
      },
    });

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toEqual(expect.any(Number));
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  it("passes -o a log path outside the worktree without creating worktree output files", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-codex-cli-split-"));
    const wt = join(root, "worktree");
    const logs = join(root, "logs");
    mkdirSync(wt);
    const codexBin = writeExecutableScript(
      root,
      [
        "const { mkdirSync, writeFileSync } = require('node:fs');",
        "const { resolve } = require('node:path');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('-o');",
        "if (outputIndex < 0) throw new Error('missing -o');",
        "const outputPath = resolve(args[outputIndex + 1]);",
        "const expectedOutputPath = resolve(process.env.EXPECTED_OUTPUT_PATH);",
        "const allowedRoot = resolve(process.env.ALLOWED_TMP_ROOT);",
        "const worktreePath = resolve(process.env.EXPECTED_WORKTREE);",
        "if (outputPath !== expectedOutputPath) {",
        "  throw new Error(`unexpected -o path: ${outputPath}`);",
        "}",
        "if (!outputPath.startsWith(`${allowedRoot}/`)) {",
        "  throw new Error(`output escaped tmp root: ${outputPath}`);",
        "}",
        "if (outputPath.startsWith(`${worktreePath}/`)) {",
        "  throw new Error(`output unexpectedly inside worktree: ${outputPath}`);",
        "}",
        "mkdirSync(worktreePath, { recursive: true });",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  writeFileSync(outputPath, 'final outside worktree\\n', 'utf8');",
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n', () => process.exit(0));",
        "});",
      ].join("\n"),
    );
    const runner = createCodexCliRunner({
      codexBin,
      envAllowlist: [
        "PATH",
        "EXPECTED_OUTPUT_PATH",
        "EXPECTED_WORKTREE",
        "ALLOWED_TMP_ROOT",
      ],
    });
    const outputPath = join(logs, "codex-output.log");
    process.env.EXPECTED_OUTPUT_PATH = outputPath;
    process.env.EXPECTED_WORKTREE = wt;
    process.env.ALLOWED_TMP_ROOT = root;

    const result = await runner.run({
      worktreePath: wt,
      prompt: "hello",
      logPaths: {
        stdout: outputPath,
        stderr: join(logs, "codex-error.log"),
        events: join(logs, "codex-events.jsonl"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe("final outside worktree\n");
    expect(existsSync(join(wt, "codex-output.log"))).toBe(false);
    expect(readdirSync(wt)).toEqual([]);
  });
});
