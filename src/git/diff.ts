import { gitCliOrThrow } from "./git-cli.js";

export interface DiffResult {
  changedPaths: string[];
  patch: string;
}

export interface DiffOpts {
  repoPath: string;
  baseBranch: string;
}

export async function collectDiff(opts: DiffOpts): Promise<DiffResult> {
  await gitCliOrThrow(["add", "-N", "."], { cwd: opts.repoPath });
  const names = await gitCliOrThrow(
    ["diff", "--name-only", opts.baseBranch],
    { cwd: opts.repoPath },
  );
  const patch = await gitCliOrThrow(["diff", opts.baseBranch], {
    cwd: opts.repoPath,
  });
  const changedPaths = names
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { changedPaths, patch };
}
