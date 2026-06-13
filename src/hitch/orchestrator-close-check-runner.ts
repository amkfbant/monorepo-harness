import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { harnessPaths } from "../config/paths.js";
import { withManagedDb } from "../db/managed-connection.js";
import { runAllowedCommands } from "../core/command-runner.js";
import { collectDiff } from "../git/diff.js";
import {
  assertPathsSubset,
  assertReviewedFingerprintMatches,
  reviewedPathsFromMeta,
} from "../core/reviewed-branch-push.js";
import type { RunMeta } from "../logging/run-log.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { partitionUntracked } from "../policy/untracked-filter.js";
import type { ResolvedCommand } from "../policy/schema.js";
import { containsLikelySecret } from "../reporter/secret-scan.js";
import { evaluateCloseConditions } from "./close-checks.js";
import {
  lastCloseCheckInvalidatingMutationAt,
} from "./convergence.js";
import { HitchRepository } from "./repository.js";
import type {
  HitchCloseCheckStatus,
  HitchAttemptType,
  HitchCloseCondition,
  HitchSession,
} from "./types.js";
import type {
  HitchRunContext,
  OrchestratorRunnerDeps,
} from "./orchestrator-runners.js";

type CloseCheckRunnerDeps = Pick<
  OrchestratorRunnerDeps,
  "dbPath" | "harnessRoot" | "createdBy" | "projectRuntime"
>;

export interface RunCommandCloseChecksInput {
  deps: CloseCheckRunnerDeps;
  hitchId: string;
  resolveContext: (session: HitchSession) => HitchRunContext;
}

export interface RunCommandCloseChecksResult {
  runId: string;
  checked: number;
  passed: number;
  failed: number;
}

interface LatestCodingRun {
  runId: string;
  iteration: number;
}

const CODING_ATTEMPT_TYPES = new Set<HitchAttemptType>(["implement", "rerun"]);
const RUNNABLE_CLOSE_CHECK_STATUSES = new Set<HitchCloseCheckStatus>([
  "pending",
  "skipped",
  "unknown",
]);
const CLOSE_CHECK_LOG_EXCERPT_BYTES = 8 * 1024;

function latestCodingRun(repo: HitchRepository, hitchId: string): LatestCodingRun {
  const attempts = repo.listAttempts(hitchId);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    if (typeof attempt.runId === "string" && attempt.runId !== "") {
      return { runId: attempt.runId, iteration: attempt.iteration };
    }
  }
  throw new Error(
    `hitch ${hitchId} has no recorded run yet; run the coder before reviewing`,
  );
}

function displayResolvedCommand(command: ResolvedCommand): string {
  if (command.shell) return command.cmd;
  return [command.cmd, ...command.args].join(" ");
}

// Assert the worktree's policy-relevant surface still equals the run's IMMUTABLE
// reviewed record (meta.reviewed) — the exact state `harness pr create` will
// commit. Validating against the reviewed record (not a self-relative before/
// after) means a worktree ALREADY polluted before close-check is rejected too
// (review finding P0): its baseline is checked, not just whether the command
// left it unchanged. Two complementary gates, reused from the PR-creation path:
//   - assertPathsSubset: the current policy surface (tracked changes vs the
//     RECORDED base + untracked survivors of policy.ignoreUntracked, the same
//     surface collectDiff feeds to write-scope validation) introduces NO path
//     beyond the reviewed set — catches new/`.gitignore`'d-but-kept files.
//   - assertReviewedFingerprintMatches: the reviewed paths' content still
//     matches the approved fingerprint (lstat/O_NOFOLLOW: symlink swaps,
//     retargets, chmod, and content edits all flip it).
async function assertWorktreeMatchesReviewed(opts: {
  worktreePath: string;
  baseSha: string;
  ignoreUntracked: readonly string[];
  meta: RunMeta;
  runId: string;
  reviewedPaths: string[];
  phase: string;
  gitTimeoutMs: number;
}): Promise<void> {
  const diff = await collectDiff({
    repoPath: opts.worktreePath,
    baseSha: opts.baseSha,
    timeoutMs: opts.gitTimeoutMs,
  });
  if (diff.stagedChangedPaths.length > 0) {
    throw new Error(
      `close-check ${opts.phase} staged index contains path(s): ` +
        diff.stagedChangedPaths.join(", "),
    );
  }
  const { kept } = partitionUntracked(diff.untrackedPaths, opts.ignoreUntracked);
  assertPathsSubset(
    [...diff.trackedChangedPaths, ...kept],
    opts.reviewedPaths,
    `close-check ${opts.phase} worktree`,
  );
  await assertReviewedFingerprintMatches({
    worktree: opts.worktreePath,
    meta: opts.meta,
    runId: opts.runId,
    reviewedPaths: opts.reviewedPaths,
    refusal: `run close checks (${opts.phase})`,
  });
}

function resolveCommandForCondition(input: {
  condition: HitchCloseCondition;
  commands: readonly ResolvedCommand[];
}): ResolvedCommand {
  const selector = input.condition.command ?? input.condition.id;
  // A condition WITH an explicit `command` may select by policy command id or
  // by the exact display command string. A condition WITHOUT `command` selects
  // by condition id ONLY — matching a bare condition on the display string
  // would broaden what it can execute (review finding P2).
  const matches =
    input.condition.command !== undefined
      ? input.commands.filter(
          (command) =>
            command.id === selector ||
            displayResolvedCommand(command) === selector,
        )
      : input.commands.filter((command) => command.id === selector);
  if (matches.length === 1) return matches[0] as ResolvedCommand;
  if (matches.length > 1) {
    throw new Error(
      `close-check condition ${input.condition.id} resolves ambiguously to ` +
        `policy command ${selector}; request external evidence or disambiguate ` +
        `the condition command`,
    );
  }
  throw new Error(
    `close-check condition ${input.condition.id} requires command ` +
      `${JSON.stringify(selector)}, but it is not in the resolved domain ` +
      `policy allowlist; request external evidence instead`,
  );
}

async function resolvedPolicyForCloseCheck(
  deps: CloseCheckRunnerDeps,
  context: HitchRunContext,
) {
  const paths = harnessPaths(deps.harnessRoot);
  const { global, repo } = deps.projectRuntime?.compiledPolicy ?? {
    global: await loadGlobalPolicy(paths.globalPolicyPath),
    repo: await loadRepoPolicy(paths.repoPolicyPath(context.repoId)),
  };
  return resolvePolicy(global, repo, context.domain);
}

function pendingCommandCloseConditions(input: {
  repo: HitchRepository;
  session: HitchSession;
}): HitchCloseCondition[] {
  const attempts = input.repo.listAttempts(input.session.hitchId);
  const close = evaluateCloseConditions({
    conditions: input.session.closeConditions,
    checks: input.repo.listCloseChecks(input.session.hitchId),
    findingCounts: input.repo.countFindingSummary(input.session.hitchId),
    freshAfter: lastCloseCheckInvalidatingMutationAt({
      attempts,
      latestFindingMutationAt: input.repo.latestFindingMutationAt(
        input.session.hitchId,
      ),
      cycles: input.repo.listReviewCycles(input.session.hitchId),
    }),
    allowEmptyCloseConditions: input.session.policy.allowEmptyCloseConditions,
  });
  // Only REQUIRED, runnable command conditions gate close.
  // - required: optional/advisory conditions never block close, and running a
  //   non-allowlisted optional command would throw before the required evidence
  //   is recorded (review finding P1).
  // - pending/skipped/unknown: `skipped`/`unknown` are inconclusive required
  //   command evidence, so a deterministic re-run is safe and bounded.
  // - not failed: a `failed` condition was already checked against the current
  //   run and routes to needs_fix (coder rerun); re-running it here would
  //   re-execute a known-failed check and could overwrite the failed evidence
  //   with a passed one on the same run. A fresh run invalidates the stale check
  //   back to `pending`.
  return close.conditions
    .filter(
      (evaluated) =>
        evaluated.condition.required &&
        evaluated.condition.kind === "command" &&
        RUNNABLE_CLOSE_CHECK_STATUSES.has(evaluated.status),
    )
    .map((evaluated) => evaluated.condition);
}

const CLOSE_CHECK_OUTPUT_WITHHELD =
  "[redacted: secret-shaped content detected; close-check output withheld]";

// Read the tail of a close-check log for injection into the next coder prompt.
// Fail-closed at the SOURCE: scan the FULL file buffer for secrets BEFORE the
// 8KiB tail clip. Slicing first would let a secret sitting just before the tail
// boundary lose its prefix/header (e.g. `ghp_`, `-----BEGIN PRIVATE KEY-----`)
// while its suffix/body survives into the evidence and the coder prompt. Only
// real, secret-free content is sliced and returned; on ANY match we return the
// whole-stream withheld marker.
async function readLogExcerpt(path: string): Promise<string> {
  try {
    const buffer = await readFile(path);
    if (containsLikelySecret(buffer.toString("utf8"))) {
      return CLOSE_CHECK_OUTPUT_WITHHELD;
    }
    const sliced =
      buffer.length > CLOSE_CHECK_LOG_EXCERPT_BYTES
        ? buffer.subarray(buffer.length - CLOSE_CHECK_LOG_EXCERPT_BYTES)
        : buffer;
    return sliced.toString("utf8");
  } catch (e) {
    return `[unavailable: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

export async function runCommandCloseChecks(
  input: RunCommandCloseChecksInput,
): Promise<RunCommandCloseChecksResult> {
  let attemptId: string | null = null;
  try {
    const prep = withManagedDb({ dbPath: input.deps.dbPath }, (db) => {
      const repo = new HitchRepository(db);
      const session = repo.requireSession(input.hitchId);
      const context = input.resolveContext(session);
      const latest = latestCodingRun(repo, input.hitchId);
      const conditions = pendingCommandCloseConditions({ repo, session });
      if (conditions.length === 0) {
        throw new Error(
          `hitch ${input.hitchId} has no command close checks requiring ` +
            `execution; request external evidence for the remaining ` +
            `close conditions`,
        );
      }
      // The run's RECORDED base SHA + reviewed record — the exact anchors the
      // post-hoc policy diff and `harness pr create` use. Required to verify the
      // close-check ran over (and left) the reviewed surface; without them we
      // cannot prove it, so fail-closed rather than guess (e.g. HEAD).
      const runRow = db
        .prepare("SELECT base_sha, meta_json FROM runs WHERE run_id = ?")
        .get(latest.runId) as
        | { base_sha: string | null; meta_json: string | null }
        | undefined;
      const baseSha = runRow?.base_sha;
      if (typeof baseSha !== "string" || baseSha === "") {
        throw new Error(
          `run ${latest.runId} has no recorded base_sha; cannot verify the ` +
            `close-check left the worktree clean — request external evidence`,
        );
      }
      if (runRow?.meta_json == null) {
        throw new Error(
          `run ${latest.runId} has no recorded meta; cannot verify the ` +
            `worktree against the reviewed state — request external evidence`,
        );
      }
      const meta = JSON.parse(runRow.meta_json) as RunMeta;
      const reviewedPaths = reviewedPathsFromMeta(meta, latest.runId);
      const attempt = repo.createAttempt({
        hitchId: input.hitchId,
        attemptType: "close-check",
        status: "running",
        runId: latest.runId,
        iteration: latest.iteration,
        input: { conditionIds: conditions.map((c) => c.id) },
      });
      return {
        attemptId: attempt.attemptId,
        context,
        runId: latest.runId,
        baseSha,
        meta,
        reviewedPaths,
        conditions,
      };
    });
    attemptId = prep.attemptId;

    const policy = await resolvedPolicyForCloseCheck(input.deps, prep.context);
    const commandByCondition = prep.conditions.map((condition) => ({
      condition,
      command: resolveCommandForCondition({
        condition,
        commands: policy.allowedCommands,
      }),
    }));
    const commandsById = new Map<string, ResolvedCommand>();
    for (const item of commandByCondition) {
      commandsById.set(item.command.id, item.command);
    }

    const paths = harnessPaths(input.deps.harnessRoot);
    const worktreePath = join(paths.workspacesDir, prep.runId, "repo");
    if (!existsSync(worktreePath)) {
      throw new Error(
        `worktree for ${prep.runId} is gone (cleaned up); cannot run ` +
          `command close checks`,
      );
    }
    // A close-check command MUST NOT mutate the run worktree: evidence is
    // recorded only in the DB and runs/<runId>/close-checks/, and the post-hoc
    // policy diff (and `harness pr create`) commit only the reviewed surface.
    // BEFORE: the baseline worktree must already equal the reviewed state — a
    // tree polluted between review and close-check is rejected here, not used as
    // the baseline (review finding P0). AFTER: the command must have left that
    // reviewed surface untouched.
    await assertWorktreeMatchesReviewed({
      worktreePath,
      baseSha: prep.baseSha,
      ignoreUntracked: policy.ignoreUntracked,
      meta: prep.meta,
      runId: prep.runId,
      reviewedPaths: prep.reviewedPaths,
      phase: "baseline",
      gitTimeoutMs: policy.limits.gitTimeoutMs,
    });
    const cmdRun = await runAllowedCommands({
      worktreePath,
      commands: [...commandsById.values()],
      logDir: join(paths.runsDir, prep.runId, "close-checks"),
      timeoutMs: policy.commandDefaults.timeoutMs,
      ...(policy.commandDefaults.envAllowlist !== undefined
        ? { envAllowlist: policy.commandDefaults.envAllowlist }
        : {}),
    });
    await assertWorktreeMatchesReviewed({
      worktreePath,
      baseSha: prep.baseSha,
      ignoreUntracked: policy.ignoreUntracked,
      meta: prep.meta,
      runId: prep.runId,
      reviewedPaths: prep.reviewedPaths,
      phase: "post-command",
      gitTimeoutMs: policy.limits.gitTimeoutMs,
    });
    const resultByCommandId = new Map(
      cmdRun.results.map((result) => [result.id, result]),
    );
    const logExcerptByCommandId = new Map(
      await Promise.all(
        cmdRun.results.map(async (result) => [
          result.id,
          {
            stdoutTail: await readLogExcerpt(result.stdoutPath),
            stderrTail: await readLogExcerpt(result.stderrPath),
          },
        ] as const),
      ),
    );

    let passed = 0;
    let failed = 0;
    withManagedDb({ dbPath: input.deps.dbPath }, (db) => {
      const repo = new HitchRepository(db);
      for (const item of commandByCondition) {
        const result = resultByCommandId.get(item.command.id);
        if (result === undefined) {
          throw new Error(
            `missing command result for close-check command ` +
              `${item.command.id}`,
          );
        }
        const status =
          result.exitCode === 0 && !result.timedOut ? "passed" : "failed";
        const excerpts = logExcerptByCommandId.get(item.command.id);
        if (status === "passed") passed += 1;
        else failed += 1;
        repo.recordCloseCheck({
          hitchId: input.hitchId,
          conditionId: item.condition.id,
          status,
          checkedBy: input.deps.createdBy,
          evidence: {
            runId: prep.runId,
            conditionKind: "command",
            policyCommandId: item.command.id,
            command: result.command,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            stdoutPath: result.stdoutPath,
            stderrPath: result.stderrPath,
            stdoutTail: excerpts?.stdoutTail ?? "",
            stderrTail: excerpts?.stderrTail ?? "",
          },
          message:
            status === "passed"
              ? `command close-check passed: ${result.command}`
              : `command close-check failed: ${result.command} ` +
                `(exit=${result.exitCode}, timedOut=${result.timedOut})`,
        });
      }
      repo.completeAttempt({
        attemptId: prep.attemptId,
        status: cmdRun.allPassed ? "succeeded" : "failed",
        runId: prep.runId,
        result: {
          checked: commandByCondition.length,
          passed,
          failed,
          commandResults: cmdRun.results.map((result) => ({
            id: result.id,
            command: result.command,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            stdoutPath: result.stdoutPath,
            stderrPath: result.stderrPath,
          })),
        },
      });
    });
    return {
      runId: prep.runId,
      checked: commandByCondition.length,
      passed,
      failed,
    };
  } catch (e) {
    if (attemptId !== null) {
      try {
        withManagedDb({ dbPath: input.deps.dbPath }, (db) => {
          new HitchRepository(db).completeAttempt({
            attemptId: attemptId as string,
            status: "failed",
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        });
      } catch {
        // Preserve the original close-check failure.
      }
    }
    throw e;
  }
}
