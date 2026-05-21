import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEventWriter, type RunEvent } from "./events.js";

/** All RunStatus values as a runtime array (single source of truth). */
export const RUN_STATUSES = [
  "running",
  "generated",
  "verified",
  "needs_review",
  "approved",
  "changes_requested",
  "rejected",
  "cleaned",
  "failed-policy-violation",
  "failed-codex",
  "failed-codex-timeout",
  "failed-diff-collection",
  "failed-command",
  "failed-internal-error",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Orthogonal verdict from path-policy validation. Tracked separately from
 * RunStatus so that e.g. (status=failed-codex-timeout, safetyStatus=denied)
 * is queryable from meta.json without re-parsing artifacts.
 */
export const SAFETY_STATUSES = ["allowed", "denied", "skipped"] as const;

export type SafetyStatus = (typeof SAFETY_STATUSES)[number];

export interface RunMeta {
  runId: string;
  repoId: string;
  repoPath: string;
  domain: string;
  workflow: string;
  baseBranch: string;
  /** SHA snapshot at run start; diffs are always taken against this. */
  baseSha: string;
  runBranch: string;
  status: RunStatus;
  safetyStatus?: SafetyStatus;
  /**
   * Count of untracked files filtered out by policy.ignoreUntracked.
   * Recorded alongside safetyStatus so downstream aggregation can
   * distinguish "allowed (clean)" from "allowed (had ignored output)".
   */
  ignoredUntrackedCount?: number;
  /**
   * Count of untracked files whose content was redacted because filename
   * or content matched a secret heuristic. Path policy may still have
   * allowed the file; this is an orthogonal review-quality signal.
   */
  secretSuspectCount?: number;
  /** Reviewer ハンドル。`harness review process` で review-decision.yaml から転写される。 */
  reviewer?: string | null;
  /** ISO 8601 review timestamp。`harness review process` 実行時に set される。 */
  reviewedAt?: string | null;
  /**
   * Per-command result for `policy.allowedCommands` invocation. Empty / absent
   * when the policy specifies no commands. Any failure here flips status to
   * `failed-command`.
   */
  commandResults?: Array<{
    command: string;
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
  }>;
  /**
   * tracked changes + allowed untracked (denied are tracked under
   * safetyStatus / violations). Surfaced by `harness review list` so
   * operators can size-up runs without parsing artifacts.
   */
  changedFilesCount?: number;
  /**
   * runId of the run this one was spawned from via `harness rerun`. The
   * source run is typically in 'changes_requested' state; recording the
   * link lets reviewers audit retry chains without grep'ing prompts.
   */
  parentRunId?: string;
  /**
   * runId of the first run in the rerun chain (the original `harness run`).
   * Absent on an original run; on a rerun it is parent.rootRunId, or the
   * parent's own runId when the parent is itself an original run.
   */
  rootRunId?: string;
  /**
   * Retry count measured from rootRunId. Absent / 0 on an original run;
   * 1 for the first rerun, 2 for the next, … Used by `--max-attempts`.
   */
  rerunAttempt?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface RunLog {
  runDir: string;
  emit(event: RunEvent): Promise<void>;
  setStatus(status: RunStatus): Promise<void>;
  setSafetyStatus(safetyStatus: SafetyStatus): Promise<void>;
  setReviewerInfo(p: {
    reviewer: string | null;
    reviewedAt: string;
  }): Promise<void>;
  finalize(p: {
    status: RunStatus;
    safetyStatus: SafetyStatus;
    ignoredUntrackedCount: number;
    secretSuspectCount: number;
    commandResults: NonNullable<RunMeta["commandResults"]>;
    changedFilesCount: number;
    finishedAt: string;
  }): Promise<void>;
}

export async function createRunLog(opts: {
  runsDir: string;
  runId: string;
  meta: RunMeta;
}): Promise<RunLog> {
  await mkdir(opts.runsDir, { recursive: true });
  const runDir = join(opts.runsDir, opts.runId);
  await mkdir(runDir, { recursive: false });

  const metaPath = join(runDir, "meta.json");
  await writeFile(metaPath, `${JSON.stringify(opts.meta, null, 2)}\n`, "utf8");
  const emit = makeEventWriter(join(runDir, "events.jsonl"));

  async function updateMeta(patch: Partial<RunMeta>): Promise<void> {
    const current = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
    const next: RunMeta = { ...current, ...patch };
    await writeFile(metaPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return {
    runDir,
    emit,
    async setStatus(status) {
      await updateMeta({ status });
    },
    async setSafetyStatus(safetyStatus) {
      await updateMeta({ safetyStatus });
    },
    async setReviewerInfo({ reviewer, reviewedAt }) {
      await updateMeta({ reviewer, reviewedAt });
    },
    async finalize({
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResults,
      changedFilesCount,
      finishedAt,
    }) {
      await updateMeta({
        status,
        safetyStatus,
        ignoredUntrackedCount,
        secretSuspectCount,
        commandResults,
        changedFilesCount,
        finishedAt,
      });
    },
  };
}
