import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { minimatch } from "minimatch";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import {
  validateChangedPaths,
  type Violation,
} from "../policy/path-policy-validator.js";
import type { ResolvedPolicy } from "../policy/schema.js";
import {
  createRunLog,
  type RunMeta,
  type RunStatus,
  type SafetyStatus,
} from "../logging/run-log.js";
import { writeArtifact } from "../logging/artifacts.js";
import { generateRunId } from "./run-id.js";
import { acquireDomainLock } from "../workspace/domain-lock.js";
import { runBranchName } from "../workspace/branch-name.js";
import { createWorktree } from "../workspace/git-worktree.js";
import { collectDiff, resolveBaseSha } from "../git/diff.js";
import { buildCodexPrompt } from "../codex/prompt-builder.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { buildSummary } from "../reporter/summary.js";
import { buildKnowledgeCandidates } from "../reporter/knowledge-candidates.js";
import { buildReviewRequest } from "../reporter/review-request.js";
import { buildReviewDecision } from "../reporter/review-decision.js";
import { buildUntrackedPatch } from "../reporter/untracked-patch.js";

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
  now?: Date;
}

export interface RunDomainCodingResult {
  runId: string;
  status: RunStatus;
  safetyStatus: SafetyStatus;
}

const MATCH_OPTS = { dot: true, nocomment: true } as const;

async function readTail(path: string, maxBytes = 8 * 1024): Promise<string> {
  try {
    const buf = await readFile(path);
    if (buf.length <= maxBytes) return buf.toString("utf8");
    return buf.subarray(buf.length - maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

function partitionUntracked(
  paths: readonly string[],
  ignoreGlobs: readonly string[],
): { kept: string[]; ignored: string[] } {
  if (ignoreGlobs.length === 0) return { kept: [...paths], ignored: [] };
  const kept: string[] = [];
  const ignored: string[] = [];
  for (const p of paths) {
    if (ignoreGlobs.some((g) => minimatch(p, g, MATCH_OPTS))) {
      ignored.push(p);
    } else {
      kept.push(p);
    }
  }
  return { kept, ignored };
}

interface DiffOutcome {
  ok: boolean;
  error?: string;
  trackedChangedPaths: string[];
  untrackedAll: string[];
  patch: string;
}

async function attemptDiff(
  worktreePath: string,
  baseSha: string,
  gitTimeoutMs: number,
): Promise<DiffOutcome> {
  try {
    const d = await collectDiff({
      repoPath: worktreePath,
      baseSha,
      timeoutMs: gitTimeoutMs,
    });
    return {
      ok: true,
      trackedChangedPaths: d.trackedChangedPaths,
      untrackedAll: d.untrackedPaths,
      patch: d.patch,
    };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      trackedChangedPaths: [],
      untrackedAll: [],
      patch: "",
    };
  }
}

export async function runDomainCoding(
  opts: RunDomainCodingOpts,
): Promise<RunDomainCodingResult> {
  const paths = harnessPaths(opts.harnessRoot);
  const global = await loadGlobalPolicy(paths.globalPolicyPath);
  const repo = await loadRepoPolicy(paths.repoPolicyPath(opts.repoId));
  const policy: ResolvedPolicy = resolvePolicy(global, repo, opts.domain);
  const gitTimeoutMs = policy.limits.gitTimeoutMs;

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

    const diff = await attemptDiff(wt.path, baseSha, gitTimeoutMs);
    if (!diff.ok) {
      await log.emit({
        type: "diff_collection_failed",
        error: diff.error,
      });
    }

    // Apply harness-side ignore_untracked filter (we no longer rely on
    // --exclude-standard so codex cannot hide changes in .gitignore'd paths).
    const { kept: untrackedKept, ignored: untrackedIgnored } =
      partitionUntracked(diff.untrackedAll, policy.ignoreUntracked);

    await writeArtifact(join(log.runDir, "final-diff.patch"), diff.patch);
    if (untrackedKept.length > 0) {
      await writeArtifact(
        join(log.runDir, "untracked-files.txt"),
        `${untrackedKept.join("\n")}\n`,
      );
      const untrackedPatch = await buildUntrackedPatch(wt.path, untrackedKept);
      await writeArtifact(
        join(log.runDir, "untracked-files.patch"),
        untrackedPatch,
      );
    }
    if (diff.ok) {
      await log.emit({
        type: "diff_collected",
        tracked: diff.trackedChangedPaths,
        untracked: untrackedKept,
        ignored: untrackedIgnored,
      });
    }

    // Validate every path codex touched that wasn't explicitly ignored.
    // When diff collection failed we cannot trust the empty list, so safety
    // status is "skipped" rather than "allowed".
    let safetyStatus: SafetyStatus;
    let violations: Violation[] = [];
    if (!diff.ok) {
      safetyStatus = "skipped";
    } else {
      const allChangedPaths = [...diff.trackedChangedPaths, ...untrackedKept];
      const validation = validateChangedPaths(policy, allChangedPaths);
      violations = validation.violations;
      safetyStatus = validation.status === "allowed" ? "allowed" : "denied";
      await log.emit({
        type: "policy_validation_completed",
        status: validation.status,
      });
    }
    await log.setSafetyStatus(safetyStatus);

    // Status priority:
    //   diff failure > codex timeout > codex non-zero > policy violation > needs_review
    // safetyStatus is reported independently so callers can detect e.g.
    // "timeout AND scope violation" cases.
    let status: RunStatus;
    if (!diff.ok) {
      status = "failed-diff-collection";
    } else if (codex.timedOut) {
      status = "failed-codex-timeout";
    } else if (codex.exitCode !== 0) {
      status = "failed-codex";
    } else if (safetyStatus === "denied") {
      status = "failed-policy-violation";
    } else {
      status = "needs_review";
      await log.setStatus("verified");
    }

    const codexStdoutTail = await readTail(codexStdoutPath);
    const codexStderrTail = await readTail(codexStderrPath);
    const finalDiffPath = join(log.runDir, "final-diff.patch");
    const summaryPath = join(log.runDir, "summary.md");
    const knowledgeCandidatesPath = join(
      log.runDir,
      "knowledge-candidates.yaml",
    );
    const reviewDecisionPath = join(log.runDir, "review-decision.yaml");
    const untrackedPatchPath =
      untrackedKept.length > 0
        ? join(log.runDir, "untracked-files.patch")
        : undefined;

    const summary = buildSummary({
      runId,
      domain: opts.domain,
      goal: opts.goal,
      status,
      safetyStatus,
      changedPaths: diff.trackedChangedPaths,
      untrackedPaths: untrackedKept,
      ignoredUntrackedPaths: untrackedIgnored,
      violations,
      codexExitCode: codex.exitCode,
      codexTimedOut: codex.timedOut,
      codexStdoutTail,
      codexStderrTail,
      ...(diff.error ? { diffCollectionError: diff.error } : {}),
    });
    await writeArtifact(summaryPath, summary);

    const knowledge = buildKnowledgeCandidates({
      runId,
      domain: opts.domain,
      status,
      violations,
    });
    await writeArtifact(knowledgeCandidatesPath, knowledge);

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
        safetyStatus,
        baseSha,
        runBranch: branch,
        worktreePath: wt.path,
        changedPaths: diff.trackedChangedPaths,
        untrackedPaths: untrackedKept,
        ignoredUntrackedPaths: untrackedIgnored,
        violations,
        codexExitCode: codex.exitCode,
        codexTimedOut: codex.timedOut,
        codexStdoutTail,
        codexStderrTail,
        ...(diff.error ? { diffCollectionError: diff.error } : {}),
        finalDiffPath,
        ...(untrackedPatchPath ? { untrackedPatchPath } : {}),
        summaryPath,
        knowledgeCandidatesPath,
        reviewDecisionPath,
      }),
    );

    // Worktree intentionally kept regardless of status — review and cleanup
    // are deferred to a follow-up tool that consumes review-decision.yaml.

    await log.finalize({
      status,
      safetyStatus,
      finishedAt: new Date().toISOString(),
    });
    await log.emit({ type: "run_completed", status, safetyStatus });
    return { runId, status, safetyStatus };
  } finally {
    await lock.release();
  }
}
