// Codex CLI contract (confirmed against codex-cli 0.133.0):
//   codex exec [opts] [PROMPT|-]
//   - prompt: stdin when omitted or `-`; otherwise positional arg.
//   - `-C <dir>` sets the agent's working root.
//   - `--sandbox <mode>` controls filesystem write permissions.
//   - `--skip-git-repo-check` tolerates worktrees that look fresh to codex.
//   - `-c approval_policy=<value>` controls non-interactive approval policy.
//   - `--json` streams JSONL events to stdout and suppresses legacy
//     header/footer text on stderr.
//   - `-o/--output-last-message <file>` writes the final agent message.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "./codex-exec-runner.js";
import type { SandboxMode } from "../policy/schema.js";
import { killProcessTree } from "./process-tree.js";
import { resolveCodexBin } from "./resolve-codex-bin.js";

// Default env vars passed to the codex subprocess. Anything outside this
// allowlist (OPENAI_* / AWS_* / etc.) is stripped unless the operator
// explicitly opts in via envAllowlist.
export const DEFAULT_CODEX_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "CODEX_HOME",
];

export interface CodexCliOpts {
  codexBin: string;
  sandbox?: SandboxMode;
  approvalPolicy?: string;
  envAllowlist?: readonly string[];
  timeoutMs?: number;
  extraArgs?: readonly string[];
}

export function filterEnv(
  env: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function createCodexCliRunner(opts: CodexCliOpts): CodexExecRunner {
  const sandbox: SandboxMode = opts.sandbox ?? "workspace-write";
  const envAllowlist = opts.envAllowlist ?? DEFAULT_CODEX_ENV_ALLOWLIST;
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      await mkdir(dirname(input.logPaths.stdout), { recursive: true });
      await mkdir(dirname(input.logPaths.stderr), { recursive: true });
      await mkdir(dirname(input.logPaths.events), { recursive: true });
      const eventsStream = createWriteStream(input.logPaths.events);
      const errStream = createWriteStream(input.logPaths.stderr);

      const args: string[] = [
        "exec",
        "--json",
        // --ephemeral: do not persist session state under CODEX_HOME. All
        //   reviewable artifacts must live in runs/<id>/ — anything else is
        //   an artifact-boundary leak.
        // --ignore-rules: ignore .rules files inside the target repo. The
        //   harness policy is the authoritative source of project rules;
        //   silently inheriting target-repo rules can contradict policy.
        "--ephemeral",
        "--ignore-rules",
        "--sandbox",
        sandbox,
        "-C",
        input.worktreePath,
        "--skip-git-repo-check",
        "-o",
        input.logPaths.stdout,
      ];
      if (opts.approvalPolicy) {
        args.push("-c", `approval_policy="${opts.approvalPolicy}"`);
      }
      args.push(...(opts.extraArgs ?? []));
      args.push("-");

      const env = filterEnv(process.env, envAllowlist);
      const codexBin = resolveCodexBin(opts.codexBin);
      return await new Promise<CodexRunResult>((resolve, reject) => {
        // detached: true → codex becomes a new process-group leader so the
        // timeout can SIGKILL the entire tree (test runners, dev servers,
        // package managers) via killProcessTree, not just the parent.
        const startedAt = performance.now();
        const child = spawn(codexBin, args, {
          cwd: input.worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
          env,
          detached: true,
        });
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, opts.timeoutMs);
        }
        child.stdout.pipe(eventsStream);
        child.stderr.pipe(errStream);
        // codex may exit before draining stdin (early exit / crash / a prompt
        // larger than the OS pipe buffer). The resulting EPIPE on the prompt
        // write is not fatal — the child's exit code is the source of truth.
        // Without this handler the EPIPE is unhandled and crashes the harness
        // (observed on CI/Linux; hidden on macOS by pipe-buffer timing).
        child.stdin.on("error", () => {});
        child.stdin.write(input.prompt);
        child.stdin.end();
        child.on("error", (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          const durationMs = Math.round(performance.now() - startedAt);
          // Make sure the file streams have flushed before the workflow
          // calls readTail(). pipe() already calls .end() on eventsStream/
          // errStream when stdout/stderr ends, so we only need to wait
          // for the finished() signal.
          Promise.all([finished(eventsStream), finished(errStream)])
            .catch(() => {
              // shutdown noise — exit code is the source of truth
            })
            .then(async () => {
              // `-o` is written by codex itself. Preserve the historical
              // artifact path even when codex exits before producing a final
              // agent message.
              await writeFile(input.logPaths.stdout, "", { flag: "a" });
            })
            .finally(() => {
              resolve({ exitCode: code ?? -1, timedOut, durationMs });
            });
        });
      });
    },
  };
}
