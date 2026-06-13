import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { harnessPaths } from "../config/paths.js";
import { withManagedDb } from "../db/managed-connection.js";
import { runAllowedCommands } from "../core/command-runner.js";
import { gitCliOrThrow } from "../git/git-cli.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import type { ResolvedCommand } from "../policy/schema.js";
import { evaluateCloseConditions } from "./close-checks.js";
import {
  lastCloseCheckInvalidatingMutationAt,
} from "./convergence.js";
import { HitchRepository } from "./repository.js";
import type {
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

// A deterministic fingerprint of the worktree's policy-relevant surface
// (tracked changes + non-ignored untracked files), keyed by path with a content
// hash. Comparing two fingerprints detects ANY mutation a close-check command
// makes — including a content change to a file that was ALREADY dirty from the
// coder run (whose `git status` porcelain line is unchanged) and writes to new
// untracked files. Ignored files are intentionally excluded: they never enter
// the post-hoc policy diff. Used to fail-closed if a command dirties the tree.
async function worktreePolicyFingerprint(worktreePath: string): Promise<string> {
  const status = await gitCliOrThrow(
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: worktreePath },
  );
  const lines = status.split("\n").filter((line) => line.trim() !== "");
  const parts: string[] = [];
  for (const line of lines) {
    const code = line.slice(0, 2);
    const rawPath = line.slice(3);
    // Renames render as "old -> new"; fingerprint the destination content.
    const path = rawPath.includes(" -> ")
      ? rawPath.slice(rawPath.indexOf(" -> ") + 4)
      : rawPath;
    let hash = "absent";
    try {
      hash = createHash("sha256")
        .update(await readFile(join(worktreePath, path)))
        .digest("hex");
    } catch {
      // deleted or unreadable entry → keep the "absent" content marker
    }
    parts.push(`${code} ${path}\t${hash}`);
  }
  return parts.join("\n");
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
  // Only REQUIRED, PENDING command conditions gate close.
  // - required: optional/advisory conditions never block close, and running a
  //   non-allowlisted optional command would throw before the required evidence
  //   is recorded (review finding P1).
  // - pending only: a `failed` condition was already checked against the
  //   current run and routes to needs_fix (coder rerun); re-running it here
  //   would re-execute a known-failed check and could overwrite the failed
  //   evidence with a passed one on the same run (review finding P1, retry 2).
  //   A fresh run invalidates the stale check back to `pending`.
  return close.conditions
    .filter(
      (evaluated) =>
        evaluated.condition.required &&
        evaluated.condition.kind === "command" &&
        evaluated.status === "pending",
    )
    .map((evaluated) => evaluated.condition);
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
    // policy diff is computed from this tree. Fingerprint the worktree's
    // policy-relevant surface (content-hashed) before and after; if an
    // allowlisted command changed ANY entry — including re-writing a file that
    // was already dirty from the coder run — fail-closed rather than record a
    // `passed` check over a polluted tree (review findings P1/P0).
    const fingerprintBefore = await worktreePolicyFingerprint(worktreePath);
    const cmdRun = await runAllowedCommands({
      worktreePath,
      commands: [...commandsById.values()],
      logDir: join(paths.runsDir, prep.runId, "close-checks"),
      timeoutMs: policy.commandDefaults.timeoutMs,
      ...(policy.commandDefaults.envAllowlist !== undefined
        ? { envAllowlist: policy.commandDefaults.envAllowlist }
        : {}),
    });
    const fingerprintAfter = await worktreePolicyFingerprint(worktreePath);
    if (fingerprintAfter !== fingerprintBefore) {
      const beforeLines = new Set(fingerprintBefore.split("\n"));
      const afterLines = new Set(fingerprintAfter.split("\n"));
      const added = fingerprintAfter
        .split("\n")
        .filter((line) => line !== "" && !beforeLines.has(line))
        .map((line) => `+ ${line}`);
      const removed = fingerprintBefore
        .split("\n")
        .filter((line) => line !== "" && !afterLines.has(line))
        .map((line) => `- ${line}`);
      throw new Error(
        `close-check commands mutated the run worktree (${prep.runId}); ` +
          `close-checks must not write into the repo tree (write-scope / ` +
          `post-hoc diff integrity). Changed entries:\n` +
          [...added, ...removed].join("\n"),
      );
    }
    const resultByCommandId = new Map(
      cmdRun.results.map((result) => [result.id, result]),
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
