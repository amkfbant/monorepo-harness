import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllowedCommands } from "../../../src/core/command-runner.js";

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
      commands: ["echo hello"],
      logDir,
    });
    expect(r.allPassed).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.exitCode).toBe(0);
    expect(r.results[0]?.timedOut).toBe(false);
    expect(r.results[0]?.command).toBe("echo hello");
    expect(existsSync(r.results[0]!.stdoutPath)).toBe(true);
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8")).toMatch(/hello/);
  });

  it("flags failure when a command returns non-zero", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: ["false"],
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
      commands: ["true", "false", "echo ok"],
      logDir,
    });
    expect(r.results).toHaveLength(3);
    expect(r.results[0]?.exitCode).toBe(0);
    expect(r.results[1]?.exitCode).not.toBe(0);
    expect(r.results[2]?.exitCode).toBe(0);
    expect(r.allPassed).toBe(false); // 1 failure → overall false
  });

  it("times out a long-running command via SIGKILL and marks timedOut=true", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: ["sleep 30"],
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
      commands: ["pwd"],
      logDir,
    });
    // On macOS, /tmp is a symlink to /private/tmp — accept either form.
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8").trim()).toContain(
      wt.replace(/^\/private/, ""),
    );
  });

  it("filters env to the safe allowlist (no inherited OPENAI_API_KEY etc.)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-cmd-"));
    const logDir = mkdtempSync(join(tmpdir(), "harness-cmd-log-"));
    const r = await runAllowedCommands({
      worktreePath: wt,
      commands: ["sh -c 'echo OPENAI=${OPENAI_API_KEY:-unset}'"],
      logDir,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(readFileSync(r.results[0]!.stdoutPath, "utf8")).toMatch(
      /OPENAI=unset/,
    );
  });
});
