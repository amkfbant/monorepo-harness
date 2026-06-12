import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import type { RunStatus, RunMeta } from "../logging/run-log.js";
import type { GlobalPolicy, RepoPolicy } from "../policy/schema.js";
import {
  runDomainCoding,
  RunFinalizedError,
  type RunDomainCodingResult,
} from "./workflow-runner.js";
import { runReviewerAgent, ReviewerAgentGateError } from "./reviewer-agent.js";
import { syncRunArtifactsToDb } from "./run-materialize.js";
import { processReviewDecision } from "./review-processor.js";
import { prepareRerunFromReview } from "./rerun.js";
import { harnessPaths } from "../config/paths.js";

/**
 * Outcome of a reviewed-run workflow.
 *  - a RunStatus (approved / rejected / failed-*) when a run/review reached
 *    a terminal state directly,
 *  - "not_converged" when changes_requested persisted up to maxAttempts,
 *  - "review-auto-failed" when `review auto` produced unusable output.
 */
export type WorkflowFinalStatus =
  | RunStatus
  | "not_converged"
  | "review-auto-failed";

export interface WorkflowAttempt {
  runId: string;
  attempt: number;
  /** status of the run after review (or the failed-* run status) */
  status: RunStatus;
  reviewer: string | null;
}

export interface ReviewedRunWorkflowResult {
  rootRunId: string;
  attempts: WorkflowAttempt[];
  finalStatus: WorkflowFinalStatus;
  maxAttempts: number;
}

export interface ReviewedRunWorkflowOpts {
  harnessRoot: string;
  runsDir: string;
  locksDir: string;
  repoPath: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  /** runner for the coder run (workspace-write per policy) */
  coderRunner: CodexExecRunner;
  /** `codex --version` first line for coder runs, or null on lookup failure. */
  coderCodexBinaryVersion?: string | null;
  /** runner for `review auto` (read-only sandbox) */
  reviewerRunner: CodexExecRunner;
  reviewerName?: string;
  /** retry cap measured from the root run (see Phase 2-7 semantics) */
  maxAttempts: number;
  /** run the coder only, then stop at needs_review for a human */
  noAutoReview?: boolean;
  /** stop at the first changes_requested instead of rerunning */
  stopOnChangesRequested?: boolean;
  /**
   * Project-profile run inputs (Phase 5-7). When set, every coder run /
   * rerun in the workflow uses the pre-compiled policy + records the
   * project provenance + injects the project context packs.
   */
  projectRun?: {
    compiledPolicy: { global: GlobalPolicy; repo: RepoPolicy };
    project: NonNullable<RunMeta["project"]>;
    projectContextPacks?: { promptText: string; manifestYaml: string };
  };
}

/**
 * Orchestrate `run → review auto → review process → (rerun)*` as a bounded
 * workflow. Existing pieces do the work; this only sequences them and
 * decides when to stop. The harness remains authoritative — every state
 * transition still happens inside runDomainCoding / processReviewDecision.
 */
/** Spread the project-profile run inputs into a runDomainCoding call. */
function projectRunFields(
  opts: ReviewedRunWorkflowOpts,
): Partial<{
  compiledPolicy: { global: GlobalPolicy; repo: RepoPolicy };
  project: NonNullable<RunMeta["project"]>;
  projectContextPacks: { promptText: string; manifestYaml: string };
}> {
  if (opts.projectRun === undefined) return {};
  return {
    compiledPolicy: opts.projectRun.compiledPolicy,
    project: opts.projectRun.project,
    ...(opts.projectRun.projectContextPacks !== undefined
      ? { projectContextPacks: opts.projectRun.projectContextPacks }
      : {}),
  };
}

export async function runReviewedRunWorkflow(
  opts: ReviewedRunWorkflowOpts,
): Promise<ReviewedRunWorkflowResult> {
  // Validate here too — not only in the CLI — so a direct API caller
  // cannot bypass the bound (e.g. maxAttempts=0 would "not_converge" after
  // a single attempt; NaN would later trip RerunGateError mid-loop).
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new Error(
      `maxAttempts must be a positive integer (got ${String(opts.maxAttempts)})`,
    );
  }
  const attempts: WorkflowAttempt[] = [];
  let rootRunId = "";
  let finalStatus: WorkflowFinalStatus;
  let attempt = 0;
  let prevRunId: string | undefined;
  const untrustedReviewerSync = new Map<string, boolean>();

  for (;;) {
    // --- coder run (attempt 0) or rerun (attempt >= 1) ---
    let runResult: RunDomainCodingResult;
    try {
      if (attempt === 0) {
        runResult = await runDomainCoding({
          harnessRoot: opts.harnessRoot,
          repoPath: opts.repoPath,
          repoId: opts.repoId,
          domain: opts.domain,
          goal: opts.goal,
          baseBranch: opts.baseBranch,
          codexRunner: opts.coderRunner,
          codexBinaryVersion: opts.coderCodexBinaryVersion ?? null,
          ...projectRunFields(opts),
        });
        rootRunId = runResult.runId;
      } else {
        const prep = await prepareRerunFromReview({
          runsDir: opts.runsDir,
          parentRunId: prevRunId as string,
          maxAttempts: opts.maxAttempts,
          dbPath: harnessPaths(opts.harnessRoot).dbPath,
        });
        runResult = await runDomainCoding({
          harnessRoot: opts.harnessRoot,
          repoPath: opts.repoPath,
          repoId: prep.repoId,
          domain: prep.domain,
          goal: prep.goal,
          baseBranch: prep.baseBranch,
          codexRunner: opts.coderRunner,
          codexBinaryVersion: opts.coderCodexBinaryVersion ?? null,
          parentRunId: prep.parentRunId,
          rootRunId: prep.rootRunId,
          rerunAttempt: prep.rerunAttempt,
          ...projectRunFields(opts),
        });
      }
    } catch (e) {
      // runDomainCoding finalized the run as failed-internal-error and
      // rethrew. The run dir exists — record it and stop with artifacts.
      if (e instanceof RunFinalizedError) {
        if (attempt === 0) rootRunId = e.runId;
        attempts.push({
          runId: e.runId,
          attempt,
          status: e.status,
          reviewer: null,
        });
        finalStatus = e.status;
        break;
      }
      throw e;
    }

    // --- run failed? runDomainCoding only returns needs_review or failed-* ---
    if (runResult.status !== "needs_review") {
      attempts.push({
        runId: runResult.runId,
        attempt,
        status: runResult.status,
        reviewer: null,
      });
      finalStatus = runResult.status;
      break;
    }

    // --- --no-auto-review: stop for a human reviewer ---
    if (opts.noAutoReview) {
      attempts.push({
        runId: runResult.runId,
        attempt,
        status: "needs_review",
        reviewer: null,
      });
      finalStatus = "needs_review";
      break;
    }

    // --- review auto ---
    try {
      await runReviewerAgent({
        runsDir: opts.runsDir,
        runId: runResult.runId,
        dbPath: harnessPaths(opts.harnessRoot).dbPath,
        codexRunner: opts.reviewerRunner,
        ...(opts.reviewerName !== undefined
          ? { reviewerName: opts.reviewerName }
          : {}),
      });
    } catch (e) {
      if (e instanceof ReviewerAgentGateError) {
        // review-auto-error.json is left in place by runReviewerAgent.
        untrustedReviewerSync.set(
          runResult.runId,
          e.reviewerEventsPublished,
        );
        attempts.push({
          runId: runResult.runId,
          attempt,
          status: "needs_review",
          reviewer: null,
        });
        finalStatus = "review-auto-failed";
        break;
      }
      throw e;
    }

    // --- review process ---
    const proc = await processReviewDecision({
      runsDir: opts.runsDir,
      runId: runResult.runId,
      locksDir: opts.locksDir,
      dbPath: harnessPaths(opts.harnessRoot).dbPath,
    });
    attempts.push({
      runId: runResult.runId,
      attempt,
      status: proc.newStatus,
      reviewer: proc.reviewer,
    });

    if (proc.newStatus === "approved") {
      finalStatus = "approved";
      break;
    }
    if (proc.newStatus === "rejected") {
      finalStatus = "rejected";
      break;
    }
    // changes_requested from here on
    if (opts.stopOnChangesRequested) {
      finalStatus = "changes_requested";
      break;
    }
    if (attempt >= opts.maxAttempts) {
      finalStatus = "not_converged";
      break;
    }
    prevRunId = runResult.runId;
    attempt += 1;
  }

  const result: ReviewedRunWorkflowResult = {
    rootRunId,
    attempts,
    finalStatus,
    maxAttempts: opts.maxAttempts,
  };
  await writeWorkflowArtifacts(opts.runsDir, opts.domain, result);
  // sync every attempt's run into the DB so each attempt's reviewer logs
  // / review-auto-error.json — and the root run's workflow.json /
  // workflow-summary.md — are DB-canonical too (Phase 8-13).
  const dbPath = harnessPaths(opts.harnessRoot).dbPath;
  for (const id of new Set([rootRunId, ...attempts.map((a) => a.runId)])) {
    const reviewerEventsPublished = untrustedReviewerSync.get(id);
    syncRunArtifactsToDb({
      dbPath,
      runsDir: opts.runsDir,
      runId: id,
      ...(reviewerEventsPublished !== undefined
        ? {
            untrustedReviewerArtifacts: {
              reviewerEventsPublished,
            },
          }
        : {}),
    });
  }
  return result;
}

async function writeWorkflowArtifacts(
  runsDir: string,
  domain: string,
  result: ReviewedRunWorkflowResult,
): Promise<void> {
  const rootDir = join(runsDir, result.rootRunId);
  await writeFile(
    join(rootDir, "workflow.json"),
    JSON.stringify(
      {
        workflow: "reviewed-run",
        rootRunId: result.rootRunId,
        attempts: result.attempts,
        finalStatus: result.finalStatus,
        maxAttempts: result.maxAttempts,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const rows = result.attempts
    .map(
      (a) =>
        `| ${a.attempt} | ${a.runId} | ${a.status} | ${a.reviewer ?? "-"} |`,
    )
    .join("\n");
  const body = [
    "# Workflow: reviewed-run",
    "",
    `- root run: ${result.rootRunId}`,
    `- domain: ${domain}`,
    `- final status: ${result.finalStatus}`,
    `- max attempts: ${result.maxAttempts}`,
    `- attempts run: ${result.attempts.length}`,
    "",
    "## Attempts",
    "",
    "| attempt | runId | status | reviewer |",
    "|--------:|-------|--------|----------|",
    rows,
    "",
  ].join("\n");
  await writeFile(join(rootDir, "workflow-summary.md"), body, "utf8");
}
