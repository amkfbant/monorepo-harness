import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { killProcessTree } from "../codex/process-tree.js";

export interface CommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
}

export interface RunAllowedCommandsInputs {
  worktreePath: string;
  commands: readonly string[];
  /** absolute path of a directory to write command logs into */
  logDir: string;
  /** Per-command timeout. Default 5 minutes. */
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

// Filenames must be deterministic per index so command artifacts are easy
// to correlate with the results array.
function slugifyForFilename(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function logPaths(
  logDir: string,
  idx: number,
  command: string,
): { stdoutPath: string; stderrPath: string } {
  const slug = slugifyForFilename(command) || "cmd";
  const idxPart = String(idx).padStart(2, "0");
  return {
    stdoutPath: join(logDir, `${idxPart}-${slug}.out.log`),
    stderrPath: join(logDir, `${idxPart}-${slug}.err.log`),
  };
}

export async function runAllowedCommands(
  input: RunAllowedCommandsInputs,
): Promise<{ results: CommandResult[]; allPassed: boolean }> {
  if (input.commands.length === 0) {
    return { results: [], allPassed: true };
  }
  await mkdir(input.logDir, { recursive: true });
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = input.env ?? filteredEnv(input.envAllowlist);

  const results: CommandResult[] = [];
  for (let i = 0; i < input.commands.length; i++) {
    const command = input.commands[i]!;
    const { stdoutPath, stderrPath } = logPaths(input.logDir, i, command);
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
  command: string;
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
    const child = spawn("sh", ["-c", input.command], {
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
            command: input.command,
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
