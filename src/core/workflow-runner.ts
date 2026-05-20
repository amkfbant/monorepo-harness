import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { minimatch } from "minimatch";
import { stringify as yamlStringify } from "yaml";
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
import { runAllowedCommands } from "./command-runner.js";
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
import {
  buildUntrackedPatch,
  buildUntrackedDeniedReport,
  buildUntrackedSecretsReport,
} from "../reporter/untracked-patch.js";

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
  /**
   * Set when this run is a rerun spawned from a previous changes_requested
   * run. Recorded in meta.json so reviewers can follow the chain.
   */
  parentRunId?: string;
}

export interface RunDomainCodingResult {
  runId: string;
  status: RunStatus;
  safetyStatus: SafetyStatus;
  ignoredUntrackedCount: number;
  secretSuspectCount: number;
  commandResults: Array<{
    command: string;
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
  }>;
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

/**
 * Codex sometimes echoes the diff it just applied into stderr (via the
 * `git apply` subprocess), which then floods review-request.md and
 * summary.md. Truncate at the first `diff --git` block so reviewers see
 * the real error message instead of a re-quoted patch.
 */
export function filterPatchEcho(stderr: string): string {
  if (stderr === "") return "";
  const m = stderr.match(/(^|\n)diff --git /);
  if (!m) return stderr;
  const head = stderr.slice(0, m.index! + (m[1] ?? "").length).trimEnd();
  return `${head}\n[stderr omitted: patch-like output detected after this point]`;
}

async function readStderrTail(
  path: string,
  maxBytes = 8 * 1024,
): Promise<string> {
  return filterPatchEcho(await readTail(path, maxBytes));
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

interface DiffAndValidate {
  diff: DiffOutcome;
  untrackedKept: string[];
  untrackedIgnored: string[];
  violations: Violation[];
  safetyStatus: SafetyStatus;
}

async function diffAndValidate(opts: {
  worktreePath: string;
  baseSha: string;
  gitTimeoutMs: number;
  policy: ResolvedPolicy;
}): Promise<DiffAndValidate> {
  const diff = await attemptDiff(
    opts.worktreePath,
    opts.baseSha,
    opts.gitTimeoutMs,
  );
  const { kept: untrackedKept, ignored: untrackedIgnored } = partitionUntracked(
    diff.untrackedAll,
    opts.policy.ignoreUntracked,
  );
  let violations: Violation[] = [];
  let safetyStatus: SafetyStatus;
  if (!diff.ok) {
    safetyStatus = "skipped";
  } else {
    const allChangedPaths = [...diff.trackedChangedPaths, ...untrackedKept];
    const validation = validateChangedPaths(opts.policy, allChangedPaths);
    violations = validation.violations;
    safetyStatus = validation.status === "allowed" ? "allowed" : "denied";
  }
  return { diff, untrackedKept, untrackedIgnored, violations, safetyStatus };
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
        ...(opts.parentRunId !== undefined
          ? { parentRunId: opts.parentRunId }
          : {}),
        startedAt,
      },
    });

    // Any failure after createRunLog leaves meta.status='running' on disk.
    // Wrap the rest of the workflow so unexpected throws still finalize the
    // run as failed-internal-error instead of silently rotting the status.
    try {
      return await runDomainCodingInner({
        opts,
        policy,
        paths,
        runId,
        branch,
        baseSha,
        gitTimeoutMs,
        log,
      });
    } catch (e) {
      await log
        .emit({ type: "run_failed", error: (e as Error).message })
        .catch(() => {});
      await log
        .finalize({
          status: "failed-internal-error",
          safetyStatus: "skipped",
          ignoredUntrackedCount: 0,
          secretSuspectCount: 0,
          commandResults: [],
          changedFilesCount: 0,
          finishedAt: new Date().toISOString(),
        })
        .catch(() => {});
      throw e;
    }
  } finally {
    await lock.release();
  }
}

interface InnerOpts {
  opts: RunDomainCodingOpts;
  policy: ResolvedPolicy;
  paths: ReturnType<typeof harnessPaths>;
  runId: string;
  branch: string;
  baseSha: string;
  gitTimeoutMs: number;
  log: Awaited<ReturnType<typeof createRunLog>>;
}

async function runDomainCodingInner(
  inner: InnerOpts,
): Promise<RunDomainCodingResult> {
  const { opts, policy, paths, runId, branch, baseSha, gitTimeoutMs, log } =
    inner;
    await log.emit({ type: "run_started", runId, baseSha });
    await writeArtifact(
      join(log.runDir, "resolved-policy.yaml"),
      yamlStringify(policy),
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

    // Pass 1: post-codex diff + validation. This determines whether commands
    // are safe to invoke (we don't want to run npm test in a worktree that
    // already violates write scope).
    let dv = await diffAndValidate({
      worktreePath: wt.path,
      baseSha,
      gitTimeoutMs,
      policy,
    });
    if (!dv.diff.ok) {
      await log.emit({ type: "diff_collection_failed", error: dv.diff.error });
    } else {
      await log.emit({
        type: "policy_validation_completed",
        status: dv.safetyStatus === "allowed" ? "allowed" : "denied",
      });
    }

    // Pass 2: run allowed commands and RE-COLLECT diff + RE-VALIDATE. A
    // command (formatter, build script) can modify the worktree in ways
    // path policy would reject; artifacts must reflect the post-command
    // worktree, not the pre-command snapshot.
    let commandResults: Array<{
      command: string;
      exitCode: number;
      durationMs: number;
      timedOut: boolean;
    }> = [];
    let commandsRan = false;
    let commandsPassed = true;
    if (
      dv.diff.ok &&
      dv.safetyStatus === "allowed" &&
      !codex.timedOut &&
      codex.exitCode === 0 &&
      policy.allowedCommands.length > 0
    ) {
      await log.setStatus("verified");
      await log.emit({
        type: "commands_started",
        count: policy.allowedCommands.length,
      });
      const cmdRun = await runAllowedCommands({
        worktreePath: wt.path,
        commands: policy.allowedCommands,
        logDir: join(log.runDir, "commands"),
        timeoutMs: policy.commandDefaults.timeoutMs,
        ...(policy.commandDefaults.envAllowlist !== undefined
          ? { envAllowlist: policy.commandDefaults.envAllowlist }
          : {}),
      });
      commandResults = cmdRun.results.map((r) => ({
        command: r.command,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
      }));
      commandsRan = true;
      commandsPassed = cmdRun.allPassed;
      await log.emit({
        type: "commands_completed",
        results: commandResults,
        allPassed: cmdRun.allPassed,
      });

      // Re-collect diff + re-validate against the post-command worktree.
      dv = await diffAndValidate({
        worktreePath: wt.path,
        baseSha,
        gitTimeoutMs,
        policy,
      });
      if (!dv.diff.ok) {
        await log.emit({
          type: "diff_collection_failed",
          error: dv.diff.error,
          phase: "post-commands",
        });
      } else {
        await log.emit({
          type: "policy_validation_completed",
          status: dv.safetyStatus === "allowed" ? "allowed" : "denied",
          phase: "post-commands",
        });
      }
    }

    const { diff, untrackedKept, untrackedIgnored } = dv;
    const safetyStatus = dv.safetyStatus;
    const violations = dv.violations;
    const violatedPaths = new Set<string>(violations.map((v) => v.path));
    await log.setSafetyStatus(safetyStatus);

    // Split untracked into (allowed, denied). Only allowed content is
    // inlined into untracked-files.patch. Denied paths get a metadata-only
    // report so reviewers can see *what* was there without harness
    // persisting the bytes.
    const untrackedAllowed: string[] = [];
    const untrackedDenied: string[] = [];
    for (const p of untrackedKept) {
      if (violatedPaths.has(p)) untrackedDenied.push(p);
      else untrackedAllowed.push(p);
    }

    await writeArtifact(join(log.runDir, "final-diff.patch"), diff.patch);
    let secretSuspects: { path: string; reasons: string[] }[] = [];
    if (untrackedAllowed.length > 0) {
      await writeArtifact(
        join(log.runDir, "untracked-files.txt"),
        `${untrackedAllowed.join("\n")}\n`,
      );
      const result = await buildUntrackedPatch(wt.path, untrackedAllowed);
      await writeArtifact(
        join(log.runDir, "untracked-files.patch"),
        result.patch,
      );
      secretSuspects = result.secretSuspects;
      if (secretSuspects.length > 0) {
        await writeArtifact(
          join(log.runDir, "untracked-secrets.txt"),
          buildUntrackedSecretsReport(secretSuspects),
        );
        await log.emit({
          type: "secret_suspects_redacted",
          count: secretSuspects.length,
          paths: secretSuspects.map((s) => s.path),
        });
      }
    }
    if (untrackedDenied.length > 0) {
      const deniedReport = await buildUntrackedDeniedReport(
        wt.path,
        untrackedDenied,
      );
      await writeArtifact(
        join(log.runDir, "untracked-denied.txt"),
        deniedReport,
      );
    }
    if (diff.ok) {
      await log.emit({
        type: "diff_collected",
        tracked: diff.trackedChangedPaths,
        untrackedAllowed,
        untrackedDenied,
        ignored: untrackedIgnored,
      });
    }

    // Status priority (evaluated against POST-command worktree if commands ran):
    //   diff failure > codex timeout > codex non-zero > policy violation
    //   > command failure > needs_review
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
      // a denied state here may be (a) codex itself, or (b) a command that
      // wrote outside scope post-validation. Either way → policy violation.
      status = "failed-policy-violation";
    } else if (commandsRan && !commandsPassed) {
      status = "failed-command";
    } else {
      status = "needs_review";
    }

    const codexStdoutTail = await readTail(codexStdoutPath);
    const codexStderrTail = await readStderrTail(codexStderrPath);
    const finalDiffPath = join(log.runDir, "final-diff.patch");
    const summaryPath = join(log.runDir, "summary.md");
    const knowledgeCandidatesPath = join(
      log.runDir,
      "knowledge-candidates.yaml",
    );
    const reviewDecisionPath = join(log.runDir, "review-decision.yaml");
    const untrackedPatchPath =
      untrackedAllowed.length > 0
        ? join(log.runDir, "untracked-files.patch")
        : undefined;

    const secretSuspectPaths = secretSuspects.map((s) => s.path);
    const summary = buildSummary({
      runId,
      domain: opts.domain,
      goal: opts.goal,
      status,
      safetyStatus,
      changedPaths: diff.trackedChangedPaths,
      untrackedPaths: untrackedKept,
      ignoredUntrackedPaths: untrackedIgnored,
      secretSuspectPaths,
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
      secretSuspectCount: secretSuspects.length,
      ignoredUntrackedCount: untrackedIgnored.length,
      changedFilesCount:
        diff.trackedChangedPaths.length + untrackedKept.length,
      codexExitCode: codex.exitCode,
      codexTimedOut: codex.timedOut,
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
        secretSuspectPaths,
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

    const ignoredUntrackedCount = untrackedIgnored.length;
    const secretSuspectCount = secretSuspects.length;
    const changedFilesCount =
      diff.trackedChangedPaths.length + untrackedAllowed.length;
    await log.finalize({
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResults,
      changedFilesCount,
      finishedAt: new Date().toISOString(),
    });
    await log.emit({
      type: "run_completed",
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResultsCount: commandResults.length,
      changedFilesCount,
    });
    return {
      runId,
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResults,
    };
}
