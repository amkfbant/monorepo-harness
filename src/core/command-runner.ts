import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { killProcessTree } from "../codex/process-tree.js";
import type { ResolvedCommand } from "../policy/schema.js";

export interface CommandResult {
  /** stable command identifier from policy (or generated "cmd-N" for legacy string entries) */
  id: string;
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
}

export interface RunAllowedCommandsInputs {
  worktreePath: string;
  commands: readonly ResolvedCommand[];
  /** absolute path of a directory to write command logs into */
  logDir: string;
  /** Default per-command timeout when a command does not override. */
  timeoutMs?: number;
  /**
   * Direct env to pass to children. Takes precedence over envAllowlist.
   * Useful for tests that inject a specific shape.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Env-var keys to filter from process.env. Used when `env` is not
   * supplied. Undefined → DEFAULT_COMMAND_ENV_ALLOWLIST. Empty array →
   * strictly empty env (operator opted into zero inheritance).
   */
  envAllowlist?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_COMMAND_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
];

function filteredEnv(
  allowlist: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  const keys = allowlist ?? DEFAULT_COMMAND_ENV_ALLOWLIST;
  const out: NodeJS.ProcessEnv = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Log filenames use the policy-supplied id so artifacts correlate with
// commandResults.
function logPaths(
  logDir: string,
  id: string,
): { stdoutPath: string; stderrPath: string } {
  return {
    stdoutPath: join(logDir, `${id}.out.log`),
    stderrPath: join(logDir, `${id}.err.log`),
  };
}

function displayCommand(c: ResolvedCommand): string {
  if (c.shell) return c.cmd;
  return [c.cmd, ...c.args].join(" ");
}

export async function runAllowedCommands(
  input: RunAllowedCommandsInputs,
): Promise<{ results: CommandResult[]; allPassed: boolean }> {
  if (input.commands.length === 0) {
    return { results: [], allPassed: true };
  }
  await mkdir(input.logDir, { recursive: true });
  const baseTimeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseEnv = input.env ?? filteredEnv(input.envAllowlist);

  const results: CommandResult[] = [];
  for (const command of input.commands) {
    const { stdoutPath, stderrPath } = logPaths(input.logDir, command.id);
    const timeoutMs = command.timeoutMs ?? baseTimeoutMs;
    // Per-command env override merges on top of the base allowlisted env.
    const env: NodeJS.ProcessEnv = command.env
      ? { ...baseEnv, ...command.env }
      : baseEnv;
    const result = await runOne({
      command,
      worktreePath: input.worktreePath,
      env,
      timeoutMs,
      stdoutPath,
      stderrPath,
    });
    results.push(result);
  }
  const allPassed = results.every((r) => r.exitCode === 0 && !r.timedOut);
  return { results, allPassed };
}

interface RunOneInputs {
  command: ResolvedCommand;
  worktreePath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
}

function runOne(input: RunOneInputs): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const outStream = createWriteStream(input.stdoutPath);
    const errStream = createWriteStream(input.stderrPath);
    const started = Date.now();
    // detached:true → tree-kill on timeout reaches any child (test runners
    // that fork workers, dev servers, etc.). Same pattern as codex runner.
    // shell:true legacy form keeps `sh -c <cmd>`; structured form uses
    // argv directly (no shell escaping).
    const child = input.command.shell
      ? spawn("sh", ["-c", input.command.cmd], {
          cwd: input.worktreePath,
          stdio: ["ignore", "pipe", "pipe"],
          env: input.env,
          detached: true,
        })
      : spawn(input.command.cmd, input.command.args, {
          cwd: input.worktreePath,
          stdio: ["ignore", "pipe", "pipe"],
          env: input.env,
          detached: true,
        });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, input.timeoutMs);
    child.stdout.pipe(outStream);
    child.stderr.pipe(errStream);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      Promise.all([finished(outStream), finished(errStream)])
        .catch(() => {
          // shutdown noise — exit code is the source of truth
        })
        .finally(() => {
          resolve({
            id: input.command.id,
            command: displayCommand(input.command),
            exitCode: code ?? -1,
            durationMs: Date.now() - started,
            timedOut,
            stdoutPath: input.stdoutPath,
            stderrPath: input.stderrPath,
          });
        });
    });
  });
}
