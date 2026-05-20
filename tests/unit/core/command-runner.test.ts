import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllowedCommands } from "../../../src/core/command-runner.js";
import type { ResolvedCommand } from "../../../src/policy/schema.js";

function shellCmd(id: string, raw: string): ResolvedCommand {
  return { id, cmd: raw, args: [], shell: true };
}

function argvCmd(id: string, cmd: string, args: string[]): ResolvedCommand {
  return { id, cmd, args, shell: false };
}

describe("runAllowedCommands", () => {
  it("returns allPassed=true and empty results when commands list is empty", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [],
      logDir,
    });
    expect(r.allPassed).toBe(true);
    expect(r.results).toEqual([]);
  });

  it("runs a single successful command and captures stdout/stderr to log files", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("cmd-0", "echo hello")],
      logDir,
    });
    expect(r.allPassed).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.id).toBe("cmd-0");
    expect(r.results[0]?.exitCode).toBe(0);
    expect(r.results[0]?.timedOut).toBe(false);
    expect(existsSync(r.results[0]!.stdoutPath)).toBe(true);
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8")).toMatch(/hello/);
    expect(r.results[0]!.stdoutPath).toMatch(/cmd-0\.out\.log$/);
  });

  it("flags failure when a command returns non-zero", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("cmd-0", "false")],
      logDir,
    });
    expect(r.allPassed).toBe(false);
    expect(r.results[0]?.exitCode).not.toBe(0);
  });

  it("runs each command independently and reports per-command status", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        shellCmd("ok-1", "true"),
        shellCmd("fail-1", "false"),
        shellCmd("ok-2", "echo ok"),
      ],
      logDir,
    });
    expect(r.results).toHaveLength(3);
    expect(r.results[0]?.exitCode).toBe(0);
    expect(r.results[1]?.exitCode).not.toBe(0);
    expect(r.results[2]?.exitCode).toBe(0);
    expect(r.allPassed).toBe(false);
  });

  it("times out a long-running command via SIGKILL and marks timedOut=true", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("slow", "sleep 30")],
      logDir,
      timeoutMs: 250,
    });
    expect(r.allPassed).toBe(false);
    expect(r.results[0]?.timedOut).toBe(true);
  });

  it("runs in the worktree directory (cwd respected)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [shellCmd("pwd-check", "pwd")],
      logDir,
    });
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8").trim()).toContain(
      wt.replace(/^\/private/, ""),
    );
  });

  it("filters env to the safe allowlist (no inherited OPENAI_API_KEY etc.)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        shellCmd("env-check", "sh -c 'echo OPENAI=${OPENAI_API_KEY:-unset}'"),
      ],
      logDir,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8")).toMatch(
      /OPENAI=unset/,
    );
  });

  it("structured (argv) form spawns directly with no shell interpretation", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [argvCmd("echo-literal", "echo", ["$HOME"])],
      logDir,
    });
    expect(r.results[0]?.exitCode).toBe(0);
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8").trim()).toBe(
      "$HOME",
    );
  });

  it("per-command timeoutMs overrides the default", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        { id: "tight", cmd: "sleep 5", args: [], shell: true, timeoutMs: 250 },
      ],
      logDir,
      timeoutMs: 30_000,
    });
    expect(r.results[0]?.timedOut).toBe(true);
  });

  it("per-command env merges on top of the base env", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: [
        {
          id: "env-merge",
          cmd: "sh -c 'echo $CUSTOM_VAR'",
          args: [],
          shell: true,
          env: { CUSTOM_VAR: "merged-ok" },
        },
      ],
      logDir,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8").trim()).toBe(
      "merged-ok",
    );
  });
});
