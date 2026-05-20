import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEventWriter, type RunEvent } from "./events.js";

export type RunStatus =
  | "running"
  | "generated"
  | "verified"
  | "needs_review"
  | "approved"
  | "changes_requested"
  | "rejected"
  | "failed-policy-violation"
  | "failed-codex"
  | "failed-codex-timeout"
  | "failed-diff-collection"
  | "failed-command"
  | "failed-internal-error";

/**
 * Orthogonal verdict from path-policy validation. Tracked separately from
 * RunStatus so that e.g. (status=failed-codex-timeout, safetyStatus=denied)
 * is queryable from meta.json without re-parsing artifacts.
 */
export type SafetyStatus = "allowed" | "denied" | "skipped";

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
  startedAt: string;
  finishedAt?: string;
}

export interface RunLog {
  runDir: string;
  emit(event: RunEvent): Promise<void>;
  setStatus(status: RunStatus): Promise<void>;
  setSafetyStatus(safetyStatus: SafetyStatus): Promise<void>;
  finalize(p: {
    status: RunStatus;
    safetyStatus: SafetyStatus;
    ignoredUntrackedCount: number;
    secretSuspectCount: number;
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
    async finalize({
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      finishedAt,
    }) {
      await updateMeta({
        status,
        safetyStatus,
        ignoredUntrackedCount,
        secretSuspectCount,
        finishedAt,
      });
    },
  };
}
