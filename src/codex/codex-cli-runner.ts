// Codex CLI contract (confirmed against codex-cli 0.130.0):
//   codex exec [opts] [PROMPT|-]
//   - prompt: stdin when omitted or `-`; otherwise positional arg.
//   - `-C <dir>` sets the agent's working root.
//   - `--sandbox <mode>` controls filesystem write permissions.
//   - `--skip-git-repo-check` tolerates worktrees that look fresh to codex.
//   - `-c approval_policy=<value>` controls non-interactive approval policy.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "./codex-exec-runner.js";
import type { SandboxMode } from "../policy/schema.js";

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
      const outStream = createWriteStream(input.logPaths.stdout);
      const errStream = createWriteStream(input.logPaths.stderr);

      const args: string[] = [
        "exec",
        "--sandbox",
        sandbox,
        "-C",
        input.worktreePath,
        "--skip-git-repo-check",
      ];
      if (opts.approvalPolicy) {
        args.push("-c", `approval_policy="${opts.approvalPolicy}"`);
      }
      args.push(...(opts.extraArgs ?? []));
      args.push("-");

      const env = filterEnv(process.env, envAllowlist);
      return await new Promise<CodexRunResult>((resolve, reject) => {
        const child = spawn(opts.codexBin, args, {
          cwd: input.worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs);
        }
        child.stdout.pipe(outStream);
        child.stderr.pipe(errStream);
        child.stdin.write(input.prompt);
        child.stdin.end();
        child.on("error", (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          resolve({ exitCode: code ?? -1, timedOut });
        });
      });
    },
  };
}
