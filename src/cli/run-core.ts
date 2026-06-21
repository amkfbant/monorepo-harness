import process from "node:process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { resolveAgentBackend, resolveAgentRunner } from "../core/agent-runner.js";
import { codexBinaryVersion } from "../codex/codex-version.js";
import { harnessPaths } from "../config/paths.js";
import { KnowledgeContextError, buildKnowledgeContextFromDb, domainSlug } from "../core/knowledge-context.js";
import { ReviewWorkflowUnsupportedError, assertReviewedRunWorkflowSupported, runReviewedRunWorkflow } from "../core/reviewed-run-workflow.js";
import { RunViewError, type RunViewSource } from "../core/run-viewer.js";
import { runDomainCoding, type RunChangeBudgetOverride } from "../core/workflow-runner.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { ProjectError } from "../project/errors.js";
import { prepareProjectRun, type PreparedProjectRun } from "../project/run-project.js";

/**
 * run 駆動の核ロジック(cmdRun/cmdReviewedRun と補助の parse/解決関数 + 型)。
 * run.ts の wiring(run/workflow command)・pr.ts・backlog.ts がここから import する。
 * run.ts は parseAsync の副作用を持つため import 源にできず、共有ロジックを本 module へ分離。
 */
export function getHarnessRoot(): string {
  return process.env.HARNESS_ROOT ?? process.cwd();
}

export function rejectProjectRepoIdMix(
  raw: Record<string, unknown>,
  command: string,
): void {
  if (raw.project !== undefined && raw.repoId !== undefined) {
    process.stderr.write(
      `harness error: '${command}' cannot combine --project with --repo-id ` +
        `(--project resolves the repo from the profile; --repo is the only override)\n`,
    );
    process.exit(1);
  }
}

export interface RunOpts {
  /** repo path; required in --repo-id mode, an optional override in --project mode */
  repo?: string;
  repoId?: string;
  /** project id — selects the profile-driven run path (Phase 5-7) */
  project?: string;
  domain: string;
  goal: string;
  /** explicit --base-branch; when absent the profile (or "main") decides */
  baseBranch?: string;
  keepWorktree?: boolean;
  dryRun?: boolean;
  withKnowledge?: boolean;
  knowledgeContextPath?: string;
  changeBudgetOverride?: RunChangeBudgetOverride;
}

export interface RunOutcome {
  runId: string;
  status: string;
  failed: boolean;
}

export function parseChangeBudgetOverride(
  raw: Record<string, unknown>,
): { changeBudgetOverride?: RunChangeBudgetOverride } {
  const override: RunChangeBudgetOverride = {};
  if (raw.changeBudgetMaxDeletedLines !== undefined) {
    override.maxDeletedLines = parsePositiveInt(
      raw.changeBudgetMaxDeletedLines,
      "--change-budget-max-deleted-lines",
    );
  }
  if (raw.changeBudgetMaxTotalChangedLines !== undefined) {
    override.maxTotalChangedLines = parsePositiveInt(
      raw.changeBudgetMaxTotalChangedLines,
      "--change-budget-max-total-changed-lines",
    );
  }
  if (raw.changeBudgetMaxDeletedFiles !== undefined) {
    override.maxDeletedFiles = parsePositiveInt(
      raw.changeBudgetMaxDeletedFiles,
      "--change-budget-max-deleted-files",
    );
  }
  if (raw.changeBudgetMaxChangedFiles !== undefined) {
    override.maxChangedFiles = parsePositiveInt(
      raw.changeBudgetMaxChangedFiles,
      "--change-budget-max-changed-files",
    );
  }
  return Object.keys(override).length > 0 ? { changeBudgetOverride: override } : {};
}

export async function cmdRun(o: RunOpts): Promise<RunOutcome> {
  const harnessRoot = getHarnessRoot();
  const paths = harnessPaths(harnessRoot);

  let prepared: PreparedProjectRun | undefined;
  let resolved;
  let repoPath: string;
  let repoId: string;
  if (o.project !== undefined) {
    try {
      prepared = await prepareProjectRun({
        harnessRoot,
        projectId: o.project,
        domain: o.domain,
        ...(o.repo !== undefined ? { repoOverride: o.repo } : {}),
      });
    } catch (e) {
      if (e instanceof ProjectError) {
        process.stderr.write(`harness error: ${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
    resolved = prepared.resolvedPolicy;
    repoPath = prepared.repoPath;
    repoId = prepared.repoId;
  } else {
    const global = await loadGlobalPolicy(paths.globalPolicyPath);
    const repo = await loadRepoPolicy(paths.repoPolicyPath(String(o.repoId)));
    resolved = resolvePolicy(global, repo, o.domain);
    repoPath = String(o.repo);
    repoId = String(o.repoId);
  }

  // explicit --base-branch wins; otherwise the project profile's base
  // branch (or "main" in --repo-id mode).
  const baseBranch = o.baseBranch ?? prepared?.baseBranch ?? "main";

  if (o.dryRun) {
    process.stdout.write(
      `resolved policy for ${resolved.domain}:\n${JSON.stringify(resolved, null, 2)}\n`,
    );
    return { runId: "", status: "dry-run", failed: false };
  }

  // resolve promoted-knowledge context (Phase 3-4), if requested.
  let knowledgeContext:
    | { path: string; text: string; revisionIds?: number[] }
    | undefined;
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
    if (prepared !== undefined && existsSync(paths.dbPath)) {
      try {
        const handle = openManagedDb({ dbPath: paths.dbPath });
        try {
          runMigrations(handle.db);
          const built = await buildKnowledgeContextFromDb({
            db: handle.db,
            outDir: join(harnessRoot, "docs", "knowledge-context"),
            domain: o.domain,
            projectId: prepared.project.projectId,
            repoId,
          });
          knowledgeContext = {
            path: built.outPath,
            text: await readFile(built.outPath, "utf8"),
            ...(built.knowledgeRevisionIds !== undefined
              ? { revisionIds: built.knowledgeRevisionIds }
              : {}),
          };
        } finally {
          handle.close();
        }
      } catch (e) {
        if (!(e instanceof KnowledgeContextError)) throw e;
        process.stderr.write(
          `warning: DB knowledge context unavailable: ${e.message}; falling back to ${ctxPath}\n`,
        );
      }
    }
    if (knowledgeContext === undefined && !existsSync(ctxPath)) {
      process.stderr.write(
        `harness error: --with-knowledge: ${ctxPath} not found; ` +
          `run 'harness knowledge build-context --domain ${o.domain}' first\n`,
      );
      process.exit(1);
    }
    if (knowledgeContext === undefined) {
      knowledgeContext = {
        path: ctxPath,
        text: await readFile(ctxPath, "utf8"),
      };
    }
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
  const resolvedCodexBinaryVersion = codexBinaryVersion(codexBin);
  // #191: the coder may be claude (opt-in via HARNESS_CODER_BACKEND=claude).
  // Capture the backend ONCE here and thread it (runner + run) so the coder
  // dispatch can't diverge from the runner. The claude branch ignores codex-only
  // knobs; cwd=worktree is its F15 boundary.
  const coderBackend = resolveAgentBackend("coder");
  const runner = resolveAgentRunner({
    role: "coder",
    backend: coderBackend,
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
    coderBackend,
    harnessRoot,
    repoPath,
    repoId,
    domain: o.domain,
    goal: o.goal,
    baseBranch,
    ...(o.keepWorktree !== undefined ? { keepWorktree: o.keepWorktree } : {}),
    codexRunner: runner,
    codexBinaryVersion: resolvedCodexBinaryVersion,
    ...(knowledgeContext !== undefined ? { knowledgeContext } : {}),
    ...(o.changeBudgetOverride !== undefined
      ? { changeBudgetOverride: o.changeBudgetOverride }
      : {}),
    ...(prepared !== undefined
      ? {
          compiledPolicy: prepared.compiledPolicy,
          reviewRuleResolution: prepared.reviewRuleResolution,
          project: prepared.project,
          ...(prepared.projectContextPacks !== undefined
            ? {
                projectContextPacks: {
                  promptText: prepared.projectContextPacks.promptText,
                  manifestYaml: prepared.projectContextPacks.manifestYaml,
                },
              }
            : {}),
        }
      : {}),
  });
  const cmdTotal = result.commandResults.length;
  const cmdOk = result.commandResults.filter(
    (c) => c.exitCode === 0 && !c.timedOut,
  ).length;
  process.stdout.write(
    `run=${result.runId} status=${result.status} safetyStatus=${result.safetyStatus} ignoredUntrackedCount=${result.ignoredUntrackedCount} secretSuspectCount=${result.secretSuspectCount} commands=${cmdOk}/${cmdTotal}\n`,
  );
  const failed = result.status.startsWith("failed-");
  return { runId: result.runId, status: result.status, failed };
}

export interface ReviewedRunOpts {
  repo?: string;
  repoId?: string;
  project?: string;
  domain: string;
  goal: string;
  baseBranch?: string;
  reviewerName?: string;
  maxAttempts: number;
  noAutoReview?: boolean;
  stopOnChangesRequested?: boolean;
  dryRun?: boolean;
}

export interface ReviewedRunOutcome {
  rootRunId: string;
  finalStatus: string;
}

export async function cmdReviewedRun(o: ReviewedRunOpts): Promise<ReviewedRunOutcome> {
  const harnessRoot = getHarnessRoot();
  const paths = harnessPaths(harnessRoot);

  let prepared: PreparedProjectRun | undefined;
  let resolved;
  let repoPath: string;
  let repoId: string;
  if (o.project !== undefined) {
    try {
      prepared = await prepareProjectRun({
        harnessRoot,
        projectId: o.project,
        domain: o.domain,
        ...(o.repo !== undefined ? { repoOverride: o.repo } : {}),
      });
    } catch (e) {
      if (e instanceof ProjectError) {
        process.stderr.write(`harness error: ${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
    resolved = prepared.resolvedPolicy;
    repoPath = prepared.repoPath;
    repoId = prepared.repoId;
  } else {
    const global = await loadGlobalPolicy(paths.globalPolicyPath);
    const repo = await loadRepoPolicy(paths.repoPolicyPath(String(o.repoId)));
    resolved = resolvePolicy(global, repo, o.domain);
    repoPath = String(o.repo);
    repoId = String(o.repoId);
  }

  const baseBranch = o.baseBranch ?? prepared?.baseBranch ?? "main";

  try {
    assertReviewedRunWorkflowSupported(prepared?.reviewRuleResolution);
  } catch (e) {
    if (e instanceof ReviewWorkflowUnsupportedError) {
      process.stderr.write(`harness error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  if (o.dryRun) {
    process.stdout.write(
      `reviewed-run workflow for ${resolved.domain} (maxAttempts=${o.maxAttempts}):\n` +
        `${JSON.stringify(resolved, null, 2)}\n`,
    );
    return { rootRunId: "", finalStatus: "dry-run" };
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
  const resolvedCodexBinaryVersion = codexBinaryVersion(codexBin);
  // #191: coder may be claude (opt-in). Reviewer stays codex — claude reviewer
  // redaction/telemetry dispatch is a follow-up, and routing claude events
  // through the codex redactor would leak secrets (the S4 gap).
  const coderBackend = resolveAgentBackend("coder");
  const coderRunner = resolveAgentRunner({
    role: "coder",
    backend: coderBackend,
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

  let result: Awaited<ReturnType<typeof runReviewedRunWorkflow>>;
  try {
    result = await runReviewedRunWorkflow({
      harnessRoot,
      runsDir: paths.runsDir,
      locksDir: paths.locksDir,
      repoPath,
      repoId,
      domain: o.domain,
      goal: o.goal,
      baseBranch,
      coderRunner,
      coderBackend,
      reviewerRunner,
      coderCodexBinaryVersion: resolvedCodexBinaryVersion,
      maxAttempts: o.maxAttempts,
      ...(o.reviewerName !== undefined ? { reviewerName: o.reviewerName } : {}),
      ...(o.noAutoReview !== undefined ? { noAutoReview: o.noAutoReview } : {}),
      ...(o.stopOnChangesRequested !== undefined
        ? { stopOnChangesRequested: o.stopOnChangesRequested }
        : {}),
      ...(prepared !== undefined
        ? {
            projectRun: {
              compiledPolicy: prepared.compiledPolicy,
              reviewRuleResolution: prepared.reviewRuleResolution,
              project: prepared.project,
              ...(prepared.projectContextPacks !== undefined
                ? {
                    projectContextPacks: {
                      promptText: prepared.projectContextPacks.promptText,
                      manifestYaml:
                        prepared.projectContextPacks.manifestYaml,
                    },
                  }
                : {}),
            },
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof ReviewWorkflowUnsupportedError) {
      process.stderr.write(`harness error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

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
  return { rootRunId: result.rootRunId, finalStatus: result.finalStatus };
}

export function parseSource(raw: unknown): RunViewSource {
  const s = raw === undefined ? "auto" : String(raw);
  if (s !== "auto" && s !== "db" && s !== "files") {
    process.stderr.write(
      `harness error: --source must be one of auto | db | files (got ${JSON.stringify(s)})\n`,
    );
    process.exit(1);
  }
  return s;
}

export function runViewAction(
  render: (
    runsDir: string,
    runId: string,
    dbPath?: string,
    source?: RunViewSource,
  ) => Promise<string>,
) {
  return async (raw: Record<string, unknown>): Promise<void> => {
    const paths = harnessPaths(getHarnessRoot());
    const source = parseSource(raw.source);
    try {
      process.stdout.write(
        await render(paths.runsDir, String(raw.runId), paths.dbPath, source),
      );
    } catch (e) {
      if (e instanceof RunViewError) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
      throw e;
    }
  };
}

export function parseNonNegativeIntSeconds(raw: unknown, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    process.stderr.write(`harness error: invalid ${flag}: ${String(raw)}\n`);
    process.exit(2);
  }
  return n;
}

export function parsePositiveIntSeconds(raw: unknown, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`harness error: invalid ${flag}: ${String(raw)}\n`);
    process.exit(2);
  }
  return n;
}

export function parsePositiveInt(raw: unknown, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`harness error: invalid ${flag}: ${String(raw)}\n`);
    process.exit(2);
  }
  return n;
}
