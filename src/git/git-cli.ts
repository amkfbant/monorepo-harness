import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface GitOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function gitCli(
  args: readonly string[],
  opts: GitOpts,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args as string[], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut,
      });
    });
  });
}

export async function gitCliOrThrow(
  args: readonly string[],
  opts: GitOpts,
): Promise<string> {
  const r = await gitCli(args, opts);
  if (r.timedOut) {
    throw new Error(
      `git ${args.join(" ")} timed out after ${opts.timeoutMs}ms`,
    );
  }
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim()}`,
    );
  }
  return r.stdout;
}
