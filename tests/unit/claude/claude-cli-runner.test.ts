import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeArgs,
  createClaudeCliRunner,
  DEFAULT_CLAUDE_ENV_ALLOWLIST,
} from "../../../src/claude/claude-cli-runner.js";

// buildClaudeArgs is a pure function: assert the F13 isolation lock flags and
// the F15 hygiene invariant (no --add-dir → the cwd=worktree write boundary is
// never widened past the worktree).
describe("buildClaudeArgs", () => {
  it("emits the F13 subscription-isolation lock flags", () => {
    const args = buildClaudeArgs({});
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    // --setting-sources "" → ignore global/project CLAUDE.md, MCP, hooks, skills
    // while keeping subscription auth (apiKeySource=none). F13.
    const ss = args.indexOf("--setting-sources");
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(args[ss + 1]).toBe("");
    // default permission mode
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("NEVER passes --add-dir (F15 hygiene: boundary stays the worktree cwd)", () => {
    expect(buildClaudeArgs({})).not.toContain("--add-dir");
    expect(
      buildClaudeArgs({ tools: ["Bash", "Read"], model: "x" }),
    ).not.toContain("--add-dir");
  });

  it("restricts the granted tool surface via --tools (placed last so the variadic is unambiguous)", () => {
    const args = buildClaudeArgs({ tools: ["Read", "Grep", "Glob"] });
    const t = args.indexOf("--tools");
    expect(t).toBeGreaterThanOrEqual(0);
    expect(args.slice(t + 1)).toEqual(["Read", "Grep", "Glob"]);
    expect(t + 3).toBe(args.length - 1); // --tools is the final flag
  });

  it("injects --model only when an advisory model is given", () => {
    expect(buildClaudeArgs({})).not.toContain("--model");
    const args = buildClaudeArgs({ model: "opus" });
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("default env allowlist strips ANTHROPIC_API_KEY to keep subscription auth (no metered fallback)", () => {
    expect(DEFAULT_CLAUDE_ENV_ALLOWLIST).toContain("PATH");
    expect(DEFAULT_CLAUDE_ENV_ALLOWLIST).toContain("HOME");
    expect(DEFAULT_CLAUDE_ENV_ALLOWLIST).not.toContain("ANTHROPIC_API_KEY");
    expect(DEFAULT_CLAUDE_ENV_ALLOWLIST).not.toContain("AWS_SECRET_ACCESS_KEY");
  });
});

function writeFakeClaude(dir: string, body: string): string {
  const path = join(dir, "fake-claude.js");
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

// A fake `claude` that mirrors the observed stream-json envelope: assistant
// events carry per-message delta usage, the final `result` event carries the
// authoritative cumulative usage AND the final agent message in `.result`.
const SUCCESS_BODY = [
  "const { writeFileSync } = require('node:fs');",
  "const args = process.argv.slice(2);",
  "if (process.env.ARGS_PATH) writeFileSync(process.env.ARGS_PATH, JSON.stringify(args));",
  "if (!args.includes('-p')) throw new Error('missing -p');",
  "if (!args.includes('--output-format')) throw new Error('missing --output-format');",
  "let prompt = '';",
  "process.stdin.on('data', (d) => { prompt += d; });",
  "process.stdin.on('end', () => {",
  "  if (process.env.PROMPT_PATH) writeFileSync(process.env.PROMPT_PATH, prompt);",
  "  const events = [",
  "    { type: 'system', subtype: 'init', apiKeySource: 'none' },",
  "    { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } },",
  "    { type: 'result', subtype: 'success', is_error: false, result: 'FINAL CLAUDE MESSAGE', usage: { input_tokens: 22, output_tokens: 33, cache_read_input_tokens: 70, cache_creation_input_tokens: 6 }, total_cost_usd: 0.1, permission_denials: [] },",
  "  ];",
  "  process.stdout.write(events.map((e) => JSON.stringify(e)).join('\\n') + '\\n', () => process.exit(0));",
  "});",
].join("\n");

describe("createClaudeCliRunner", () => {
  it("captures the raw stream-json to the events file, extracts result.result as the final message, and delivers the prompt via stdin", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-claude-cli-"));
    const argsPath = join(wt, "args.json");
    const promptPath = join(wt, "prompt.txt");
    const claudeBin = writeFakeClaude(wt, SUCCESS_BODY);
    const runner = createClaudeCliRunner({
      claudeBin,
      envAllowlist: ["PATH", "ARGS_PATH", "PROMPT_PATH"],
    });
    process.env.ARGS_PATH = argsPath;
    process.env.PROMPT_PATH = promptPath;

    const stdout = join(wt, "out.log");
    const events = join(wt, "events.jsonl");
    const result = await runner.run({
      worktreePath: wt,
      prompt: "implement the thing",
      logPaths: { stdout, stderr: join(wt, "err.log"), events },
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toEqual(expect.any(Number));
    // final agent message extracted from the result event (codex's `-o` analogue)
    expect(readFileSync(stdout, "utf8")).toBe("FINAL CLAUDE MESSAGE");
    // raw stream-json preserved verbatim for the events-summary / telemetry / redaction layers
    const lines = readFileSync(events, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e: { type: string }) => e.type)).toEqual([
      "system",
      "assistant",
      "result",
    ]);
    // prompt arrived via stdin (no ARG_MAX risk for large injected prompts)
    expect(readFileSync(promptPath, "utf8")).toBe("implement the thing");
    delete process.env.ARGS_PATH;
    delete process.env.PROMPT_PATH;
  });

  it("writes an empty final-message file when the run produces no result event (fail-closed artifact)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-claude-cli-noresult-"));
    const claudeBin = writeFakeClaude(
      wt,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n', () => process.exit(1));",
        "});",
      ].join("\n"),
    );
    const runner = createClaudeCliRunner({ claudeBin, envAllowlist: ["PATH"] });
    const stdout = join(wt, "out.log");
    const result = await runner.run({
      worktreePath: wt,
      prompt: "x",
      logPaths: { stdout, stderr: join(wt, "err.log"), events: join(wt, "events.jsonl") },
    });
    expect(result.exitCode).toBe(1);
    expect(readFileSync(stdout, "utf8")).toBe("");
  });

  it("returns timedOut and kills the tree on timeout", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-claude-cli-timeout-"));
    const claudeBin = writeFakeClaude(
      wt,
      ["process.stdin.resume();", "setInterval(() => {}, 1000);"].join("\n"),
    );
    const runner = createClaudeCliRunner({
      claudeBin,
      envAllowlist: ["PATH"],
      timeoutMs: 60,
    });
    const result = await runner.run({
      worktreePath: wt,
      prompt: "x",
      logPaths: { stdout: join(wt, "out.log"), stderr: join(wt, "err.log"), events: join(wt, "events.jsonl") },
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  it("kills the tree and reports aborted when the AbortSignal fires mid-run (#132 fail-closed)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-claude-cli-abort-"));
    const claudeBin = writeFakeClaude(
      wt,
      ["process.stdin.resume();", "setInterval(() => {}, 1000);"].join("\n"),
    );
    const runner = createClaudeCliRunner({ claudeBin, envAllowlist: ["PATH"] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const startedAt = Date.now();
    const result = await runner.run({
      worktreePath: wt,
      prompt: "x",
      logPaths: { stdout: join(wt, "out.log"), stderr: join(wt, "err.log"), events: join(wt, "events.jsonl") },
      signal: controller.signal,
    });
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("does not spawn claude and reports aborted when the signal is already aborted (#132 fail-closed)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-claude-cli-preabort-"));
    const markerPath = join(wt, "spawned.marker");
    const claudeBin = writeFakeClaude(
      wt,
      [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(markerPath)}, 'spawned', 'utf8');`,
        "process.exit(0);",
      ].join("\n"),
    );
    const runner = createClaudeCliRunner({ claudeBin, envAllowlist: ["PATH"] });
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run({
      worktreePath: wt,
      prompt: "x",
      logPaths: { stdout: join(wt, "out.log"), stderr: join(wt, "err.log"), events: join(wt, "events.jsonl") },
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  });
});
