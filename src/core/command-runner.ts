import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree } from "../codex/process-tree.js";
import type { ResolvedCommand } from "../policy/schema.js";
import {
  COMMAND_LOG_LINE_WITHHELD,
  COMMAND_LOG_MAX_LINE_CHARS,
  createSecretLineRedactor,
} from "../reporter/secret-scan.js";

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

// A Transform that redacts secret-shaped LINES from a child's stdout/stderr
// before they hit disk (#186). It is byte-stream safe: a StringDecoder reassembles
// multi-byte chars across chunks, lines are split on "\n" (a token split across a
// chunk boundary is only redacted once its line completes), and the partial-line
// buffer is BOUNDED — a line exceeding COMMAND_LOG_MAX_LINE_CHARS without a newline
// is withheld wholesale (no unbounded buffering, no token severed at a flush edge).
// Line redaction is stateful (createSecretLineRedactor) so multi-line PEM blocks
// are fully withheld.
// Rolling overlap kept while discarding an over-long line, so a PEM marker split
// across stream chunks is still observed (markers are ~40 chars; 256 is ample).
const PEM_TAIL_OVERLAP = 256;

function makeRedactingTransform(): Transform {
  const decoder = new StringDecoder("utf8");
  const redactor = createSecretLineRedactor();
  let pending = ""; // current partial line; kept strictly below the cap
  let dropping = false; // current line exceeded the cap → withhold it wholesale
  let dropTail = ""; // rolling suffix of the discarded line (for split markers)

  // Discard `chunk` of an over-long line but keep PEM block state correct by
  // observing markers across a rolling overlap window.
  function observeDropped(chunk: string): void {
    const scan = dropTail + chunk;
    redactor.observeDiscardedFragment(scan);
    dropTail = scan.slice(-PEM_TAIL_OVERLAP);
  }

  function consume(text: string, push: (s: string) => void): void {
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      if (nl === -1) {
        const seg = text.slice(i);
        if (dropping) {
          observeDropped(seg);
        } else if (pending.length + seg.length > COMMAND_LOG_MAX_LINE_CHARS) {
          dropping = true;
          observeDropped(pending + seg); // scan the prefix we discard
          pending = "";
        } else {
          pending += seg;
        }
        return;
      }
      const seg = text.slice(i, nl);
      if (dropping) {
        // the newline terminates the discarded over-long line
        observeDropped(seg);
        push(`${COMMAND_LOG_LINE_WITHHELD}\n`);
        dropping = false;
        dropTail = "";
      } else if (pending.length + seg.length > COMMAND_LOG_MAX_LINE_CHARS) {
        // line completes but is over the cap: observe its markers, then withhold
        redactor.observeDiscardedFragment(pending + seg);
        push(`${COMMAND_LOG_LINE_WITHHELD}\n`);
        pending = "";
      } else {
        const line = pending + seg;
        pending = "";
        push(`${redactor.redactLine(line)}\n`);
      }
      i = nl + 1;
    }
  }

  return new Transform({
    transform(
      this: Transform,
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      const text =
        typeof chunk === "string" ? chunk : decoder.write(chunk);
      consume(text, (s) => this.push(s, "utf8"));
      callback();
    },
    flush(this: Transform, callback: TransformCallback) {
      const tail = decoder.end();
      if (tail.length > 0) consume(tail, (s) => this.push(s, "utf8"));
      // emit the final, non-newline-terminated line (if any)
      if (dropping) {
        this.push(COMMAND_LOG_LINE_WITHHELD, "utf8");
        dropping = false;
      } else if (pending.length > 0) {
        this.push(redactor.redactLine(pending), "utf8");
        pending = "";
      }
      callback();
    },
  });
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
    // Redact secret-shaped lines at the write layer (#186) before bytes reach
    // disk. Each stream gets its own stateful redactor (independent PEM state).
    child.stdout.pipe(makeRedactingTransform()).pipe(outStream);
    child.stderr.pipe(makeRedactingTransform()).pipe(errStream);
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
