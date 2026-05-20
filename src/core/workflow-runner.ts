import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import {
  validateChangedPaths,
  type Violation,
} from "../policy/path-policy-validator.js";
import {
  createRunLog,
  type RunMeta,
  type RunStatus,
} from "../logging/run-log.js";
import { writeArtifact } from "../logging/artifacts.js";
import { generateRunId } from "./run-id.js";
import { acquireDomainLock } from "../workspace/domain-lock.js";
import { runBranchName } from "../workspace/branch-name.js";
import { createWorktree } from "../workspace/git-worktree.js";
import {
  collectDiff,
  resolveBaseSha,
  type DiffResult,
} from "../git/diff.js";
import { buildCodexPrompt } from "../codex/prompt-builder.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { buildSummary } from "../reporter/summary.js";
import { buildKnowledgeCandidates } from "../reporter/knowledge-candidates.js";
import { buildReviewRequest } from "../reporter/review-request.js";
import { buildReviewDecision } from "../reporter/review-decision.js";

export interface RunLimits {
  /** kill codex after this many ms; default 15 minutes */
  codexTimeoutMs?: number;
  /** abort any single git invocation after this many ms; default 30 seconds */
  gitTimeoutMs?: number;
}

export interface RunDomainCodingOpts {
  harnessRoot: string;
  repoPath: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  /** retained for forward compat with a future cleanup tool; ignored by the workflow */
  keepWorktree?: boolean;
  codexRunner: CodexExecRunner;
  limits?: RunLimits;
  now?: Date;
}

export interface RunDomainCodingResult {
  runId: string;
  status: RunStatus;
}

const DEFAULT_CODEX_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_GIT_TIMEOUT_MS = 30 * 1000;

async function readTail(path: string, maxBytes = 8 * 1024): Promise<string> {
  try {
    const buf = await readFile(path);
    if (buf.length <= maxBytes) return buf.toString("utf8");
    return buf.subarray(buf.length - maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

async function tryCollectDiff(opts: {
  repoPath: string;
  baseSha: string;
  gitTimeoutMs: number;
}): Promise<DiffResult> {
  try {
    return await collectDiff({
      repoPath: opts.repoPath,
      baseSha: opts.baseSha,
      timeoutMs: opts.gitTimeoutMs,
    });
  } catch {
    return { trackedChangedPaths: [], untrackedPaths: [], patch: "" };
  }
}

export async function runDomainCoding(
  opts: RunDomainCodingOpts,
): Promise<RunDomainCodingResult> {
  const paths = harnessPaths(opts.harnessRoot);
  const codexTimeoutMs =
    opts.limits?.codexTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const gitTimeoutMs = opts.limits?.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  const global = await loadGlobalPolicy(paths.globalPolicyPath);
  const repo = await loadRepoPolicy(paths.repoPolicyPath(opts.repoId));
  const policy = resolvePolicy(global, repo, opts.domain);

  // Generate runId BEFORE acquiring the lock so the lock can record who owns it.
  const runId = generateRunId({
    domain: opts.domain,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const branch = runBranchName(runId, opts.domain);
  const startedAt = (opts.now ?? new Date()).toISOString();

  const lock = await acquireDomainLock({
    locksDir: paths.locksDir,
    domain: opts.domain,
    runId,
  });

  try {
    // Pin baseSha BEFORE creating worktree so a concurrent branch move doesn't
    // change what "this run is diffed against".
    const baseSha = await resolveBaseSha({
      repoPath: opts.repoPath,
      baseBranch: opts.baseBranch,
      timeoutMs: gitTimeoutMs,
    });

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
        baseSha,
        runBranch: branch,
        status: "running",
        startedAt,
      },
    });
    await log.emit({ type: "run_started", runId, baseSha });
    await writeArtifact(
      join(log.runDir, "resolved-policy.yaml"),
      JSON.stringify(policy, null, 2),
    );

    const wt = await createWorktree({
      repoPath: opts.repoPath,
      worktreesDir: paths.workspacesDir,
      runId,
      branch,
      base: baseSha,
      timeoutMs: gitTimeoutMs,
    });
    await log.emit({ type: "worktree_created", path: wt.path });

    const prompt = buildCodexPrompt({ goal: opts.goal, policy });
    await writeArtifact(join(log.runDir, "codex-prompt.md"), prompt);

    await log.emit({ type: "codex_exec_started" });
    const codexStdoutPath = join(log.runDir, "codex-output.log");
    const codexStderrPath = join(log.runDir, "codex-error.log");
    const codex = await opts.codexRunner.run({
      worktreePath: wt.path,
      prompt,
      logPaths: { stdout: codexStdoutPath, stderr: codexStderrPath },
    });
    await log.emit({
      type: "codex_exec_completed",
      exitCode: codex.exitCode,
      timedOut: codex.timedOut,
    });
    await log.setStatus("generated");

    // Always attempt a diff — even if codex failed it may have left partial
    // edits in the worktree that reviewers need to see.
    const diff = await tryCollectDiff({
      repoPath: wt.path,
      baseSha,
      gitTimeoutMs,
    });
    await writeArtifact(join(log.runDir, "final-diff.patch"), diff.patch);
    if (diff.untrackedPaths.length > 0) {
      await writeArtifact(
        join(log.runDir, "untracked-files.txt"),
        `${diff.untrackedPaths.join("\n")}\n`,
      );
    }
    await log.emit({
      type: "diff_collected",
      tracked: diff.trackedChangedPaths,
      untracked: diff.untrackedPaths,
    });

    // Validate every path codex touched, not just tracked changes.
    const allChangedPaths = [
      ...diff.trackedChangedPaths,
      ...diff.untrackedPaths,
    ];
    const validation = validateChangedPaths(policy, allChangedPaths);
    const violations: Violation[] = validation.violations;
    await log.emit({
      type: "policy_validation_completed",
      status: validation.status,
    });

    // Determine final status. Codex-side failures (timeout / non-zero exit)
    // take precedence over policy results; policy violations override clean
    // success; otherwise we end at needs_review and KEEP the worktree.
    let status: RunStatus;
    if (codex.timedOut) {
      status = "failed-codex-timeout";
    } else if (codex.exitCode !== 0) {
      status = "failed-codex";
    } else if (validation.status === "denied") {
      status = "failed-policy-violation";
    } else {
      status = "needs_review";
      await log.setStatus("verified");
    }

    const codexStdoutTail = await readTail(codexStdoutPath);
    const summary = buildSummary({
      runId,
      domain: opts.domain,
      goal: opts.goal,
      status,
      changedPaths: diff.trackedChangedPaths,
      untrackedPaths: diff.untrackedPaths,
      violations,
      codexExitCode: codex.exitCode,
      codexTimedOut: codex.timedOut,
      codexStdoutTail,
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

    const reviewDecisionPath = join(log.runDir, "review-decision.yaml");
    await writeArtifact(
      reviewDecisionPath,
      buildReviewDecision({ runId, domain: opts.domain }),
    );
    await writeArtifact(
      join(log.runDir, "review-request.md"),
      buildReviewRequest({
        runId,
        domain: opts.domain,
        goal: opts.goal,
        status,
        baseSha,
        runBranch: branch,
        worktreePath: wt.path,
        changedPaths: diff.trackedChangedPaths,
        untrackedPaths: diff.untrackedPaths,
        violations,
        codexExitCode: codex.exitCode,
        codexTimedOut: codex.timedOut,
        codexStdoutTail,
        finalDiffPath: join(log.runDir, "final-diff.patch"),
        summaryPath: join(log.runDir, "summary.md"),
        knowledgeCandidatesPath: join(log.runDir, "knowledge-candidates.yaml"),
        reviewDecisionPath,
      }),
    );

    // Worktree is intentionally kept regardless of status — review and cleanup
    // are deferred to a follow-up tool that consumes review-decision.yaml.

    await log.finalize({ status, finishedAt: new Date().toISOString() });
    await log.emit({ type: "run_completed", status });
    return { runId, status };
  } finally {
    await lock.release();
  }
}
