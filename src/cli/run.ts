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
  type LockInfo,
} from "../workspace/domain-lock.js";
import {
  processReviewDecision,
  ReviewGateError,
} from "../core/review-processor.js";
import { cleanupRun, CleanupGateError } from "../core/cleanup.js";
import { listReviews, formatTable } from "../core/review-lister.js";
import { prepareRerunFromReview, RerunGateError } from "../core/rerun.js";
import {
  runReviewerAgent,
  ReviewerAgentGateError,
} from "../core/reviewer-agent.js";
import {
  promoteKnowledge,
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
  .description("list runs (default: only needs_review)")
  .option("--all", "include runs of every status", false)
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    const entries = await listReviews({
      runsDir: paths.runsDir,
      all: Boolean(raw.all),
    });
    process.stdout.write(formatTable(entries));
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
        runId: String(raw.runId),
      });
      for (const w of result.warnings) {
        process.stdout.write(`warning: ${w}\n`);
      }
      process.stdout.write(
        `run=${result.runId} ${result.previousStatus} → ${result.newStatus} reviewer=${result.reviewer ?? "(none)"} reviewedAt=${result.reviewedAt}\n`,
      );
    } catch (e) {
      if (e instanceof ReviewGateError) {
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
        codexRunner: runner,
      });
      process.stdout.write(
        `run=${result.runId} decision=${result.decision} reviewer=${result.reviewer} reviewedAt=${result.reviewedAt}\n`,
      );
      process.stdout.write(
        `note: review-decision.yaml was overwritten; run 'harness review process --run-id ${result.runId}' to apply.\n`,
      );
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
    "remove worktree + branch for an approved/rejected run (run dir kept)",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--force",
    "allow cleanup of needs_review / failed-* / verified / generated (NOT changes_requested or running)",
    false,
  )
  .action(async (raw: Record<string, unknown>) => {
    const paths = harnessPaths(getHarnessRoot());
    try {
      const result = await cleanupRun({
        runsDir: paths.runsDir,
        workspacesDir: paths.workspacesDir,
        locksDir: paths.locksDir,
        runId: String(raw.runId),
        force: Boolean(raw.force),
      });
      process.stdout.write(
        `run=${result.runId} previousStatus=${result.previousStatus} worktreeRemoved=${result.worktreeRemoved} branchRemoved=${result.branchRemoved}\n`,
      );
    } catch (e) {
      if (e instanceof CleanupGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  });

const rerunCmd = program
  .command("rerun")
  .description("spawn a new run from a changes_requested parent")
  .requiredOption(
    "--from-review <run-id>",
    "parent run id (must be in changes_requested status)",
  )
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    let prep;
    try {
      prep = await prepareRerunFromReview({
        runsDir: paths.runsDir,
        parentRunId: String(raw.fromReview),
      });
    } catch (e) {
      if (e instanceof RerunGateError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
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
    });
    const cmdTotal = result.commandResults.length;
    const cmdOk = result.commandResults.filter(
      (c) => c.exitCode === 0 && !c.timedOut,
    ).length;
    process.stdout.write(
      `run=${result.runId} parentRunId=${prep.parentRunId} status=${result.status} safetyStatus=${result.safetyStatus} commands=${cmdOk}/${cmdTotal}\n`,
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

const knowledgeCmd = program
  .command("knowledge")
  .description("promote knowledge-candidates to permanent docs");
knowledgeCmd
  .command("promote")
  .description(
    "write each knowledge-candidate as docs/knowledge/<kind>/<runId>-<idx>-<slug>.md",
  )
  .requiredOption("--run-id <id>", "target run identifier")
  .option(
    "--kind <kind>",
    "if set, only candidates with this kind are promoted",
  )
  .option(
    "--out <dir>",
    "destination root (default: HARNESS_ROOT/docs/knowledge)",
  )
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    const knowledgeDir =
      raw.out !== undefined
        ? String(raw.out)
        : join(harnessRoot, "docs", "knowledge");
    try {
      const r = await promoteKnowledge({
        runsDir: paths.runsDir,
        knowledgeDir,
        runId: String(raw.runId),
        ...(raw.kind !== undefined ? { kind: String(raw.kind) } : {}),
      });
      process.stdout.write(
        `run=${r.runId} promoted=${r.promoted.length} skipped=${r.skipped} out=${knowledgeDir}\n`,
      );
      for (const p of r.promoted) {
        process.stdout.write(`  ${p.kind}: ${p.path}\n`);
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
