// Codex CLI contract (confirmed against codex-cli 0.130.0):
//   codex exec [opts] [PROMPT|-]
//   - prompt: stdin when omitted or `-`; otherwise positional arg.
//   - `-C <dir>` sets the agent's working root.
//   - `--sandbox workspace-write` lets the agent edit files in the worktree.
//   - `--skip-git-repo-check` tolerates worktrees that look fresh to codex.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "./codex-exec-runner.js";

export interface CodexCliOpts {
  codexBin: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  extraArgs?: readonly string[];
}

export function createCodexCliRunner(opts: CodexCliOpts): CodexExecRunner {
  const sandbox = opts.sandbox ?? "workspace-write";
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      await mkdir(dirname(input.logPaths.stdout), { recursive: true });
      await mkdir(dirname(input.logPaths.stderr), { recursive: true });
      const outStream = createWriteStream(input.logPaths.stdout);
      const errStream = createWriteStream(input.logPaths.stderr);

      const args = [
        "exec",
        "--sandbox",
        sandbox,
        "-C",
        input.worktreePath,
        "--skip-git-repo-check",
        ...(opts.extraArgs ?? []),
        "-",
      ];
      return await new Promise<CodexRunResult>((resolve, reject) => {
        const child = spawn(opts.codexBin, args, {
          cwd: input.worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        });
        child.stdout.pipe(outStream);
        child.stderr.pipe(errStream);
        child.stdin.write(input.prompt);
        child.stdin.end();
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? -1 }));
      });
    },
  };
}
