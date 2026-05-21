#!/usr/bin/env node
import process from "node:process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { runDomainCoding } from "../core/workflow-runner.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import {
  domainLockName,
  domainLockPath,
  DomainLockError,
  type LockInfo,
} from "../workspace/domain-lock.js";
import {
  processReviewDecision,
  ReviewGateError,
} from "../core/review-processor.js";
import { cleanupRun, CleanupGateError } from "../core/cleanup.js";
import {
  listReviews,
  formatTable,
  formatJson,
} from "../core/review-lister.js";
import { RUN_STATUSES } from "../logging/run-log.js";
import {
  prepareRerunFromReview,
  buildRerunChain,
  formatChain,
  RerunGateError,
  DEFAULT_MAX_ATTEMPTS,
} from "../core/rerun.js";
import {
  runReviewerAgent,
  ReviewerAgentGateError,
} from "../core/reviewer-agent.js";
import { runReviewedRunWorkflow } from "../core/reviewed-run-workflow.js";
import {
  promoteKnowledge,
  rejectKnowledge,
  listKnowledge,
  KnowledgePromoteGateError,
} from "../core/knowledge-promoter.js";

function getHarnessRoot(): string {
  return process.env.HARNESS_ROOT ?? process.cwd();
}

interface RunOpts {
  repo: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  keepWorktree?: boolean;
  dryRun?: boolean;
}

async function cmdRun(o: RunOpts): Promise<void> {
  const harnessRoot = getHarnessRoot();
  const paths = harnessPaths(harnessRoot);
  const global = await loadGlobalPolicy(paths.globalPolicyPath);
  const repo = await loadRepoPolicy(paths.repoPolicyPath(o.repoId));
  const resolved = resolvePolicy(global, repo, o.domain);

  if (o.dryRun) {
    process.stdout.write(
      `resolved policy for ${resolved.domain}:\n${JSON.stringify(resolved, null, 2)}\n`,
    );
    return;
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
  const runner = createCodexCliRunner({
    codexBin,
    sandbox: resolved.codex.sandbox,
    ...(resolved.codex.approval !== undefined
      ? { approvalPolicy: resolved.codex.approval }
      : {}),
    ...(resolved.codex.timeoutMs !== undefined
      ? { timeoutMs: resolved.codex.timeoutMs }
      : {}),
  });

  const result = await runDomainCoding({
    harnessRoot,
    repoPath: o.repo,
    repoId: o.repoId,
    domain: o.domain,
    goal: o.goal,
    baseBranch: o.baseBranch,
    ...(o.keepWorktree !== undefined ? { keepWorktree: o.keepWorktree } : {}),
    codexRunner: runner,
  });
  const cmdTotal = result.commandResults.length;
  const cmdOk = result.commandResults.filter(
    (c) => c.exitCode === 0 && !c.timedOut,
  ).length;
  process.stdout.write(
    `run=${result.runId} status=${result.status} safetyStatus=${result.safetyStatus} ignoredUntrackedCount=${result.ignoredUntrackedCount} secretSuspectCount=${result.secretSuspectCount} commands=${cmdOk}/${cmdTotal}\n`,
  );
  if (
    result.status === "failed-policy-violation" ||
    result.status === "failed-codex" ||
    result.status === "failed-codex-timeout" ||
    result.status === "failed-diff-collection" ||
    result.status === "failed-command" ||
    result.status === "failed-internal-error"
  ) {
    process.exit(1);
  }
}

interface ReviewedRunOpts {
  repo: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  reviewerName?: string;
  maxAttempts: number;
  noAutoReview?: boolean;
  stopOnChangesRequested?: boolean;
  dryRun?: boolean;
}

async function cmdReviewedRun(o: ReviewedRunOpts): Promise<void> {
  const harnessRoot = getHarnessRoot();
  const paths = harnessPaths(harnessRoot);
  const global = await loadGlobalPolicy(paths.globalPolicyPath);
  const repo = await loadRepoPolicy(paths.repoPolicyPath(o.repoId));
  const resolved = resolvePolicy(global, repo, o.domain);

  if (o.dryRun) {
    process.stdout.write(
      `reviewed-run workflow for ${resolved.domain} (maxAttempts=${o.maxAttempts}):\n` +
        `${JSON.stringify(resolved, null, 2)}\n`,
    );
    return;
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
  const coderRunner = createCodexCliRunner({
    codexBin,
    sandbox: resolved.codex.sandbox,
    ...(resolved.codex.approval !== undefined
      ? { approvalPolicy: resolved.codex.approval }
      : {}),
    ...(resolved.codex.timeoutMs !== undefined
      ? { timeoutMs: resolved.codex.timeoutMs }
      : {}),
  });
  // the reviewer agent always runs in a separate read-only sandbox.
  const reviewerRunner = createCodexCliRunner({
    codexBin,
    sandbox: "read-only",
  });

  const result = await runReviewedRunWorkflow({
    harnessRoot,
    runsDir: paths.runsDir,
    locksDir: paths.locksDir,
    repoPath: o.repo,
    repoId: o.repoId,
    domain: o.domain,
    goal: o.goal,
    baseBranch: o.baseBranch,
    coderRunner,
    reviewerRunner,
    maxAttempts: o.maxAttempts,
    ...(o.reviewerName !== undefined ? { reviewerName: o.reviewerName } : {}),
    ...(o.noAutoReview !== undefined ? { noAutoReview: o.noAutoReview } : {}),
    ...(o.stopOnChangesRequested !== undefined
      ? { stopOnChangesRequested: o.stopOnChangesRequested }
      : {}),
  });

  process.stdout.write(
    `workflow=reviewed-run rootRunId=${result.rootRunId} ` +
      `attempts=${result.attempts.length} finalStatus=${result.finalStatus}\n`,
  );
  for (const a of result.attempts) {
    process.stdout.write(
      `  attempt ${a.attempt}: ${a.runId} ${a.status}` +
        `${a.reviewer ? ` (reviewer=${a.reviewer})` : ""}\n`,
    );
  }
  // exit 1 on any non-success terminal state.
  if (result.finalStatus !== "approved") {
    process.exit(1);
  }
}

async function cmdLockList(): Promise<void> {
  const paths = harnessPaths(getHarnessRoot());
  if (!existsSync(paths.locksDir)) {
    process.stdout.write("no locks\n");
    return;
  }
  const entries = (await readdir(paths.locksDir)).filter((e) =>
    e.endsWith(".lock"),
  );
  if (entries.length === 0) {
    process.stdout.write("no locks\n");
    return;
  }
  // Surface unreadable locks too — those are exactly the ones operators
  // need to see (crash recovery, manual debugging).
  for (const e of entries) {
    const lockPath = join(paths.locksDir, e);
    try {
      const raw = await readFile(lockPath, "utf8");
      const info = JSON.parse(raw) as LockInfo;
      process.stdout.write(
        `${e}\trunId=${info.runId}\tpid=${info.pid}\thost=${info.hostname}\tacquiredAt=${info.acquiredAt}\n`,
      );
    } catch (err) {
      process.stdout.write(
        `${e}\tstatus=unreadable\terror=${(err as Error).message}\n`,
      );
    }
  }
}

interface LockReleaseOpts {
  domain: string;
  runId?: string;
  force?: boolean;
}

async function cmdLockRelease(o: LockReleaseOpts): Promise<void> {
  const paths = harnessPaths(getHarnessRoot());
  const path = domainLockPath(paths.locksDir, o.domain);
  if (!existsSync(path)) {
    process.stdout.write(`no lock for domain ${o.domain}\n`);
    return;
  }
  let info: LockInfo | undefined;
  try {
    info = JSON.parse(await readFile(path, "utf8")) as LockInfo;
  } catch {
    if (!o.force) {
      throw new Error(
        `lockfile at ${path} is unreadable; rerun with --force to delete anyway`,
      );
    }
  }
  if (info && o.runId !== undefined && info.runId !== o.runId) {
    if (!o.force) {
      throw new Error(
        `runId mismatch: lock has ${info.runId}, requested ${o.runId}. Use --force to override.`,
      );
    }
  }
  await rm(path, { force: true });
  process.stdout.write(`released ${domainLockName(o.domain)} (${path})\n`);
}

const program = new Command();
program.name("harness");

const runCmd = program
  .command("run", { isDefault: true })
  .description("run the domain-coding workflow")
  .requiredOption("--repo <path>", "target repo path")
  .requiredOption("--repo-id <id>", "repo identifier for policy resolution")
  .requiredOption("--domain <domain>", "target domain (e.g. apps/user)")
  .requiredOption("--goal <text>", "task goal passed to Codex")
  .option("--base-branch <name>", "base branch", "main")
  .option("--keep-worktree", "(no-op; worktree is always kept for review)", false)
  .option("--dry-run", "resolve policy and exit", false)
  .action(async (raw: Record<string, unknown>) => {
    await cmdRun({
      repo: String(raw.repo),
      repoId: String(raw.repoId),
      domain: String(raw.domain),
      goal: String(raw.goal),
      baseBranch: String(raw.baseBranch),
      keepWorktree: Boolean(raw.keepWorktree),
      dryRun: Boolean(raw.dryRun),
    });
  });

const workflowCmd = program
  .command("workflow")
  .description("multi-step workflows that sequence run / review / rerun");
workflowCmd
  .command("reviewed-run")
  .description(
    "run → review auto → review process → (rerun on changes_requested)*",
  )
  .requiredOption("--repo <path>", "target repo path")
  .requiredOption("--repo-id <id>", "repo identifier for policy resolution")
  .requiredOption("--domain <domain>", "target domain (e.g. apps/user)")
  .requiredOption("--goal <text>", "task goal passed to Codex")
  .option("--base-branch <name>", "base branch", "main")
  .option("--reviewer-name <name>", "reviewer identity for review auto")
  .option(
    "--max-attempts <n>",
    `retry cap measured from the root run (default ${DEFAULT_MAX_ATTEMPTS})`,
  )
  .option(
    "--stop-on-changes-requested",
    "stop at the first changes_requested instead of rerunning",
    false,
  )
  .option(
    "--no-auto-review",
    "run the coder only, then stop at needs_review for a human",
  )
  .option("--dry-run", "resolve policy and exit", false)
  .action(async (raw: Record<string, unknown>) => {
    let maxAttempts = DEFAULT_MAX_ATTEMPTS;
    if (raw.maxAttempts !== undefined) {
      const n = Number(raw.maxAttempts);
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write(
          `harness error: --max-attempts must be a positive integer (got ${JSON.stringify(String(raw.maxAttempts))})\n`,
        );
        process.exit(1);
      }
      maxAttempts = n;
    }
    // commander maps --no-auto-review to raw.autoReview === false
    await cmdReviewedRun({
      repo: String(raw.repo),
      repoId: String(raw.repoId),
      domain: String(raw.domain),
      goal: String(raw.goal),
      baseBranch: String(raw.baseBranch),
      maxAttempts,
      ...(raw.reviewerName !== undefined
        ? { reviewerName: String(raw.reviewerName) }
        : {}),
      noAutoReview: raw.autoReview === false,
      stopOnChangesRequested: Boolean(raw.stopOnChangesRequested),
      dryRun: Boolean(raw.dryRun),
    });
  });

const lockCmd = program.command("lock").description("manage domain locks");
lockCmd
  .command("list")
  .description("list active domain locks")
  .action(async () => {
    await cmdLockList();
  });
lockCmd
  .command("release")
  .description("force-release a domain lock (e.g. after crashed run)")
  .requiredOption("--domain <name>", "domain whose lock to release")
  .option("--run-id <id>", "only release if the lock belongs to this runId")
  .option("--force", "release even on runId mismatch / unreadable lock", false)
  .action(async (raw: Record<string, unknown>) => {
    await cmdLockRelease({
      domain: String(raw.domain),
      ...(raw.runId !== undefined ? { runId: String(raw.runId) } : {}),
      force: Boolean(raw.force),
    });
  });

const reviewCmd = program
  .command("review")
  .description("operate on review-decision.yaml under runs/<id>/");
reviewCmd
  .command("list")
  .description(
    "list runs (default: needs_review + changes_requested の review queue)",
  )
  .option("--all", "include runs of every status", false)
  .option(
    "--status <status>",
    "comma-separated status filter (e.g. needs_review,failed-policy-violation)",
  )
  .option("--domain <domain>", "restrict to a single domain")
  .option("--limit <n>", "cap the number of rows")
  .option("--json", "emit JSON ({ validRuns, invalidRuns }) instead of a table", false)
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const opts: Parameters<typeof listReviews>[0] = {
      runsDir: paths.runsDir,
      all: Boolean(raw.all),
    };
    if (raw.status !== undefined) {
      const statuses = String(raw.status)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (statuses.length === 0) {
        process.stderr.write(
          "harness error: --status was empty; pass at least one status\n",
        );
        process.exit(1);
      }
      const unknown = statuses.filter(
        (s) => !(RUN_STATUSES as readonly string[]).includes(s),
      );
      if (unknown.length > 0) {
        process.stderr.write(
          `harness error: unknown --status value(s): ${unknown.join(", ")}\n` +
            `  valid: ${RUN_STATUSES.join(", ")}\n`,
        );
        process.exit(1);
      }
      opts.statuses = statuses;
    }
    if (raw.domain !== undefined) opts.domain = String(raw.domain);
    if (raw.limit !== undefined) {
      const n = Number(raw.limit);
      if (!Number.isInteger(n) || n < 0) {
        process.stderr.write(
          `harness error: --limit must be a non-negative integer (got ${JSON.stringify(String(raw.limit))})\n`,
        );
        process.exit(1);
      }
      opts.limit = n;
    }
    const result = await listReviews(opts);
    if (raw.json) {
      process.stdout.write(formatJson(result));
      return;
    }
    process.stdout.write(formatTable(result));
    // invalid run dirs are surfaced on stderr so they never pollute the
    // table (and so --json's stdout stays parseable).
    if (result.invalid.length > 0) {
      process.stderr.write(
        `warning: ${result.invalid.length} unreadable run dir(s) hidden; use --all or --json to inspect\n`,
      );
      if (Boolean(raw.all)) {
        for (const inv of result.invalid) {
          process.stderr.write(`  ${inv.runId}: ${inv.error}\n`);
        }
      }
    }
  });
reviewCmd
  .command("process")
  .description("apply review-decision.yaml to meta.status")
  .requiredOption("--run-id <id>", "target run identifier")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    try {
      const result = await processReviewDecision({
        runsDir: paths.runsDir,
        locksDir: paths.locksDir,
        runId: String(raw.runId),
      });
      for (const w of result.warnings) {
        process.stdout.write(`warning: ${w}\n`);
      }
      process.stdout.write(
        `run=${result.runId} ${result.previousStatus} → ${result.newStatus} reviewer=${result.reviewer ?? "(none)"} reviewedAt=${result.reviewedAt}\n`,
      );
    } catch (e) {
      if (e instanceof ReviewGateError || e instanceof DomainLockError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
reviewCmd
  .command("auto")
  .description(
    "invoke a codex reviewer agent that reads run artifacts (read-only) and writes review-decision.yaml",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--reviewer-name <name>",
    "stamped into review-decision.yaml.reviewer (default: codex-reviewer)",
  )
  .option(
    "--allow-overwrite",
    "replace review-decision.yaml even if it already has a non-pending decision",
    false,
  )
  .option(
    "--dry-run",
    "run codex and validate the output but do NOT write review-decision.yaml",
    false,
  )
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    // separate codex instance with read-only sandbox; the agent must not
    // touch the worktree/runs files except by us writing review-decision
    // afterward.
    const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
    const runner = createCodexCliRunner({
      codexBin,
      sandbox: "read-only",
    });
    try {
      const result = await runReviewerAgent({
        runsDir: paths.runsDir,
        runId: String(raw.runId),
        ...(raw.reviewerName !== undefined
          ? { reviewerName: String(raw.reviewerName) }
          : {}),
        allowOverwrite: Boolean(raw.allowOverwrite),
        dryRun: Boolean(raw.dryRun),
        codexRunner: runner,
      });
      process.stdout.write(
        `run=${result.runId} decision=${result.decision} reviewer=${result.reviewer} reviewedAt=${result.reviewedAt}\n`,
      );
      if (result.dryRun) {
        process.stdout.write(
          `note: --dry-run — review-decision.yaml was NOT written.\n`,
        );
      } else {
        process.stdout.write(
          `note: review-decision.yaml was overwritten; run 'harness review process --run-id ${result.runId}' to apply.\n`,
        );
      }
    } catch (e) {
      if (e instanceof ReviewerAgentGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

const cleanupCmd = program
  .command("cleanup")
  .description(
    "remove worktree + branch for an approved/rejected run (run dir kept by default)",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--force",
    "allow cleanup of needs_review / failed-* / verified / generated (NOT changes_requested or running)",
    false,
  )
  .option(
    "--scope <scope>",
    "workspace (worktree+branch, keep run dir) | run (also delete run dir) | all (also git worktree prune)",
    "workspace",
  )
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const scope = String(raw.scope);
    if (scope !== "workspace" && scope !== "run" && scope !== "all") {
      process.stderr.write(
        `harness error: --scope must be workspace | run | all (got ${JSON.stringify(scope)})\n`,
      );
      process.exit(1);
    }
    try {
      const result = await cleanupRun({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        runId: String(raw.runId),
        force: Boolean(raw.force),
        scope,
      });
      process.stdout.write(
        `run=${result.runId} scope=${result.scope} previousStatus=${result.previousStatus} worktreeRemoved=${result.worktreeRemoved} branchRemoved=${result.branchRemoved} runDirRemoved=${result.runDirRemoved}\n`,
      );
    } catch (e) {
      if (e instanceof CleanupGateError || e instanceof DomainLockError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

const rerunCmd = program
  .command("rerun")
  .description("spawn a new run from a changes_requested parent")
  // NOTE: a plain option (not requiredOption) so the `rerun chain`
  // subcommand can be invoked without --from-review. The action below
  // enforces presence for the bare `rerun` form.
  .option(
    "--from-review <run-id>",
    "parent run id (must be in changes_requested status)",
  )
  .option(
    "--max-attempts <n>",
    `retry cap measured from the chain root (default ${DEFAULT_MAX_ATTEMPTS})`,
  )
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    if (raw.fromReview === undefined) {
      process.stderr.write(
        "harness error: 'harness rerun' requires --from-review <run-id> " +
          "(did you mean 'harness rerun chain --run-id <id>'?)\n",
      );
      process.exit(1);
    }
    let maxAttempts: number | undefined;
    if (raw.maxAttempts !== undefined) {
      const n = Number(raw.maxAttempts);
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write(
          `harness error: --max-attempts must be a positive integer (got ${JSON.stringify(String(raw.maxAttempts))})\n`,
        );
        process.exit(1);
      }
      maxAttempts = n;
    }
    let prep;
    try {
      prep = await prepareRerunFromReview({
        runsDir: paths.runsDir,
        parentRunId: String(raw.fromReview),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      });
    } catch (e) {
      if (e instanceof RerunGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
    for (const w of prep.warnings) {
      process.stderr.write(`warning: ${w}\n`);
    }

    // Reuse the same code path as `harness run`: resolve policy, build the
    // codex runner with its sandbox/approval/timeout, then call
    // runDomainCoding with the rerun-derived goal + parentRunId.
    const global = await loadGlobalPolicy(paths.globalPolicyPath);
    const repo = await loadRepoPolicy(paths.repoPolicyPath(prep.repoId));
    const resolved = resolvePolicy(global, repo, prep.domain);
    const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
    const runner = createCodexCliRunner({
      codexBin,
      sandbox: resolved.codex.sandbox,
      ...(resolved.codex.approval !== undefined
        ? { approvalPolicy: resolved.codex.approval }
        : {}),
      ...(resolved.codex.timeoutMs !== undefined
        ? { timeoutMs: resolved.codex.timeoutMs }
        : {}),
    });

    // The parent's repoPath isn't carried in RerunPrepResult — read it
    // back from meta.json. (We could add it to the prep result, but
    // keeping prep narrow avoids re-handing details that don't belong.)
    const { readFile } = await import("node:fs/promises");
    const parentMeta = JSON.parse(
      await readFile(
        join(paths.runsDir, prep.parentRunId, "meta.json"),
        "utf8",
      ),
    ) as { repoPath: string };

    const result = await runDomainCoding({
      harnessRoot,
      repoPath: parentMeta.repoPath,
      repoId: prep.repoId,
      domain: prep.domain,
      goal: prep.goal,
      baseBranch: prep.baseBranch,
      codexRunner: runner,
      parentRunId: prep.parentRunId,
      rootRunId: prep.rootRunId,
      rerunAttempt: prep.rerunAttempt,
    });
    const cmdTotal = result.commandResults.length;
    const cmdOk = result.commandResults.filter(
      (c) => c.exitCode === 0 && !c.timedOut,
    ).length;
    process.stdout.write(
      `run=${result.runId} parentRunId=${prep.parentRunId} rootRunId=${prep.rootRunId} rerunAttempt=${prep.rerunAttempt} status=${result.status} safetyStatus=${result.safetyStatus} commands=${cmdOk}/${cmdTotal}\n`,
    );
    if (
      result.status === "failed-policy-violation" ||
      result.status === "failed-codex" ||
      result.status === "failed-codex-timeout" ||
      result.status === "failed-diff-collection" ||
      result.status === "failed-command" ||
      result.status === "failed-internal-error"
    ) {
      process.exit(1);
    }
  });
rerunCmd
  .command("chain")
  .description("show the rerun chain a run belongs to (root → descendants)")
  .requiredOption("--run-id <id>", "any run in the chain")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      const root = await buildRerunChain({
        runsDir: paths.runsDir,
        runId: String(raw.runId),
      });
      process.stdout.write(formatChain(root));
    } catch (e) {
      if (e instanceof RerunGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

function knowledgeDirOf(
  harnessRoot: string,
  raw: Record<string, unknown>,
): string {
  return raw.out !== undefined
    ? String(raw.out)
    : join(harnessRoot, "docs", "knowledge");
}

const knowledgeCmd = program
  .command("knowledge")
  .description("review and promote knowledge-candidates");
knowledgeCmd
  .command("list")
  .description("list a run's knowledge candidates with their status")
  .requiredOption("--run-id <id>", "target run identifier")
  .option("--kind <kind>", "only candidates with this kind")
  .option("--domain <domain>", "only candidates with this domain")
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    try {
      const entries = await listKnowledge({
        runsDir: paths.runsDir,
        knowledgeDir: knowledgeDirOf(harnessRoot, raw),
        runId: String(raw.runId),
        ...(raw.kind !== undefined ? { kind: String(raw.kind) } : {}),
        ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
      });
      if (entries.length === 0) {
        process.stdout.write("no candidates\n");
        return;
      }
      for (const e of entries) {
        const extra =
          e.status === "rejected" ? ` (by ${e.rejectedBy})` : "";
        process.stdout.write(
          `[${e.index}] ${e.status}${extra}  kind=${e.kind} domain=${e.domain} confidence=${e.confidence}\n` +
            `    ${e.title}\n`,
        );
      }
    } catch (e) {
      if (e instanceof KnowledgePromoteGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
knowledgeCmd
  .command("reject")
  .description("record a reject decision for a candidate (sidecar)")
  .requiredOption("--run-id <id>", "target run identifier")
  .requiredOption("--index <n>", "candidate index to reject")
  .requiredOption("--reviewer <name>", "reviewer handle")
  .requiredOption("--reason <text>", "why the candidate is rejected")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0) {
      process.stderr.write(
        `harness error: --index must be a non-negative integer (got ${JSON.stringify(String(raw.index))})\n`,
      );
      process.exit(1);
    }
    try {
      const r = await rejectKnowledge({
        runsDir: paths.runsDir,
        runId: String(raw.runId),
        index,
        reviewer: String(raw.reviewer),
        reason: String(raw.reason),
      });
      process.stdout.write(
        `run=${r.runId} rejected candidate ${r.index} by ${r.reviewer}\n`,
      );
    } catch (e) {
      if (e instanceof KnowledgePromoteGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
knowledgeCmd
  .command("promote")
  .description(
    "write each candidate as docs/knowledge/<kind>/<runId>-<idx>-<slug>.md",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .requiredOption("--reviewer <name>", "reviewer handle (stamped into each md)")
  .option("--kind <kind>", "only candidates with this kind are promoted")
  .option(
    "--allow-duplicate",
    "create a md even if an identical content hash already exists",
    false,
  )
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    const knowledgeDir = knowledgeDirOf(harnessRoot, raw);
    try {
      const r = await promoteKnowledge({
        runsDir: paths.runsDir,
        knowledgeDir,
        runId: String(raw.runId),
        reviewer: String(raw.reviewer),
        allowDuplicate: Boolean(raw.allowDuplicate),
        ...(raw.kind !== undefined ? { kind: String(raw.kind) } : {}),
      });
      process.stdout.write(
        `run=${r.runId} promoted=${r.promoted.length} skipped=${r.skipped.length} out=${knowledgeDir}\n`,
      );
      for (const p of r.promoted) {
        process.stdout.write(`  promoted ${p.kind}: ${p.path}\n`);
      }
      for (const s of r.skipped) {
        process.stdout.write(
          `  skipped [${s.index}] ${s.reason}${s.detail ? ` — ${s.detail}` : ""}\n`,
        );
      }
    } catch (e) {
      if (e instanceof KnowledgePromoteGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`harness error: ${(e as Error).message}\n`);
  process.exit(2);
});

// silence unused suppress
void runCmd;
void reviewCmd;
void cleanupCmd;
void rerunCmd;
void knowledgeCmd;
