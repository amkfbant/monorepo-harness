#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "./parse-args.js";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { runDomainCoding } from "../core/workflow-runner.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const harnessRoot = process.env.HARNESS_ROOT ?? process.cwd();
  const paths = harnessPaths(harnessRoot);

  if (args.dryRun) {
    const global = await loadGlobalPolicy(paths.globalPolicyPath);
    const repo = await loadRepoPolicy(paths.repoPolicyPath(args.repoId));
    const resolved = resolvePolicy(global, repo, args.domain);
    process.stdout.write(
      `resolved policy for ${resolved.domain}:\n${JSON.stringify(resolved, null, 2)}\n`,
    );
    return;
  }

  // Resolve policy once up-front so the codex runner can be configured from it.
  const global = await loadGlobalPolicy(paths.globalPolicyPath);
  const repo = await loadRepoPolicy(paths.repoPolicyPath(args.repoId));
  const resolved = resolvePolicy(global, repo, args.domain);

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
  const runner = createCodexCliRunner({
    codexBin,
    sandbox: resolved.codex.sandbox,
    ...(resolved.codex.approval !== undefined
      ? { approvalPolicy: resolved.codex.approval }
      : {}),
  });

  const result = await runDomainCoding({
    harnessRoot,
    repoPath: args.repo,
    repoId: args.repoId,
    domain: args.domain,
    goal: args.goal,
    baseBranch: args.baseBranch,
    keepWorktree: args.keepWorktree,
    codexRunner: runner,
  });
  process.stdout.write(`run=${result.runId} status=${result.status}\n`);
  if (
    result.status === "failed-policy-violation" ||
    result.status === "failed-codex" ||
    result.status === "failed-codex-timeout" ||
    result.status === "failed-command" ||
    result.status === "failed-internal-error"
  ) {
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`harness error: ${(e as Error).message}\n`);
  process.exit(2);
});
