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
  scanAllRuns,
  applyListFilters,
  formatTable,
  formatJson,
} from "../core/review-lister.js";
import {
  rebuildIndex,
  loadFromIndex,
  indexStatus,
  showRunFromIndex,
} from "../index/run-index.js";
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
  evaluateReviewer,
  compareDecisions,
  ReviewEvaluateError,
} from "../core/review-evaluator.js";
import {
  promoteKnowledge,
  rejectKnowledge,
  listKnowledge,
  KnowledgePromoteGateError,
} from "../core/knowledge-promoter.js";
import {
  buildKnowledgeContext,
  KnowledgeContextError,
  domainSlug,
} from "../core/knowledge-context.js";

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
  withKnowledge?: boolean;
  knowledgeContextPath?: string;
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

  // resolve promoted-knowledge context (Phase 3-4), if requested.
  let knowledgeContext: { path: string; text: string } | undefined;
  const explicitCtx = o.knowledgeContextPath;
  if (explicitCtx !== undefined) {
    if (!existsSync(explicitCtx)) {
      process.stderr.write(
        `harness error: --knowledge-context file not found: ${explicitCtx}\n`,
      );
      process.exit(1);
    }
    knowledgeContext = {
      path: explicitCtx,
      text: await readFile(explicitCtx, "utf8"),
    };
  } else if (o.withKnowledge) {
    const ctxPath = join(
      harnessRoot,
      "docs",
      "knowledge-context",
      `${domainSlug(o.domain)}.md`,
    );
    if (!existsSync(ctxPath)) {
      process.stderr.write(
        `harness error: --with-knowledge: ${ctxPath} not found; ` +
          `run 'harness knowledge build-context --domain ${o.domain}' first\n`,
      );
      process.exit(1);
    }
    knowledgeContext = { path: ctxPath, text: await readFile(ctxPath, "utf8") };
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
    ...(knowledgeContext !== undefined ? { knowledgeContext } : {}),
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
  .option(
    "--with-knowledge",
    "inject docs/knowledge-context/<domain>.md into the codex prompt",
    false,
  )
  .option(
    "--knowledge-context <path>",
    "inject an explicit knowledge-context file (overrides --with-knowledge)",
  )
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
      withKnowledge: Boolean(raw.withKnowledge),
      ...(raw.knowledgeContext !== undefined
        ? { knowledgeContextPath: String(raw.knowledgeContext) }
        : {}),
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
  .option(
    "--use-index",
    "read from the SQLite index instead of scanning runs/ (Phase 3-5)",
    false,
  )
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
    let result;
    if (raw.useIndex) {
      // index path: load every run from the SQLite index, then apply the
      // SAME filter/sort/limit logic as the file scan.
      try {
        const scan = loadFromIndex(paths.indexDbPath);
        result = applyListFilters(scan.valid, scan.invalid, opts);
      } catch (e) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
    } else {
      result = await listReviews(opts);
    }
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
reviewCmd
  .command("evaluate")
  .description(
    "run the reviewer agent N times against one run to observe verdict stability",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .option("--samples <n>", "number of reviewer samples", "3")
  .option("--reviewer-name <name>", "reviewer identity")
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const samples = Number(raw.samples);
    if (!Number.isInteger(samples) || samples < 1) {
      process.stderr.write(
        `harness error: --samples must be a positive integer (got ${JSON.stringify(String(raw.samples))})\n`,
      );
      process.exit(1);
    }
    const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
    const runner = createCodexCliRunner({ codexBin, sandbox: "read-only" });
    try {
      const r = await evaluateReviewer({
        runsDir: paths.runsDir,
        runId: String(raw.runId),
        samples,
        codexRunner: runner,
        ...(raw.reviewerName !== undefined
          ? { reviewerName: String(raw.reviewerName) }
          : {}),
      });
      const dist = Object.entries(r.decisionCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      process.stdout.write(
        `run=${r.runId} samples=${r.samples.length} ${dist}\n`,
      );
      for (const f of r.dangerFlags) {
        process.stderr.write(`danger: ${f}\n`);
      }
    } catch (e) {
      if (e instanceof ReviewEvaluateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
reviewCmd
  .command("compare")
  .description("compare two review-decision.yaml files (e.g. human vs agent)")
  .requiredOption("--human <path>", "human review-decision.yaml")
  .requiredOption("--agent <path>", "agent review-decision.yaml")
  .action(async (raw: Record<string, unknown>) => {
    try {
      const r = await compareDecisions({
        humanPath: String(raw.human),
        agentPath: String(raw.agent),
      });
      process.stdout.write(r.report);
      if (!r.decisionMatch) process.exit(1);
    } catch (e) {
      if (e instanceof ReviewEvaluateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

const indexCmd = program
  .command("index")
  .description(
    "SQLite run index — a derived cache; runs/ stays the source of truth",
  );
indexCmd
  .command("rebuild")
  .description("rebuild the SQLite index from a full runs/ scan")
  .action(async () => {
    const paths = harnessPaths(getHarnessRoot());
    const scan = await scanAllRuns(paths.runsDir);
    const stats = rebuildIndex(paths.indexDbPath, scan);
    process.stdout.write(
      `index rebuilt: runs=${stats.runCount} invalid=${stats.invalidCount} db=${stats.dbPath}\n`,
    );
  });
indexCmd
  .command("status")
  .description("show SQLite index status")
  .action(() => {
    const paths = harnessPaths(getHarnessRoot());
    const st = indexStatus(paths.indexDbPath);
    if (!st.exists) {
      process.stdout.write(
        `index: not built (${st.dbPath}); run 'harness index rebuild'\n`,
      );
      return;
    }
    if (st.corrupt) {
      process.stderr.write(
        `index: corrupt (${st.dbPath}): ${st.error}; run 'harness index rebuild'\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `index: runs=${st.runCount} invalid=${st.invalidCount} ` +
        `rebuiltAt=${st.rebuiltAt ?? "?"} size=${st.sizeBytes ?? 0}B db=${st.dbPath}\n`,
    );
  });
indexCmd
  .command("show")
  .description("show one run's indexed row")
  .requiredOption("--run-id <id>", "target run identifier")
  .action((raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      const found = showRunFromIndex(paths.indexDbPath, String(raw.runId));
      if (!found) {
        process.stderr.write(
          `harness error: run ${String(raw.runId)} not in index ` +
            `(rebuild if it is new)\n`,
        );
        process.exit(1);
      }
      if (found.kind === "invalid") {
        process.stdout.write(
          `${JSON.stringify({ runId: found.runId, status: "invalid", error: found.error }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`${JSON.stringify(found.entry, null, 2)}\n`);
      }
    } catch (e) {
      process.stderr.write(`harness error: ${(e as Error).message}\n`);
      process.exit(1);
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
  .command("build-context")
  .description(
    "aggregate promoted knowledge for a domain into docs/knowledge-context/<domain>.md",
  )
  .requiredOption("--domain <domain>", "target domain")
  .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    try {
      const r = await buildKnowledgeContext({
        knowledgeDir: knowledgeDirOf(harnessRoot, raw),
        outDir: join(harnessRoot, "docs", "knowledge-context"),
        domain: String(raw.domain),
      });
      process.stdout.write(
        `domain=${r.domain} entries=${r.entries.length} out=${r.outPath}\n`,
      );
    } catch (e) {
      if (e instanceof KnowledgeContextError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });
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
