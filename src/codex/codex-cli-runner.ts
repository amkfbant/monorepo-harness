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
      // Fail-closed (#132): once the course lease is gone, do not launch codex.
      if (input.signal?.aborted === true) {
        return { exitCode: -1, timedOut: false, aborted: true, durationMs: 0 };
      }
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
        let aborted = false;
        let timer: NodeJS.Timeout | undefined;
        if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, opts.timeoutMs);
        }
        // #132 — SIGKILL the codex process tree if the course orchestrator
        // aborts mid-drive on lease loss. Same kill path as the timeout above;
        // the killed child exits non-zero → finalized `failed-codex` (fail-closed).
        const onAbort = (): void => {
          aborted = true;
          killProcessTree(child);
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        // Close the race between the pre-spawn `signal.aborted` check and this
        // listener registration: if the signal fired during mkdir / spawn setup,
        // adding a listener to an already-aborted signal does NOT replay the
        // event, so the kill would be missed and codex would run to completion
        // (the original #132 failure mode). Re-check and kill explicitly.
        if (input.signal?.aborted === true) onAbort();
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
          input.signal?.removeEventListener("abort", onAbort);
          reject(e);
        });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
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
              // Fail-closed (#132): if the run was aborted, force a non-zero exit
              // even when the child happened to exit 0 before the SIGKILL landed
              // (fast-success racing the abort). Once the course lease is lost the
              // run is no longer authoritative, so it must finalize `failed-codex`
              // (status selection keys on exitCode), never `needs_review`.
              resolve({
                exitCode: aborted ? -1 : code ?? -1,
                timedOut,
                aborted,
                durationMs,
              });
            });
        });
      });
    },
  };
}
