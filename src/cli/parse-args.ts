import { Command } from "commander";

export interface ParsedArgs {
  repo: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  keepWorktree: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const cmd = new Command()
    .name("harness")
    .exitOverride()
    .requiredOption("--repo <path>", "target repo path")
    .requiredOption("--repo-id <id>", "repo identifier for policy resolution")
    .requiredOption("--domain <domain>", "target domain (e.g. apps/user)")
    .requiredOption("--goal <text>", "task goal passed to Codex")
    .option("--base-branch <name>", "base branch", "main")
    .option("--keep-worktree", "keep worktree after run", false)
    .option("--dry-run", "resolve policy and exit", false);

  cmd.parse(argv as string[], { from: "user" });
  const o = cmd.opts<{
    repo: string;
    repoId: string;
    domain: string;
    goal: string;
    baseBranch: string;
    keepWorktree: boolean;
    dryRun: boolean;
  }>();
  return {
    repo: o.repo,
    repoId: o.repoId,
    domain: o.domain,
    goal: o.goal,
    baseBranch: o.baseBranch,
    keepWorktree: Boolean(o.keepWorktree),
    dryRun: Boolean(o.dryRun),
  };
}
