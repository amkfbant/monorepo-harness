import { join } from "node:path";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import {
  validateChangedPaths,
  type Violation,
} from "../policy/path-policy-validator.js";
import { createRunLog, type RunMeta } from "../logging/run-log.js";
import { writeArtifact } from "../logging/artifacts.js";
import { nextRunId } from "./run-id.js";
import { acquireDomainLock } from "../workspace/domain-lock.js";
import { runBranchName } from "../workspace/branch-name.js";
import { createWorktree, removeWorktree } from "../workspace/git-worktree.js";
import { collectDiff } from "../git/diff.js";
import { buildCodexPrompt } from "../codex/prompt-builder.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { buildSummary } from "../reporter/summary.js";
import { buildKnowledgeCandidates } from "../reporter/knowledge-candidates.js";

export interface RunDomainCodingOpts {
  harnessRoot: string;
  repoPath: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  keepWorktree: boolean;
  codexRunner: CodexExecRunner;
  now?: Date;
}

export interface RunDomainCodingResult {
  runId: string;
  status: RunMeta["status"];
}

export async function runDomainCoding(
  opts: RunDomainCodingOpts,
): Promise<RunDomainCodingResult> {
  const paths = harnessPaths(opts.harnessRoot);
  const global = await loadGlobalPolicy(paths.globalPolicyPath);
  const repo = await loadRepoPolicy(paths.repoPolicyPath(opts.repoId));
  const policy = resolvePolicy(global, repo, opts.domain);

  const lock = await acquireDomainLock({
    locksDir: paths.locksDir,
    domain: opts.domain,
    runId: "pending",
  });

  try {
    const runId = nextRunId(paths.runsDir, opts.now ?? new Date());
    const branch = runBranchName(runId, opts.domain);
    const startedAt = (opts.now ?? new Date()).toISOString();

    const log = await createRunLog({
      runsDir: paths.runsDir,
      runId,
      meta: {
        runId,
        repoId: opts.repoId,
        repoPath: opts.repoPath,
        domain: opts.domain,
        workflow: "domain-coding",
        baseBranch: opts.baseBranch,
        runBranch: branch,
        status: "running",
        startedAt,
      },
    });
    await log.emit({ type: "run_started", runId });
    await writeArtifact(
      join(log.runDir, "resolved-policy.yaml"),
      JSON.stringify(policy, null, 2),
    );

    const wt = await createWorktree({
      repoPath: opts.repoPath,
      worktreesDir: paths.workspacesDir,
      runId,
      branch,
      baseBranch: opts.baseBranch,
    });
    await log.emit({ type: "worktree_created", path: wt.path });

    const prompt = buildCodexPrompt({ goal: opts.goal, policy });
    await writeArtifact(join(log.runDir, "codex-prompt.md"), prompt);

    await log.emit({ type: "codex_exec_started" });
    const codex = await opts.codexRunner.run({
      worktreePath: wt.path,
      prompt,
      logPaths: {
        stdout: join(log.runDir, "codex-output.log"),
        stderr: join(log.runDir, "codex-error.log"),
      },
    });
    await log.emit({ type: "codex_exec_completed", exitCode: codex.exitCode });

    let status: RunMeta["status"] = "success";
    let violations: Violation[] = [];
    let changedPaths: string[] = [];

    if (codex.exitCode !== 0) {
      status = "failed-codex";
    } else {
      const diff = await collectDiff({
        repoPath: wt.path,
        baseBranch: opts.baseBranch,
      });
      changedPaths = diff.changedPaths;
      await writeArtifact(join(log.runDir, "final-diff.patch"), diff.patch);
      await log.emit({ type: "diff_collected", files: changedPaths });

      const v = validateChangedPaths(policy, changedPaths);
      violations = v.violations;
      status = v.status === "allowed" ? "success" : "failed-policy-violation";
      await log.emit({
        type: "policy_validation_completed",
        status: v.status,
      });
    }

    const summary = buildSummary({
      runId,
      domain: opts.domain,
      goal: opts.goal,
      status,
      changedPaths,
      violations,
      codexExitCode: codex.exitCode,
    });
    await writeArtifact(join(log.runDir, "summary.md"), summary);

    const knowledge = buildKnowledgeCandidates({
      runId,
      domain: opts.domain,
      status,
      violations,
    });
    await writeArtifact(
      join(log.runDir, "knowledge-candidates.yaml"),
      knowledge,
    );

    if (!opts.keepWorktree && status === "success") {
      await removeWorktree({
        repoPath: opts.repoPath,
        worktreePath: wt.path,
        branch,
      });
    }

    await log.finalize({ status, finishedAt: new Date().toISOString() });
    await log.emit({ type: "run_completed", status });
    return { runId, status };
  } finally {
    await lock.release();
  }
}
