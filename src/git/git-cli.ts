import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
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
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? -1 }),
    );
  });
}

export async function gitCliOrThrow(
  args: readonly string[],
  opts: GitOpts,
): Promise<string> {
  const r = await gitCli(args, opts);
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim()}`,
    );
  }
  return r.stdout;
}
